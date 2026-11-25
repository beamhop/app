// Errors that cross the kernel boundary carry a POSIX-style code, like Node's system errors.

const TEXT: Record<string, string> = {
  ENOENT: 'no such file or directory',
  EEXIST: 'file already exists',
  ENOTDIR: 'not a directory',
  EISDIR: 'illegal operation on a directory',
  ENOTEMPTY: 'directory not empty',
  EINVAL: 'invalid argument',
  EBADF: 'bad file descriptor',
  ELOOP: 'too many symbolic links encountered',
  EPERM: 'operation not permitted',
  EACCES: 'permission denied',
  EROFS: 'read-only file system',
  EXDEV: 'cross-device link not permitted',
  EBUSY: 'resource busy or locked',
  ENOEXEC: 'exec format error',
  ESRCH: 'no such process',
  EPIPE: 'broken pipe',
}
const ERRNO: Record<string, number> = {
  EPERM: -1, ENOENT: -2, ESRCH: -3, ENOEXEC: -8, EBADF: -9, EACCES: -13, EBUSY: -16, EEXIST: -17, EXDEV: -18,
  ENOTDIR: -20, EISDIR: -21, EINVAL: -22, EROFS: -30, EPIPE: -32, ENOTEMPTY: -39, ELOOP: -40,
}

/** A failed kernel call. Shaped like Node's `SystemError` so the Node layer can throw it unchanged. */
export class KernelError extends Error {
  readonly code: string
  readonly errno: number
  readonly syscall: string
  path?: string
  dest?: string
  constructor(code: string, syscall: string, path?: string, dest?: string) {
    const where = (path != null ? ` '${path}'` : '') + (dest != null ? ` -> '${dest}'` : '')
    super(`${code}: ${TEXT[code] ?? code}, ${syscall}${where}`)
    this.name = 'Error' // Node prints system errors as plain `Error`
    this.code = code
    this.errno = ERRNO[code] ?? -1
    this.syscall = syscall
    if (path != null) this.path = path
    if (dest != null) this.dest = dest
  }
}

export function isKernelError(e: unknown, code?: string): e is KernelError {
  return e instanceof KernelError && (code === undefined || e.code === code)
}
