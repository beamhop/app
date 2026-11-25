// A mounted image: a read-only tree whose file contents are views of the decoded image payload.
import type { DecodedImage } from '../image/format.js'
import { KernelError } from './errors.js'
import { type Attr, type FsBackend, type NodeKind, ReadOnlyBackend } from './fs-backend.js'

interface ImageNode {
  kind: NodeKind
  mode: number
  children?: Map<string, number>
  data?: Uint8Array
  target?: string
}

export class ImageFs extends ReadOnlyBackend implements FsBackend {
  readonly rootIno = 0
  readonly fileCount: number
  readonly byteLength: number
  private readonly nodes: ImageNode[] = [{ kind: 'dir', mode: 0o755, children: new Map() }]
  private readonly builtMs: number

  constructor(image: DecodedImage) {
    super()
    const { index, blob } = image
    this.builtMs = typeof index.meta.builtAt === 'string' ? Date.parse(index.meta.builtAt) || 0 : 0
    for (const dir of index.dirs) this.ensureDir(dir)
    const dirCache = new Map<string, Map<string, number>>()
    const parentOf = (path: string): [Map<string, number>, string] => {
      const slash = path.lastIndexOf('/')
      const dirPath = slash === -1 ? '' : path.slice(0, slash)
      let children = dirCache.get(dirPath)
      if (!children) {
        children = this.nodes[this.ensureDir(dirPath)].children!
        dirCache.set(dirPath, children)
      }
      return [children, path.slice(slash + 1)]
    }
    let bytes = 0
    for (const [path, offset, length, mode] of index.files) {
      const [children, name] = parentOf(path)
      children.set(name, this.nodes.push({ kind: 'file', mode: mode & 0o7777, data: blob.subarray(offset, offset + length) }) - 1)
      bytes += length
    }
    for (const [path, target] of index.links) {
      const [children, name] = parentOf(path)
      if (!children.has(name)) children.set(name, this.nodes.push({ kind: 'symlink', mode: 0o777, target }) - 1)
    }
    this.fileCount = index.files.length
    this.byteLength = bytes
  }

  private ensureDir(path: string): number {
    let ino = this.rootIno
    for (const part of path.split('/')) {
      if (!part) continue
      const children = this.nodes[ino].children
      if (!children) throw new KernelError('ENOTDIR', 'mount', path)
      let next = children.get(part)
      if (next === undefined) {
        next = this.nodes.push({ kind: 'dir', mode: 0o755, children: new Map() }) - 1
        children.set(part, next)
      }
      ino = next
    }
    return ino
  }
  private get(ino: number): ImageNode {
    const n = this.nodes[ino]
    if (!n) throw new KernelError('EBADF', 'stat')
    return n
  }

  lookup(dir: number, name: string): number | undefined {
    return this.nodes[dir]?.children?.get(name)
  }
  kindOf(ino: number): NodeKind {
    return this.get(ino).kind
  }
  getattr(ino: number): Attr {
    const n = this.get(ino)
    const size = n.kind === 'file' ? n.data!.byteLength : n.kind === 'symlink' ? n.target!.length : 4096
    const t = this.builtMs
    return { kind: n.kind, mode: n.mode, size, ino, nlink: 1, mtimeMs: t, ctimeMs: t, atimeMs: t, birthtimeMs: t }
  }
  readdir(dir: number): string[] {
    const children = this.get(dir).children
    if (!children) throw new KernelError('ENOTDIR', 'scandir')
    return [...children.keys()]
  }
  readlink(ino: number): string {
    const n = this.get(ino)
    if (n.kind !== 'symlink') throw new KernelError('EINVAL', 'readlink')
    return n.target!
  }
  read(ino: number): Uint8Array {
    const n = this.get(ino)
    if (n.kind === 'dir') throw new KernelError('EISDIR', 'read')
    return n.data!
  }
}
