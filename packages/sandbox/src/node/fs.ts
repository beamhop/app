// node:fs over the kernel VFS. Synchronous APIs are direct calls; callback and promise APIs wrap them.
import { KernelError } from '../kernel/errors.js'
import { type Attr, S_IFDIR, S_IFLNK, S_IFREG } from '../kernel/fs-backend.js'
import { normalize } from '../kernel/path.js'
import type { Handle, Vfs } from '../kernel/vfs.js'
import type { Dyn, ProcessCore } from './types.js'
import { BufferPkg as Buffer } from './vendor.js'

const constants = {
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_NOCTTY: 256, O_TRUNC: 512, O_APPEND: 1024,
  O_DIRECTORY: 65536, O_NOFOLLOW: 131072, O_SYNC: 1052672, O_NONBLOCK: 2048, S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFCHR: 8192,
  S_IFBLK: 24576, S_IFIFO: 4096, S_IFLNK: 40960, S_IFSOCK: 49152, S_IRWXU: 448, S_IRUSR: 256, S_IWUSR: 128, S_IXUSR: 64, S_IRWXG: 56, S_IRGRP: 32,
  S_IWGRP: 16, S_IXGRP: 8, S_IRWXO: 7, S_IROTH: 4, S_IWOTH: 2, S_IXOTH: 1, COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
  UV_FS_COPYFILE_EXCL: 1,
}

type Kind = Attr['kind'] | 'chr'
interface StatSource {
  kind: Kind
  mode: number
  size: number
  ino: number
  nlink: number
  mtimeMs: number
  ctimeMs: number
  atimeMs: number
  birthtimeMs: number
}
interface OpenFlags {
  read: boolean
  write: boolean
  create: boolean
  excl: boolean
  trunc: boolean
  append: boolean
}
interface FdEntry {
  handle: Handle
  path: string
  pos: number
  flags: OpenFlags
}

const TYPE_BITS: Record<Kind, number> = { file: S_IFREG, dir: S_IFDIR, symlink: S_IFLNK, chr: 0o020000 }

class Stats {
  [field: string]: Dyn // dev, mode, size, the four timestamps in three forms: assigned in the constructor as Node does
  constructor(s: StatSource, bigint?: boolean) {
    const n = bigint ? BigInt : (x: number) => x
    this.dev = n(1)
    this.mode = n(TYPE_BITS[s.kind] | s.mode)
    this.nlink = n(s.nlink)
    this.uid = n(1000)
    this.gid = n(1000)
    this.rdev = n(0)
    this.blksize = n(4096)
    this.ino = n(s.ino)
    this.size = n(s.size)
    this.blocks = n(Math.ceil(s.size / 512))
    for (const k of ['atime', 'mtime', 'ctime', 'birthtime'] as const) {
      const ms = s[`${k}Ms`]
      this[k + 'Ms'] = bigint ? BigInt(Math.floor(ms)) : ms
      this[k] = new Date(ms)
      if (bigint) this[k + 'Ns'] = BigInt(Math.floor(ms)) * 1000000n
    }
    Object.defineProperty(this, '_kind', { value: s.kind, enumerable: false })
  }
  isFile(): boolean { return this._kind === 'file' }
  isDirectory(): boolean { return this._kind === 'dir' }
  isSymbolicLink(): boolean { return this._kind === 'symlink' }
  isBlockDevice(): boolean { return false }
  isCharacterDevice(): boolean { return this._kind === 'chr' }
  isFIFO(): boolean { return false }
  isSocket(): boolean { return false }
}

class Dirent {
  readonly path: string
  constructor(
    readonly name: string,
    private readonly _kind: Kind,
    readonly parentPath: string,
  ) {
    this.path = parentPath
    Object.defineProperty(this, '_kind', { enumerable: false })
  }
  isFile(): boolean { return this._kind === 'file' }
  isDirectory(): boolean { return this._kind === 'dir' }
  isSymbolicLink(): boolean { return this._kind === 'symlink' }
  isBlockDevice(): boolean { return false }
  isCharacterDevice(): boolean { return false }
  isFIFO(): boolean { return false }
  isSocket(): boolean { return false }
}

function parseFlags(flags: Dyn): OpenFlags {
  if (typeof flags === 'number') {
    const acc = flags & 3
    return { read: acc !== 1, write: acc !== 0, create: !!(flags & 64), excl: !!(flags & 128), trunc: !!(flags & 512), append: !!(flags & 1024) }
  }
  const f = String(flags || 'r').replace(/[sb]/g, '')
  return { read: f.includes('r') || f.includes('+'), write: f !== 'r', create: /[wa]/.test(f), excl: f.includes('x'), trunc: f.startsWith('w'), append: f.startsWith('a') }
}

interface Deps {
  vfs: Vfs
  core: ProcessCore
  stream: Dyn
  EventEmitter: Dyn
}

/** Returns the `fs` module object for one process (its own cwd and descriptor table). */
export function createFs({ vfs, core, stream, EventEmitter }: Deps): Dyn {
  const { process, track } = core
  const toPath = (p: Dyn): string => {
    if (p instanceof URL) {
      if (p.protocol !== 'file:') throw new TypeError('The URL must be of scheme file')
      p = decodeURIComponent(p.pathname)
    } else if (p instanceof Uint8Array) p = Buffer.from(p).toString()
    if (typeof p !== 'string') {
      throw Object.assign(new TypeError(`The "path" argument must be of type string or an instance of Buffer or URL. Received ${p === null ? 'null' : typeof p}`), { code: 'ERR_INVALID_ARG_TYPE' })
    }
    return p.startsWith('/') ? normalize(p) : normalize(process.cwd() + '/' + p)
  }
  /** Always a fresh copy: the VFS takes ownership of what it is given, and callers may reuse their buffer. */
  const toBytes = (data: Dyn, encoding?: string | null): Uint8Array => {
    if (typeof data === 'string') return new Uint8Array(Buffer.from(data, encoding || 'utf8'))
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0))
    return new Uint8Array(Buffer.from(String(data)))
  }
  const optEnc = (o: Dyn): string | null => (typeof o === 'string' ? o : o && o.encoding) || null
  const statOf = (attr: Attr, o: Dyn): Stats => new Stats(attr, o && o.bigint)
  const noEntryOk = (e: unknown, o: Dyn): boolean => !!o && o.throwIfNoEntry === false && e instanceof KernelError && (e.code === 'ENOENT' || e.code === 'ENOTDIR')

  // ---- file descriptors ----
  const fds = new Map<number, FdEntry>()
  let nextFd = 20
  const fdEntry = (fd: number, syscall: string): FdEntry => {
    const e = fds.get(fd)
    if (!e) throw new KernelError('EBADF', syscall)
    return e
  }
  const fdData = (e: FdEntry): Uint8Array => e.handle.fs.read(e.handle.ino)
  const fdStore = (e: FdEntry, data: Uint8Array): void => {
    e.handle.fs.write(e.handle.ino, data)
    vfs.notify(e.path)
  }

  const fs: Dyn = {
    constants,
    Stats,
    Dirent,
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
    existsSync(p: Dyn) {
      try {
        return vfs.exists(toPath(p))
      } catch {
        return false
      }
    },
    accessSync(p: Dyn, mode?: number) {
      const path = toPath(p)
      const st = vfs.open(path, true, 'access')
      if (mode && mode & 1 && st.fs.kindOf(st.ino) === 'file' && (st.fs.getattr(st.ino).mode & 0o111) === 0) throw new KernelError('EACCES', 'access', path)
    },
    statSync(p: Dyn, o?: Dyn) {
      try {
        return statOf(vfs.stat(toPath(p)), o)
      } catch (e) {
        if (noEntryOk(e, o)) return undefined
        throw e
      }
    },
    lstatSync(p: Dyn, o?: Dyn) {
      try {
        return statOf(vfs.lstat(toPath(p)), o)
      } catch (e) {
        if (noEntryOk(e, o)) return undefined
        throw e
      }
    },
    readFileSync(p: Dyn, o?: Dyn) {
      const data = typeof p === 'number' ? fdData(fdEntry(p, 'read')) : vfs.readFile(toPath(p))
      const enc = optEnc(o)
      // toString decodes without copying; a Buffer result is a copy so callers cannot write into the image.
      return enc ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(enc) : Buffer.from(data)
    },
    writeFileSync(p: Dyn, data: Dyn, o?: Dyn) {
      const enc = optEnc(o)
      const flag = (o && typeof o === 'object' && o.flag) || 'w'
      const mode = (o && typeof o === 'object' && o.mode) || 0o644
      if (typeof p === 'number') return fdStore(fdEntry(p, 'write'), toBytes(data, enc))
      vfs.writeFile(toPath(p), toBytes(data, enc), { flag, mode })
    },
    appendFileSync(p: Dyn, data: Dyn, o?: Dyn) {
      if (typeof p === 'number') return void fs.writeSync(p, toBytes(data, optEnc(o)))
      vfs.writeFile(toPath(p), toBytes(data, optEnc(o)), { flag: 'a', mode: (o && typeof o === 'object' && o.mode) || 0o644 })
    },
    mkdirSync(p: Dyn, o?: Dyn) {
      return vfs.mkdir(toPath(p), typeof o === 'number' ? { mode: o } : o || {})
    },
    readdirSync(p: Dyn, o?: Dyn) {
      const path = toPath(p)
      const withTypes = o && o.withFileTypes
      const recursive = o && o.recursive
      const out: Dyn[] = []
      const visit = (dir: string, rel: string): void => {
        for (const { name, kind } of vfs.readdir(dir)) {
          const relName = rel ? rel + '/' + name : name
          out.push(withTypes ? new Dirent(name, kind, dir) : relName)
          if (recursive && kind === 'dir') visit(dir + '/' + name, relName)
        }
      }
      visit(path, '')
      return out
    },
    rmdirSync(p: Dyn, o?: Dyn) {
      if (o && o.recursive) vfs.rm(toPath(p), { recursive: true, force: true })
      else vfs.rmdir(toPath(p))
    },
    rmSync(p: Dyn, o?: Dyn) {
      vfs.rm(toPath(p), o || {})
    },
    unlinkSync(p: Dyn) {
      vfs.unlink(toPath(p))
    },
    renameSync(a: Dyn, b: Dyn) {
      vfs.rename(toPath(a), toPath(b))
    },
    copyFileSync(a: Dyn, b: Dyn, mode?: number) {
      vfs.writeFile(toPath(b), vfs.readFile(toPath(a)).slice(), { flag: mode && mode & 1 ? 'wx' : 'w', mode: vfs.stat(toPath(a)).mode })
    },
    cpSync(a: Dyn, b: Dyn) {
      vfs.copy(toPath(a), toPath(b))
    },
    symlinkSync(target: Dyn, p: Dyn) {
      vfs.symlink(String(target), toPath(p))
    },
    linkSync(a: Dyn, b: Dyn) {
      vfs.link(toPath(a), toPath(b))
    },
    readlinkSync(p: Dyn) {
      return vfs.readlink(toPath(p))
    },
    realpathSync: Object.assign((p: Dyn) => vfs.realpath(toPath(p)), { native: (p: Dyn) => vfs.realpath(toPath(p)) }),
    chmodSync(p: Dyn, mode: number) {
      vfs.chmod(toPath(p), mode)
    },
    lchmodSync() {},
    chownSync() {},
    lchownSync() {},
    fchownSync() {},
    fchmodSync() {},
    utimesSync(p: Dyn, a: Dyn, m: Dyn) {
      const ms = (t: Dyn): number => +new Date(typeof t === 'number' ? t * 1000 : t)
      vfs.utimes(toPath(p), ms(a), ms(m))
    },
    lutimesSync() {},
    futimesSync() {},
    truncateSync(p: Dyn, len = 0) {
      vfs.truncate(toPath(p), len)
    },
    mkdtempSync(prefix: Dyn) {
      const p = toPath(prefix + Math.random().toString(36).slice(2, 8))
      vfs.mkdir(p, { recursive: true })
      return p
    },
    openSync(p: Dyn, flags?: Dyn, mode?: number) {
      const path = toPath(p)
      const f = parseFlags(flags)
      let handle = vfs.tryOpen(path)
      if (handle && f.excl && f.create) throw new KernelError('EEXIST', 'open', path)
      if (!handle) {
        if (!f.create) throw new KernelError('ENOENT', 'open', path)
        handle = vfs.writeFile(path, new Uint8Array(0), { mode: mode || 0o644 })
      } else if (f.write && handle.fs.readOnly) throw new KernelError('EROFS', 'open', path)
      else if (f.trunc && handle.fs.kindOf(handle.ino) === 'file') handle.fs.write(handle.ino, new Uint8Array(0))
      handle.fs.pin(handle.ino)
      const fd = nextFd++
      fds.set(fd, { handle, path, pos: 0, flags: f })
      return fd
    },
    closeSync(fd: number) {
      const e = fds.get(fd)
      if (!e) return
      fds.delete(fd)
      e.handle.fs.unpin(e.handle.ino)
    },
    fstatSync(fd: number, o?: Dyn) {
      if (fd <= 2) return new Stats({ kind: 'chr', mode: 0o620, size: 0, ino: fd, nlink: 1, mtimeMs: 0, ctimeMs: 0, atimeMs: 0, birthtimeMs: 0 }, o && o.bigint)
      const e = fdEntry(fd, 'fstat')
      return statOf(e.handle.fs.getattr(e.handle.ino), o)
    },
    fsyncSync() {},
    fdatasyncSync() {},
    ftruncateSync(fd: number, len = 0) {
      const e = fdEntry(fd, 'ftruncate')
      const d = new Uint8Array(len)
      d.set(fdData(e).subarray(0, len))
      fdStore(e, d)
    },
    readSync(fd: number, buffer: Dyn, offset?: Dyn, length?: Dyn, position?: Dyn) {
      if (offset && typeof offset === 'object') ({ offset = 0, length, position } = offset)
      offset ??= 0
      length ??= buffer.byteLength - offset
      const target = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, Math.min(length, buffer.byteLength - offset))
      if (fd === 0) return core.readStdinSync(target)
      const e = fdEntry(fd, 'read')
      if (e.handle.fs.kindOf(e.handle.ino) === 'dir') throw new KernelError('EISDIR', 'read')
      const explicit = typeof position === 'number' || typeof position === 'bigint'
      const pos = explicit ? Number(position) : e.pos
      const chunk = fdData(e).subarray(pos, pos + target.byteLength)
      target.set(chunk)
      if (!explicit || pos === -1) e.pos = pos + chunk.length
      return chunk.length
    },
    writeSync(fd: number, data: Dyn, a?: Dyn, b?: Dyn, c?: Dyn) {
      let bytes: Uint8Array
      let position: number | null
      if (typeof data === 'string') {
        bytes = toBytes(data, typeof b === 'string' ? b : 'utf8')
        position = typeof a === 'number' ? a : null
      } else {
        const off = a ?? 0
        const len = b ?? data.byteLength - off
        bytes = new Uint8Array(data.buffer, data.byteOffset + off, len).slice()
        position = typeof c === 'number' ? c : null
      }
      if (fd === 1 || fd === 2) {
        ;(fd === 1 ? process.stdout : process.stderr).write(Buffer.from(bytes))
        return bytes.length
      }
      const e = fdEntry(fd, 'write')
      const old = fdData(e)
      const pos = e.flags.append ? old.length : (position ?? e.pos)
      const end = pos + bytes.length
      const next = new Uint8Array(Math.max(end, old.length))
      next.set(old)
      next.set(bytes, pos)
      fdStore(e, next)
      if (position == null) e.pos = end
      return bytes.length
    },
    writevSync(fd: number, buffers: Dyn[], position?: number | null) {
      let n = 0
      for (const b of buffers) n += fs.writeSync(fd, b, 0, b.byteLength, position == null ? null : position + n)
      return n
    },
    opendirSync(p: Dyn) {
      const path = toPath(p)
      const entries = vfs.readdir(path).map((e) => new Dirent(e.name, e.kind, path))
      let i = 0
      return {
        path,
        readSync: () => entries[i++] || null,
        read: async () => entries[i++] || null,
        closeSync() {},
        close: async () => {},
        async *[Symbol.asyncIterator]() {
          while (i < entries.length) yield entries[i++]
        },
      }
    },
    statfsSync() {
      return { type: 0x1021994, bsize: 4096, blocks: 1 << 20, bfree: 1 << 19, bavail: 1 << 19, files: 1 << 20, ffree: 1 << 19 }
    },
    watch(p: Dyn, o?: Dyn, listener?: Dyn) {
      if (typeof o === 'function') listener = o
      const w = new EventEmitter()
      const path = toPath(p)
      const stop = vfs.watch((changed) => {
        if (changed === path || changed.startsWith(path + '/')) w.emit('change', 'change', changed.slice(path.length + 1) || path.split('/').pop())
      })
      w.close = stop
      w.ref = () => w
      w.unref = () => w
      if (listener) w.on('change', listener)
      track('fs.watch', path)
      return w
    },
    watchFile() {
      track('fs.watchFile')
    },
    unwatchFile() {},
    createReadStream(p: Dyn, o: Dyn = {}) {
      if (typeof o === 'string') o = { encoding: o }
      let data: Uint8Array | undefined
      let pos: number = o.start || 0
      const end: number = o.end != null ? o.end + 1 : Infinity
      const s = new stream.Readable({
        highWaterMark: o.highWaterMark || 65536,
        encoding: o.encoding,
        read(this: Dyn, n: number) {
          try {
            if (!data) {
              data = typeof o.fd === 'number' ? fdData(fdEntry(o.fd, 'read')) : vfs.readFile(toPath(p))
              queueMicrotask(() => {
                s.emit('open', o.fd ?? 99)
                s.emit('ready')
              })
            }
            const stop = Math.min(data.length, end)
            if (pos >= stop) return this.push(null)
            const chunk = Buffer.from(data.subarray(pos, Math.min(pos + (n || 65536), stop)))
            pos += chunk.length
            s.bytesRead += chunk.length
            this.push(chunk)
          } catch (e) {
            this.destroy(e)
          }
        },
      })
      s.path = p
      s.bytesRead = 0
      s.close = (cb?: () => void) => {
        s.destroy()
        cb?.()
      }
      return s
    },
    createWriteStream(p: Dyn, o: Dyn = {}) {
      if (typeof o === 'string') o = { encoding: o }
      const path = typeof o.fd === 'number' ? null : toPath(p)
      let opened = false
      const open = (): void => {
        if (opened || !path) return
        vfs.writeFile(path, new Uint8Array(0), { flag: (o.flags || 'w').startsWith('a') ? 'a' : 'w', mode: o.mode })
        opened = true
        queueMicrotask(() => {
          s.emit('open', 99)
          s.emit('ready')
        })
      }
      const s = new stream.Writable({
        write(chunk: Dyn, enc: string, cb: (e?: unknown) => void) {
          try {
            open()
            if (path) vfs.writeFile(path, toBytes(chunk, enc), { flag: 'a' })
            else fs.writeSync(o.fd, toBytes(chunk, enc))
            s.bytesWritten += chunk.length
            cb()
          } catch (e) {
            cb(e)
          }
        },
        final(cb: (e?: unknown) => void) {
          try {
            open()
            cb()
          } catch (e) {
            cb(e)
          }
        },
      })
      s.path = p
      s.bytesWritten = 0
      s.close = (cb?: () => void) => s.end(cb)
      try {
        open()
      } catch (e) {
        queueMicrotask(() => s.destroy(e))
      }
      return s
    },
  }
  fs.exists = (p: Dyn, cb: (exists: boolean) => void) => queueMicrotask(() => cb(fs.existsSync(p)))

  // ---- callback API derived from the sync API ----
  const names = ['access', 'stat', 'lstat', 'readFile', 'writeFile', 'appendFile', 'mkdir', 'readdir', 'rmdir', 'rm', 'unlink', 'rename', 'copyFile', 'cp', 'symlink',
    'link', 'readlink', 'chmod', 'lchmod', 'chown', 'lchown', 'fchown', 'fchmod', 'utimes', 'lutimes', 'futimes', 'truncate', 'mkdtemp', 'open', 'close', 'fstat',
    'fsync', 'fdatasync', 'ftruncate', 'opendir', 'statfs', 'writev']
  for (const name of names) {
    const sync = fs[name + 'Sync']
    fs[name] = (...args: Dyn[]) => {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : () => {}
      let result: Dyn
      let error: unknown = null
      try {
        result = sync(...args)
      } catch (e) {
        error = e
      }
      process.nextTick(() => (error ? cb(error) : cb(null, result)))
    }
  }
  fs.realpath = Object.assign(
    (p: Dyn, o: Dyn, cb?: Dyn) => {
      cb = typeof o === 'function' ? o : cb
      let r: Dyn
      let e: unknown = null
      try {
        r = fs.realpathSync(p)
      } catch (x) {
        e = x
      }
      process.nextTick(() => cb(e, r))
    },
    { native: (p: Dyn, o: Dyn, cb?: Dyn) => fs.realpath(p, o, cb) },
  )
  fs.read = (fd: number, buffer: Dyn, offset: Dyn, length: Dyn, position: Dyn, cb: Dyn) => {
    if (typeof offset === 'function') {
      cb = offset
      offset = 0
      length = buffer.byteLength
      position = null
    } else if (offset && typeof offset === 'object') {
      cb = length
      ;({ offset = 0, length = buffer.byteLength, position = null } = offset)
    }
    let n: Dyn
    let e: unknown = null
    try {
      n = fs.readSync(fd, buffer, offset, length, position)
    } catch (x) {
      e = x
    }
    process.nextTick(() => cb(e, n, buffer))
  }
  fs.write = (fd: number, data: Dyn, ...rest: Dyn[]) => {
    const cb = rest.pop()
    let n: Dyn
    let e: unknown = null
    try {
      n = fs.writeSync(fd, data, ...rest)
    } catch (x) {
      e = x
    }
    process.nextTick(() => cb(e, n, data))
  }

  // ---- promises API ----
  class FileHandle {
    constructor(readonly fd: number) {}
    async read(buffer?: Dyn, offset?: Dyn, length?: Dyn, position?: Dyn) {
      if (buffer && !ArrayBuffer.isView(buffer)) ({ buffer, offset, length, position } = buffer)
      buffer ??= Buffer.alloc(16384)
      return { bytesRead: fs.readSync(this.fd, buffer, offset ?? 0, length ?? buffer.byteLength, position), buffer }
    }
    async write(data: Dyn, ...rest: Dyn[]) {
      return { bytesWritten: fs.writeSync(this.fd, data, ...rest), buffer: data }
    }
    async readFile(o?: Dyn) {
      return fs.readFileSync(this.fd, o)
    }
    async writeFile(data: Dyn, o?: Dyn) {
      return fs.writeFileSync(this.fd, data, o)
    }
    async appendFile(data: Dyn, o?: Dyn) {
      fs.writeSync(this.fd, typeof data === 'string' ? Buffer.from(data, optEnc(o) || 'utf8') : data)
    }
    async stat(o?: Dyn) {
      return fs.fstatSync(this.fd, o)
    }
    async truncate(len?: number) {
      return fs.ftruncateSync(this.fd, len)
    }
    async sync() {}
    async datasync() {}
    async chmod() {}
    async chown() {}
    async utimes() {}
    async close() {
      fs.closeSync(this.fd)
    }
    createReadStream(o?: Dyn) {
      return fs.createReadStream(null, { ...o, fd: this.fd })
    }
    createWriteStream(o?: Dyn) {
      return fs.createWriteStream(null, { ...o, fd: this.fd })
    }
    readLines(): never {
      throw new Error('FileHandle.readLines is not implemented in the emulation layer')
    }
    async [Symbol.asyncDispose]() {
      fs.closeSync(this.fd)
    }
  }
  const promises: Dyn = { constants }
  for (const name of [...names, 'realpath']) {
    if (name === 'open' || name === 'close') continue
    const sync = fs[name + 'Sync']
    promises[name] = async (...args: Dyn[]) => sync(...args)
  }
  promises.open = async (p: Dyn, flags?: Dyn, mode?: number) => new FileHandle(fs.openSync(p, flags, mode))
  promises.watch = async function* () {
    track('fs.promises.watch')
    await new Promise(() => {})
  }
  fs.promises = promises
  fs.FileHandle = FileHandle
  fs.ReadStream = stream.Readable
  fs.WriteStream = stream.Writable

  /**
   * dup() for child stdio: a child keeps writing to an open file after the parent closes its descriptor
   * (Claude Code's shell tool does exactly that). Returns an appender, or null for an unknown descriptor.
   */
  const dupForChild = (fd: number): ((bytes: Uint8Array) => void) | null => {
    const e = fds.get(fd)
    if (!e) return null
    const { handle, path } = e
    handle.fs.pin(handle.ino)
    return (bytes) => {
      vfs.appendHandle(handle, bytes)
      vfs.notify(path)
    }
  }
  Object.defineProperty(fs, '__dupForChild', { enumerable: false, value: dupForChild })
  return fs
}
