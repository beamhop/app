// The writable layer: an inode tree in memory, with file contents held by a BlockStore.
import { type BlockStore, MemoryBlockStore } from './blockstore.js'
import { KernelError } from './errors.js'
import type { Attr, FsBackend, NodeKind } from './fs-backend.js'

interface Inode {
  kind: NodeKind
  mode: number
  nlink: number
  pins: number
  size: number
  mtimeMs: number
  ctimeMs: number
  atimeMs: number
  birthtimeMs: number
  children?: Map<string, number>
  target?: string
}

const EMPTY = new Uint8Array(0)

export class MemFs implements FsBackend {
  readonly readOnly = false
  readonly rootIno = 1
  private readonly inodes = new Map<number, Inode>()
  private nextIno = 2

  constructor(private readonly store: BlockStore = new MemoryBlockStore()) {
    this.inodes.set(this.rootIno, this.newInode('dir', 0o755))
  }

  private newInode(kind: NodeKind, mode: number): Inode {
    const now = Date.now()
    const n: Inode = { kind, mode, nlink: 1, pins: 0, size: 0, mtimeMs: now, ctimeMs: now, atimeMs: now, birthtimeMs: now }
    if (kind === 'dir') n.children = new Map()
    return n
  }
  private get(ino: number): Inode {
    const n = this.inodes.get(ino)
    if (!n) throw new KernelError('EBADF', 'stat')
    return n
  }
  private dir(ino: number, syscall: string): Map<string, number> {
    const n = this.get(ino)
    if (!n.children) throw new KernelError('ENOTDIR', syscall)
    return n.children
  }
  private release(ino: number, n: Inode): void {
    if (n.nlink > 0 || n.pins > 0) return
    this.inodes.delete(ino)
    this.store.delete(String(ino))
  }

  lookup(dir: number, name: string): number | undefined {
    return this.get(dir).children?.get(name)
  }
  kindOf(ino: number): NodeKind {
    return this.get(ino).kind
  }
  getattr(ino: number): Attr {
    const n = this.get(ino)
    const size = n.kind === 'file' ? n.size : n.kind === 'symlink' ? (n.target ?? '').length : 4096
    return { kind: n.kind, mode: n.mode, size, ino, nlink: n.nlink, mtimeMs: n.mtimeMs, ctimeMs: n.ctimeMs, atimeMs: n.atimeMs, birthtimeMs: n.birthtimeMs }
  }
  readdir(dir: number): string[] {
    return [...this.dir(dir, 'scandir').keys()]
  }
  readlink(ino: number): string {
    const n = this.get(ino)
    if (n.kind !== 'symlink') throw new KernelError('EINVAL', 'readlink')
    return n.target ?? ''
  }
  read(ino: number): Uint8Array {
    const n = this.get(ino)
    if (n.kind === 'dir') throw new KernelError('EISDIR', 'read')
    return this.store.get(String(ino)) ?? EMPTY
  }
  create(dir: number, name: string, kind: NodeKind, mode: number, symlinkTarget?: string): number {
    const children = this.dir(dir, 'open')
    if (children.has(name)) throw new KernelError('EEXIST', 'open')
    const ino = this.nextIno++
    const n = this.newInode(kind, mode)
    if (kind === 'symlink') n.target = symlinkTarget ?? ''
    this.inodes.set(ino, n)
    children.set(name, ino)
    this.get(dir).mtimeMs = Date.now()
    return ino
  }
  write(ino: number, data: Uint8Array): void {
    const n = this.get(ino)
    if (n.kind !== 'file') throw new KernelError('EISDIR', 'write')
    this.store.put(String(ino), data)
    n.size = data.byteLength
    n.mtimeMs = n.ctimeMs = Date.now()
  }
  link(dir: number, name: string, ino: number): void {
    const children = this.dir(dir, 'link')
    if (children.has(name)) throw new KernelError('EEXIST', 'link')
    const n = this.get(ino)
    if (n.kind === 'dir') throw new KernelError('EPERM', 'link')
    children.set(name, ino)
    n.nlink++
  }
  unlink(dir: number, name: string): void {
    const children = this.dir(dir, 'unlink')
    const ino = children.get(name)
    if (ino === undefined) throw new KernelError('ENOENT', 'unlink')
    const n = this.get(ino)
    if (n.children && n.children.size > 0) throw new KernelError('ENOTEMPTY', 'rmdir')
    children.delete(name)
    this.get(dir).mtimeMs = Date.now()
    n.nlink--
    this.release(ino, n)
  }
  rename(fromDir: number, fromName: string, toDir: number, toName: string): void {
    const from = this.dir(fromDir, 'rename')
    const to = this.dir(toDir, 'rename')
    const ino = from.get(fromName)
    if (ino === undefined) throw new KernelError('ENOENT', 'rename')
    const existing = to.get(toName)
    if (existing !== undefined && existing !== ino) {
      const e = this.get(existing)
      if (e.children && e.children.size > 0) throw new KernelError('ENOTEMPTY', 'rename')
      e.nlink--
      this.release(existing, e)
    }
    from.delete(fromName)
    to.set(toName, ino)
    const now = Date.now()
    this.get(fromDir).mtimeMs = now
    this.get(toDir).mtimeMs = now
  }
  setattr(ino: number, attr: { mode?: number; mtimeMs?: number; atimeMs?: number }): void {
    const n = this.get(ino)
    if (attr.mode !== undefined) n.mode = attr.mode & 0o7777
    if (attr.mtimeMs !== undefined) n.mtimeMs = attr.mtimeMs
    if (attr.atimeMs !== undefined) n.atimeMs = attr.atimeMs
    n.ctimeMs = Date.now()
  }
  pin(ino: number): void {
    this.get(ino).pins++
  }
  unpin(ino: number): void {
    const n = this.inodes.get(ino)
    if (!n) return
    n.pins = Math.max(0, n.pins - 1)
    this.release(ino, n)
  }
}
