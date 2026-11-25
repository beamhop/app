// The contract between the VFS (path walking, mounts, symlinks) and a file system implementation.
// Backends know nothing about paths: they deal in inode numbers that are only meaningful inside one backend.
// Whole-file reads and writes keep the contract small enough for an image, a memory tree and (later) SQLite.
import { KernelError } from './errors.js'

export type NodeKind = 'file' | 'dir' | 'symlink'

export const S_IFREG = 0o100000
export const S_IFDIR = 0o040000
export const S_IFLNK = 0o120000

export interface Attr {
  kind: NodeKind
  /** Permission bits only (no file type bits). */
  mode: number
  size: number
  ino: number
  nlink: number
  mtimeMs: number
  ctimeMs: number
  atimeMs: number
  birthtimeMs: number
}

export interface FsBackend {
  readonly readOnly: boolean
  readonly rootIno: number
  lookup(dir: number, name: string): number | undefined
  getattr(ino: number): Attr
  /** Cheaper than getattr when only the type is needed (path walking). */
  kindOf(ino: number): NodeKind
  readdir(dir: number): string[]
  readlink(ino: number): string
  /** The whole file. Callers must treat the result as immutable (image files are views of the image buffer). */
  read(ino: number): Uint8Array
  create(dir: number, name: string, kind: NodeKind, mode: number, symlinkTarget?: string): number
  /** Replace the whole file. The backend takes ownership of `data`. */
  write(ino: number, data: Uint8Array): void
  link(dir: number, name: string, ino: number): void
  /** Remove a file, a symlink or an empty directory. */
  unlink(dir: number, name: string): void
  rename(fromDir: number, fromName: string, toDir: number, toName: string): void
  setattr(ino: number, attr: { mode?: number; mtimeMs?: number; atimeMs?: number }): void
  /** An open descriptor keeps an unlinked file's content alive between pin and unpin. */
  pin(ino: number): void
  unpin(ino: number): void
}

/** Base for read-only backends: every mutation fails with EROFS. */
export abstract class ReadOnlyBackend {
  readonly readOnly = true
  create(): number {
    throw new KernelError('EROFS', 'open')
  }
  write(): void {
    throw new KernelError('EROFS', 'write')
  }
  link(): void {
    throw new KernelError('EROFS', 'link')
  }
  unlink(): void {
    throw new KernelError('EROFS', 'unlink')
  }
  rename(): void {
    throw new KernelError('EROFS', 'rename')
  }
  setattr(): void {
    throw new KernelError('EROFS', 'chmod')
  }
  pin(): void {}
  unpin(): void {}
}
