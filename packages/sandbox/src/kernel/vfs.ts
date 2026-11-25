// The virtual file system: one namespace over several backends. It owns everything that involves a path
// (normalisation, symlinks, mount points, recursive operations); backends own the data.
// Every call is synchronous, which is what lets the Node layer implement readFileSync and require directly.
import { KernelError } from './errors.js'
import type { Attr, FsBackend, NodeKind } from './fs-backend.js'
import { MemFs } from './memfs.js'
import { dirname, normalize } from './path.js'

/** An open reference to a file system object, independent of its path. */
export interface Handle {
  fs: FsBackend
  ino: number
}

interface Walk {
  /** null when the last component does not exist (its parent does). */
  node: Handle | null
  parent: Handle | null
  name: string
  /** Canonical absolute path (symlinks resolved) of the node, or of where it would be. */
  path: string
}

export interface DirEntry {
  name: string
  kind: NodeKind
}

const MAX_SYMLINK_DEPTH = 40

export class Vfs {
  readonly rootFs: FsBackend
  private readonly mounts = new Map<string, FsBackend>()
  private readonly watchers = new Set<(path: string) => void>()

  constructor(rootFs: FsBackend = new MemFs()) {
    this.rootFs = rootFs
  }

  // ---------------------------------------------------------------- mounts

  /** Attach a backend at `at`. The directory is created if needed; whatever it held is hidden while mounted. */
  mount(at: string, fs: FsBackend): void {
    const path = normalize(at)
    if (path === '/') throw new KernelError('EBUSY', 'mount', path)
    if (this.mounts.has(path)) throw new KernelError('EBUSY', 'mount', path)
    this.mkdir(path, { recursive: true })
    this.mounts.set(this.realpath(path), fs)
  }
  unmount(at: string): void {
    if (!this.mounts.delete(normalize(at))) throw new KernelError('EINVAL', 'umount', at)
  }
  mountPoints(): string[] {
    return [...this.mounts.keys()]
  }

  // ---------------------------------------------------------------- path walking

  private walk(path: string, followLast: boolean, syscall: string, depth = 0, original = path): Walk {
    if (depth > MAX_SYMLINK_DEPTH) throw new KernelError('ELOOP', syscall, original)
    const parts = normalize(path).split('/')
    let node: Handle = { fs: this.rootFs, ino: this.rootFs.rootIno }
    let parent: Handle | null = null
    let name = ''
    let cur = ''
    const hasMounts = this.mounts.size > 0
    for (let i = 1; i < parts.length; i++) {
      name = parts[i]
      if (name === '') continue
      if (node.fs.kindOf(node.ino) !== 'dir') throw new KernelError('ENOTDIR', syscall, original)
      parent = node
      const last = i === parts.length - 1
      const childPath = cur + '/' + name
      const mounted = hasMounts ? this.mounts.get(childPath) : undefined
      if (mounted) {
        node = { fs: mounted, ino: mounted.rootIno }
        cur = childPath
        continue
      }
      const child = node.fs.lookup(node.ino, name)
      if (child === undefined) {
        if (last) return { node: null, parent, name, path: childPath }
        throw new KernelError('ENOENT', syscall, original)
      }
      if ((!last || followLast) && node.fs.kindOf(child) === 'symlink') {
        const target = node.fs.readlink(child)
        const rest = parts.slice(i + 1).join('/')
        const next = (target.startsWith('/') ? target : cur + '/' + target) + (rest ? '/' + rest : '')
        return this.walk(next, followLast, syscall, depth + 1, original)
      }
      node = { fs: node.fs, ino: child }
      cur = childPath
    }
    return { node, parent, name, path: cur || '/' }
  }

  private must(path: string, follow: boolean, syscall: string): Handle {
    const w = this.walk(path, follow, syscall)
    if (!w.node) throw new KernelError('ENOENT', syscall, path)
    return w.node
  }

  /** Look a path up without throwing for a missing entry or a broken path. */
  tryOpen(path: string, follow = true): Handle | null {
    try {
      return this.walk(path, follow, 'stat').node
    } catch (e) {
      if (e instanceof KernelError) return null
      throw e
    }
  }
  open(path: string, follow = true, syscall = 'open'): Handle {
    return this.must(path, follow, syscall)
  }
  kindOf(path: string, follow = true): NodeKind | null {
    const h = this.tryOpen(path, follow)
    return h ? h.fs.kindOf(h.ino) : null
  }
  exists(path: string): boolean {
    return this.tryOpen(path) !== null
  }

  // ---------------------------------------------------------------- reads

  stat(path: string): Attr {
    const h = this.must(path, true, 'stat')
    return h.fs.getattr(h.ino)
  }
  lstat(path: string): Attr {
    const h = this.must(path, false, 'lstat')
    return h.fs.getattr(h.ino)
  }
  tryStat(path: string, follow = true): Attr | null {
    const h = this.tryOpen(path, follow)
    return h ? h.fs.getattr(h.ino) : null
  }
  realpath(path: string): string {
    const w = this.walk(path, true, 'realpath')
    if (!w.node) throw new KernelError('ENOENT', 'realpath', path)
    return w.path
  }
  /** The file's bytes. Treat as immutable: image files are views of the image buffer. */
  readFile(path: string): Uint8Array {
    const h = this.must(path, true, 'open')
    if (h.fs.kindOf(h.ino) === 'dir') throw new KernelError('EISDIR', 'read', path)
    return h.fs.read(h.ino)
  }
  readText(path: string): string {
    return new TextDecoder().decode(this.readFile(path))
  }
  readdir(path: string): DirEntry[] {
    const h = this.must(path, true, 'scandir')
    if (h.fs.kindOf(h.ino) !== 'dir') throw new KernelError('ENOTDIR', 'scandir', path)
    const base = this.mounts.size > 0 ? this.realpath(path) : ''
    return h.fs.readdir(h.ino).map((name) => {
      const mounted = this.mounts.size > 0 && this.mounts.has((base === '/' ? '' : base) + '/' + name)
      const child = h.fs.lookup(h.ino, name)
      return { name, kind: mounted || child === undefined ? 'dir' : h.fs.kindOf(child) }
    })
  }
  readlink(path: string): string {
    const h = this.must(path, false, 'readlink')
    if (h.fs.kindOf(h.ino) !== 'symlink') throw new KernelError('EINVAL', 'readlink', path)
    return h.fs.readlink(h.ino)
  }

  // ---------------------------------------------------------------- writes

  private writable(h: Handle, syscall: string, path: string): void {
    if (h.fs.readOnly) throw new KernelError('EROFS', syscall, path)
  }

  mkdir(path: string, opts: { recursive?: boolean; mode?: number } = {}): string | undefined {
    const mode = opts.mode ?? 0o755
    if (opts.recursive) {
      let first: string | undefined
      let cur = ''
      for (const part of normalize(path).split('/')) {
        if (!part) continue
        cur += '/' + part
        const w = this.walk(cur, true, 'mkdir')
        if (w.node) {
          if (w.node.fs.kindOf(w.node.ino) !== 'dir') throw new KernelError('EEXIST', 'mkdir', path)
          continue
        }
        this.writable(w.parent!, 'mkdir', path)
        w.parent!.fs.create(w.parent!.ino, w.name, 'dir', mode)
        first ??= cur
      }
      return first
    }
    const w = this.walk(path, true, 'mkdir')
    if (w.node) throw new KernelError('EEXIST', 'mkdir', path)
    this.writable(w.parent!, 'mkdir', path)
    w.parent!.fs.create(w.parent!.ino, w.name, 'dir', mode)
    return undefined
  }

  /** Create or replace a file. Flags follow Node: 'w' (default), 'a' append, 'x' fail if it exists. Takes ownership of `data`. */
  writeFile(path: string, data: Uint8Array, opts: { mode?: number; flag?: string } = {}): Handle {
    const flag = opts.flag ?? 'w'
    const w = this.walk(path, true, 'open')
    let node = w.node
    if (node && node.fs.kindOf(node.ino) === 'dir') throw new KernelError('EISDIR', 'open', path)
    if (node && flag.includes('x')) throw new KernelError('EEXIST', 'open', path)
    if (!node) {
      if (!w.parent) throw new KernelError('ENOENT', 'open', path)
      this.writable(w.parent, 'open', path)
      node = { fs: w.parent.fs, ino: w.parent.fs.create(w.parent.ino, w.name, 'file', (opts.mode ?? 0o644) & 0o7777) }
    } else this.writable(node, 'open', path)
    if (flag.startsWith('a')) this.appendHandle(node, data)
    else node.fs.write(node.ino, data)
    this.notify(w.path)
    return node
  }
  appendHandle(h: Handle, data: Uint8Array): void {
    const old = h.fs.read(h.ino)
    const merged = new Uint8Array(old.byteLength + data.byteLength)
    merged.set(old, 0)
    merged.set(data, old.byteLength)
    h.fs.write(h.ino, merged)
  }
  truncate(path: string, length = 0): void {
    const h = this.must(path, true, 'truncate')
    this.writable(h, 'truncate', path)
    const data = new Uint8Array(length)
    data.set(h.fs.read(h.ino).subarray(0, length))
    h.fs.write(h.ino, data)
    this.notify(path)
  }
  unlink(path: string): void {
    const w = this.walk(path, false, 'unlink')
    if (!w.node || !w.parent) throw new KernelError('ENOENT', 'unlink', path)
    if (w.node.fs.kindOf(w.node.ino) === 'dir') throw new KernelError('EISDIR', 'unlink', path)
    this.writable(w.parent, 'unlink', path)
    w.parent.fs.unlink(w.parent.ino, w.name)
    this.notify(w.path)
  }
  rmdir(path: string): void {
    const w = this.walk(path, false, 'rmdir')
    if (!w.node) throw new KernelError('ENOENT', 'rmdir', path)
    if (w.node.fs.kindOf(w.node.ino) !== 'dir') throw new KernelError('ENOTDIR', 'rmdir', path)
    if (!w.parent || this.mounts.has(w.path)) throw new KernelError('EBUSY', 'rmdir', path)
    if (w.node.fs.readdir(w.node.ino).length > 0) throw new KernelError('ENOTEMPTY', 'rmdir', path)
    this.writable(w.parent, 'rmdir', path)
    w.parent.fs.unlink(w.parent.ino, w.name)
    this.notify(w.path)
  }
  rm(path: string, opts: { recursive?: boolean; force?: boolean } = {}): void {
    let w: Walk
    try {
      w = this.walk(path, false, 'rm')
    } catch (e) {
      if (opts.force && e instanceof KernelError) return
      throw e
    }
    if (!w.node) {
      if (opts.force) return
      throw new KernelError('ENOENT', 'rm', path)
    }
    if (w.node.fs.kindOf(w.node.ino) !== 'dir') return this.unlink(w.path)
    if (!opts.recursive) throw new KernelError('EISDIR', 'rm', path)
    if (!w.parent) throw new KernelError('EPERM', 'rm', path)
    for (const entry of this.readdir(w.path)) this.rm(w.path + '/' + entry.name, { recursive: true })
    this.rmdir(w.path)
  }
  rename(from: string, to: string): void {
    const a = this.walk(from, false, 'rename')
    if (!a.node || !a.parent) throw new KernelError('ENOENT', 'rename', from, to)
    const b = this.walk(to, false, 'rename')
    if (!b.parent) throw new KernelError('ENOENT', 'rename', from, to)
    if (a.parent.fs !== b.parent.fs) throw new KernelError('EXDEV', 'rename', from, to)
    if (this.mounts.has(a.path) || this.mounts.has(b.path)) throw new KernelError('EBUSY', 'rename', from, to)
    this.writable(a.parent, 'rename', from)
    a.parent.fs.rename(a.parent.ino, a.name, b.parent.ino, b.name)
    this.notify(a.path)
    this.notify(b.path)
  }
  symlink(target: string, path: string): void {
    const w = this.walk(path, false, 'symlink')
    if (w.node) throw new KernelError('EEXIST', 'symlink', target, path)
    this.writable(w.parent!, 'symlink', path)
    w.parent!.fs.create(w.parent!.ino, w.name, 'symlink', 0o777, target)
  }
  link(existing: string, path: string): void {
    const src = this.must(existing, true, 'link')
    const w = this.walk(path, false, 'link')
    if (w.node) throw new KernelError('EEXIST', 'link', existing, path)
    if (w.parent!.fs !== src.fs) throw new KernelError('EXDEV', 'link', existing, path)
    this.writable(w.parent!, 'link', path)
    w.parent!.fs.link(w.parent!.ino, w.name, src.ino)
  }
  chmod(path: string, mode: number): void {
    const h = this.must(path, true, 'chmod')
    this.writable(h, 'chmod', path)
    h.fs.setattr(h.ino, { mode })
  }
  utimes(path: string, atimeMs: number, mtimeMs: number): void {
    const h = this.must(path, true, 'utime')
    this.writable(h, 'utime', path)
    h.fs.setattr(h.ino, { atimeMs, mtimeMs })
  }
  /** Copy a file or a tree. */
  copy(from: string, to: string): void {
    const h = this.must(from, true, 'cp')
    if (h.fs.kindOf(h.ino) === 'dir') {
      this.mkdir(to, { recursive: true })
      for (const e of this.readdir(from)) this.copy(from + '/' + e.name, to + '/' + e.name)
    } else this.writeFile(to, h.fs.read(h.ino).slice(), { mode: h.fs.getattr(h.ino).mode })
  }
  /** mkdir -p the parent, then write. Convenience for hosts placing files. */
  writeFileDeep(path: string, data: Uint8Array, opts: { mode?: number } = {}): void {
    this.mkdir(dirname(normalize(path)), { recursive: true })
    this.writeFile(path, data, opts)
  }

  // ---------------------------------------------------------------- change notification

  watch(listener: (path: string) => void): () => void {
    this.watchers.add(listener)
    return () => this.watchers.delete(listener)
  }
  /** Called by anything that changes file contents through a Handle rather than a path. */
  notify(path: string): void {
    for (const w of this.watchers) {
      try {
        w(path)
      } catch {
        // a watcher must not break the write that triggered it
      }
    }
  }
}
