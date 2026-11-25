// node:fs over the in-memory VFS. Sync APIs are direct calls; callback and promise APIs wrap them.
import { Buffer } from 'buffer';
import { FsError, normalize } from './vfs.js';

const constants = {
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_NOCTTY: 256, O_TRUNC: 512, O_APPEND: 1024,
  O_DIRECTORY: 65536, O_NOFOLLOW: 131072, O_SYNC: 1052672, O_NONBLOCK: 2048, S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFCHR: 8192, S_IFBLK: 24576, S_IFIFO: 4096,
  S_IFLNK: 40960, S_IFSOCK: 49152, S_IRWXU: 448, S_IRUSR: 256, S_IWUSR: 128, S_IXUSR: 64, S_IRWXG: 56, S_IRGRP: 32, S_IWGRP: 16, S_IXGRP: 8, S_IRWXO: 7, S_IROTH: 4, S_IWOTH: 2, S_IXOTH: 1,
  COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4, UV_FS_COPYFILE_EXCL: 1,
};

export function createFs({ vfs, process, stream, EventEmitter, track }) {
  const toPath = (p) => {
    if (p instanceof URL) { if (p.protocol !== 'file:') throw new TypeError('The URL must be of scheme file'); p = decodeURIComponent(p.pathname); }
    else if (p instanceof Uint8Array) p = Buffer.from(p).toString();
    if (typeof p !== 'string') { const e = new TypeError(`The "path" argument must be of type string or an instance of Buffer or URL. Received ${p === null ? 'null' : typeof p}`); e.code = 'ERR_INVALID_ARG_TYPE'; throw e; }
    return p.startsWith('/') ? normalize(p) : normalize(process.cwd() + '/' + p);
  };
  const toBytes = (data, encoding) => {
    if (typeof data === 'string') return new Uint8Array(Buffer.from(data, encoding || 'utf8'));
    if (data instanceof Uint8Array) return new Uint8Array(data); // copy: callers may reuse their buffer
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    return new Uint8Array(Buffer.from(String(data)));
  };
  const optEnc = (o) => (typeof o === 'string' ? o : o && o.encoding) || null;

  class Stats {
    constructor(s, bigint) {
      const n = bigint ? BigInt : (x) => x;
      this.dev = n(1); this.mode = n(s.mode); this.nlink = n(s.nlink); this.uid = n(0); this.gid = n(0); this.rdev = n(0); this.blksize = n(4096); this.ino = n(s.ino);
      this.size = n(s.size); this.blocks = n(Math.ceil(s.size / 512));
      for (const k of ['atime', 'mtime', 'ctime', 'birthtime']) { this[k + 'Ms'] = bigint ? BigInt(Math.floor(s[k + 'Ms'])) : s[k + 'Ms']; this[k] = new Date(s[k + 'Ms']); if (bigint) this[k + 'Ns'] = BigInt(Math.floor(s[k + 'Ms'])) * 1000000n; }
      Object.defineProperty(this, '_kind', { value: s.kind, enumerable: false });
    }
    isFile() { return this._kind === 'file'; }
    isDirectory() { return this._kind === 'dir'; }
    isSymbolicLink() { return this._kind === 'link'; }
    isBlockDevice() { return false; } isCharacterDevice() { return false; } isFIFO() { return false; } isSocket() { return false; }
  }
  class Dirent {
    constructor(name, kind, parentPath) { this.name = name; this.parentPath = parentPath; this.path = parentPath; Object.defineProperty(this, '_kind', { value: kind, enumerable: false }); }
    isFile() { return this._kind === 'file'; }
    isDirectory() { return this._kind === 'dir'; }
    isSymbolicLink() { return this._kind === 'link'; }
    isBlockDevice() { return false; } isCharacterDevice() { return false; } isFIFO() { return false; } isSocket() { return false; }
  }

  // ---- file descriptors ----
  const fds = new Map();
  let nextFd = 20;
  const parseFlags = (flags) => {
    if (typeof flags === 'number') {
      const acc = flags & 3;
      return { read: acc !== 1, write: acc !== 0, create: !!(flags & 64), excl: !!(flags & 128), trunc: !!(flags & 512), append: !!(flags & 1024) };
    }
    const f = String(flags || 'r').replace(/[sb]/g, '');
    return { read: f.includes('r') || f.includes('+'), write: f !== 'r', create: /[wa]/.test(f), excl: f.includes('x'), trunc: f.startsWith('w'), append: f.startsWith('a') };
  };
  const fdEntry = (fd, syscall) => { const e = fds.get(fd); if (!e) throw new FsError('EBADF', syscall); return e; };

  const fs = {
    constants,
    Stats, Dirent,
    F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
    existsSync(p) { try { return !!vfs.tryLookup(toPath(p)); } catch { return false; } },
    accessSync(p, mode) { vfs.lookup(toPath(p), true, 'access'); },
    statSync(p, o) { try { return new Stats(vfs.statOf(vfs.lookup(toPath(p), true, 'stat')), o && o.bigint); } catch (e) { if (o && o.throwIfNoEntry === false && e.code === 'ENOENT') return undefined; throw e; } },
    lstatSync(p, o) { try { return new Stats(vfs.statOf(vfs.lookup(toPath(p), false, 'lstat')), o && o.bigint); } catch (e) { if (o && o.throwIfNoEntry === false && e.code === 'ENOENT') return undefined; throw e; } },
    readFileSync(p, o) {
      const data = typeof p === 'number' ? fdEntry(p, 'read').node.data : vfs.readFile(toPath(p));
      const enc = optEnc(o);
      const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      return enc ? buf.toString(enc) : Buffer.from(buf); // copy so callers cannot mutate the image
    },
    writeFileSync(p, data, o) {
      const enc = optEnc(o), flag = (o && typeof o === 'object' && o.flag) || 'w', mode = (o && typeof o === 'object' && o.mode) || 0o644;
      if (typeof p === 'number') { const e = fdEntry(p, 'write'); e.node.data = toBytes(data, enc); return; }
      vfs.writeFile(toPath(p), toBytes(data, enc), { flag, mode });
    },
    appendFileSync(p, data, o) { vfs.writeFile(toPath(p), toBytes(data, optEnc(o)), { flag: 'a' }); },
    mkdirSync(p, o) { const opts = typeof o === 'number' ? { mode: o } : o || {}; return vfs.mkdir(toPath(p), opts); },
    readdirSync(p, o) {
      const path = toPath(p), withTypes = o && o.withFileTypes, recursive = o && o.recursive;
      const out = [];
      const visit = (dir, rel) => {
        for (const [name, node] of vfs.readdir(dir)) {
          const relName = rel ? rel + '/' + name : name;
          out.push(withTypes ? new Dirent(name, node.kind, dir) : relName);
          if (recursive && node.kind === 'dir') visit(dir + '/' + name, relName);
        }
      };
      visit(path, '');
      return out;
    },
    rmdirSync(p, o) { if (o && o.recursive) vfs.rm(toPath(p), { recursive: true, force: true }); else vfs.rmdir(toPath(p)); },
    rmSync(p, o) { vfs.rm(toPath(p), o || {}); },
    unlinkSync(p) { vfs.unlink(toPath(p)); },
    renameSync(a, b) { vfs.rename(toPath(a), toPath(b)); },
    copyFileSync(a, b, mode) { vfs.writeFile(toPath(b), new Uint8Array(vfs.readFile(toPath(a))), { flag: mode & 1 ? 'wx' : 'w' }); },
    cpSync(a, b, o) {
      const src = toPath(a), dst = toPath(b), node = vfs.lookup(src);
      if (node.kind === 'dir') { vfs.mkdir(dst, { recursive: true }); for (const [name] of vfs.readdir(src)) fs.cpSync(src + '/' + name, dst + '/' + name, o); }
      else vfs.writeFile(dst, new Uint8Array(node.data));
    },
    symlinkSync(target, p) { vfs.symlink(String(target), toPath(p)); },
    linkSync(a, b) { vfs.link(toPath(a), toPath(b)); },
    readlinkSync(p) { const n = vfs.lookup(toPath(p), false, 'readlink'); if (n.kind !== 'link') throw new FsError('EINVAL', 'readlink', p); return n.target; },
    realpathSync: Object.assign((p) => vfs.realpath(toPath(p)), { native: (p) => vfs.realpath(toPath(p)) }),
    chmodSync(p, mode) { vfs.lookup(toPath(p)).mode = mode & 0o7777; },
    lchmodSync() {}, chownSync() {}, lchownSync() {}, fchownSync() {}, fchmodSync() {},
    utimesSync(p, a, m) { const n = vfs.lookup(toPath(p)); n.atime = +new Date(typeof a === 'number' ? a * 1000 : a); n.mtime = +new Date(typeof m === 'number' ? m * 1000 : m); },
    lutimesSync() {}, futimesSync() {},
    truncateSync(p, len = 0) { const n = vfs.lookup(toPath(p)); const d = new Uint8Array(len); d.set(n.data.subarray(0, len)); n.data = d; },
    mkdtempSync(prefix) { const p = toPath(prefix + Math.random().toString(36).slice(2, 8)); vfs.mkdir(p, { recursive: true }); return p; },
    openSync(p, flags, mode) {
      const path = toPath(p), f = parseFlags(flags);
      let node = vfs.tryLookup(path);
      if (node && f.excl && f.create) throw new FsError('EEXIST', 'open', path);
      if (!node) { if (!f.create) throw new FsError('ENOENT', 'open', path); node = vfs.writeFile(path, new Uint8Array(0), { mode: mode || 0o644 }); }
      else if (f.trunc && node.kind === 'file') node.data = new Uint8Array(0);
      const fd = nextFd++;
      fds.set(fd, { node, path, pos: 0, flags: f });
      return fd;
    },
    closeSync(fd) { fds.delete(fd); },
    fstatSync(fd, o) { if (fd <= 2) return new Stats({ kind: 'chr', mode: 0o20620, size: 0, ino: fd, nlink: 1, mtimeMs: 0, ctimeMs: 0, atimeMs: 0, birthtimeMs: 0 }, o && o.bigint); return new Stats(vfs.statOf(fdEntry(fd, 'fstat').node), o && o.bigint); },
    fsyncSync() {}, fdatasyncSync() {},
    ftruncateSync(fd, len = 0) { const e = fdEntry(fd, 'ftruncate'); const d = new Uint8Array(len); d.set(e.node.data.subarray(0, len)); e.node.data = d; },
    readSync(fd, buffer, offset, length, position) {
      if (offset && typeof offset === 'object') ({ offset = 0, length, position } = offset);
      offset ??= 0; length ??= buffer.byteLength - offset;
      if (fd === 0) return process.__readStdinSync ? process.__readStdinSync(buffer, offset, length) : 0;
      const e = fdEntry(fd, 'read');
      if (e.node.kind === 'dir') throw new FsError('EISDIR', 'read');
      const pos = typeof position === 'number' || typeof position === 'bigint' ? Number(position) : e.pos;
      const chunk = e.node.data.subarray(pos, pos + length);
      new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).set(chunk, offset);
      if (position == null || position === -1) e.pos = pos + chunk.length;
      return chunk.length;
    },
    writeSync(fd, data, a, b, c) {
      let bytes, position;
      if (typeof data === 'string') { bytes = toBytes(data, typeof b === 'string' ? b : 'utf8'); position = typeof a === 'number' ? a : null; }
      else { const off = a ?? 0, len = b ?? data.byteLength - off; bytes = new Uint8Array(data.buffer, data.byteOffset + off, len).slice(); position = typeof c === 'number' ? c : null; }
      if (fd === 1 || fd === 2) { (fd === 1 ? process.stdout : process.stderr).write(Buffer.from(bytes)); return bytes.length; }
      const e = fdEntry(fd, 'write');
      const pos = e.flags.append ? e.node.data.length : position ?? e.pos;
      const end = pos + bytes.length;
      let d = e.node.data;
      if (end > d.length || d.buffer.byteLength !== d.length) { const nd = new Uint8Array(Math.max(end, d.length)); nd.set(d); d = nd; }
      d.set(bytes, pos);
      e.node.data = d; e.node.mtime = Date.now();
      if (position == null) e.pos = end;
      return bytes.length;
    },
    writevSync(fd, buffers, position) { let n = 0; for (const b of buffers) n += fs.writeSync(fd, b, 0, b.byteLength, position == null ? null : position + n); return n; },
    opendirSync(p) {
      const path = toPath(p), entries = vfs.readdir(path).map(([name, node]) => new Dirent(name, node.kind, path));
      let i = 0;
      return { path, readSync: () => entries[i++] || null, read: async () => entries[i++] || null, closeSync() {}, close: async () => {}, async *[Symbol.asyncIterator]() { while (i < entries.length) yield entries[i++]; } };
    },
    statfsSync() { return { type: 0x1021994, bsize: 4096, blocks: 1 << 20, bfree: 1 << 19, bavail: 1 << 19, files: 1 << 20, ffree: 1 << 19 }; },
    watch(p, o, listener) {
      if (typeof o === 'function') listener = o;
      const w = new EventEmitter();
      const path = toPath(p);
      const cb = (changed) => { if (changed === path || changed.startsWith(path + '/')) w.emit('change', 'change', changed.slice(path.length + 1) || path.split('/').pop()); };
      vfs.watchers.add(cb);
      w.close = () => vfs.watchers.delete(cb); w.ref = () => w; w.unref = () => w;
      if (listener) w.on('change', listener);
      track('fs.watch', path);
      return w;
    },
    watchFile() { track('fs.watchFile'); }, unwatchFile() {},
    createReadStream(p, o = {}) {
      if (typeof o === 'string') o = { encoding: o };
      let data, pos = o.start || 0;
      const end = o.end != null ? o.end + 1 : Infinity;
      const s = new stream.Readable({
        highWaterMark: o.highWaterMark || 65536, encoding: o.encoding,
        read(n) {
          try {
            if (!data) { data = typeof o.fd === 'number' ? fdEntry(o.fd, 'read').node.data : vfs.readFile(toPath(p)); queueMicrotask(() => { s.emit('open', o.fd ?? 99); s.emit('ready'); }); }
            const stop = Math.min(data.length, end);
            if (pos >= stop) return this.push(null);
            const chunk = Buffer.from(data.subarray(pos, Math.min(pos + (n || 65536), stop)));
            pos += chunk.length; s.bytesRead += chunk.length;
            this.push(chunk);
          } catch (e) { this.destroy(e); }
        },
      });
      s.path = p; s.bytesRead = 0; s.close = (cb) => { s.destroy(); cb && cb(); };
      return s;
    },
    createWriteStream(p, o = {}) {
      if (typeof o === 'string') o = { encoding: o };
      const path = typeof o.fd === 'number' ? null : toPath(p);
      let opened = false;
      const open = () => { if (!opened && path) { vfs.writeFile(path, new Uint8Array(0), { flag: (o.flags || 'w').startsWith('a') ? 'a' : 'w', mode: o.mode }); opened = true; queueMicrotask(() => { s.emit('open', 99); s.emit('ready'); }); } };
      const s = new stream.Writable({
        write(chunk, enc, cb) { try { open(); if (path) vfs.writeFile(path, toBytes(chunk, enc), { flag: 'a' }); else fs.writeSync(o.fd, toBytes(chunk, enc)); s.bytesWritten += chunk.length; cb(); } catch (e) { cb(e); } },
        final(cb) { try { open(); cb(); } catch (e) { cb(e); } },
      });
      s.path = p; s.bytesWritten = 0; s.close = (cb) => { s.end(cb); };
      try { open(); } catch (e) { queueMicrotask(() => s.destroy(e)); }
      return s;
    },
  };
  fs.exists = (p, cb) => queueMicrotask(() => cb(fs.existsSync(p)));

  // ---- callback API derived from the sync API ----
  const names = ['access', 'stat', 'lstat', 'readFile', 'writeFile', 'appendFile', 'mkdir', 'readdir', 'rmdir', 'rm', 'unlink', 'rename', 'copyFile', 'cp', 'symlink', 'link', 'readlink', 'chmod', 'lchmod', 'chown', 'lchown', 'fchown', 'fchmod',
    'utimes', 'lutimes', 'futimes', 'truncate', 'mkdtemp', 'open', 'close', 'fstat', 'fsync', 'fdatasync', 'ftruncate', 'opendir', 'statfs', 'writev'];
  for (const name of names) {
    const sync = fs[name + 'Sync'];
    fs[name] = (...args) => {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
      let result, error = null;
      try { result = sync(...args); } catch (e) { error = e; }
      process.nextTick(() => (error ? cb(error) : cb(null, result)));
    };
  }
  fs.realpath = Object.assign((p, o, cb) => { cb = typeof o === 'function' ? o : cb; let r, e = null; try { r = fs.realpathSync(p); } catch (x) { e = x; } process.nextTick(() => cb(e, r)); }, { native: (p, o, cb) => fs.realpath(p, o, cb) });
  fs.read = (fd, buffer, offset, length, position, cb) => {
    if (typeof offset === 'function') { cb = offset; offset = 0; length = buffer.byteLength; position = null; }
    else if (offset && typeof offset === 'object') { cb = length; ({ offset = 0, length = buffer.byteLength, position = null } = offset); }
    let n, e = null; try { n = fs.readSync(fd, buffer, offset, length, position); } catch (x) { e = x; }
    process.nextTick(() => cb(e, n, buffer));
  };
  fs.write = (fd, data, ...rest) => {
    const cb = rest.pop();
    let n, e = null; try { n = fs.writeSync(fd, data, ...rest); } catch (x) { e = x; }
    process.nextTick(() => cb(e, n, data));
  };

  // ---- promises API ----
  class FileHandle {
    constructor(fd) { this.fd = fd; }
    async read(buffer, offset, length, position) {
      if (buffer && !ArrayBuffer.isView(buffer)) ({ buffer, offset, length, position } = buffer);
      buffer ??= Buffer.alloc(16384);
      return { bytesRead: fs.readSync(this.fd, buffer, offset ?? 0, length ?? buffer.byteLength, position), buffer };
    }
    async write(data, ...rest) { return { bytesWritten: fs.writeSync(this.fd, data, ...rest), buffer: data }; }
    async readFile(o) { return fs.readFileSync(this.fd, o); }
    async writeFile(data, o) { return fs.writeFileSync(this.fd, data, o); }
    async appendFile(data, o) { fs.writeSync(this.fd, typeof data === 'string' ? Buffer.from(data, optEnc(o) || 'utf8') : data); }
    async stat(o) { return fs.fstatSync(this.fd, o); }
    async truncate(len) { return fs.ftruncateSync(this.fd, len); }
    async sync() {} async datasync() {} async chmod() {} async chown() {} async utimes() {}
    async close() { fs.closeSync(this.fd); }
    createReadStream(o) { return fs.createReadStream(null, { ...o, fd: this.fd }); }
    createWriteStream(o) { return fs.createWriteStream(null, { ...o, fd: this.fd }); }
    readLines(o) { throw new Error('FileHandle.readLines: not implemented in the emulation layer'); }
    async [Symbol.asyncDispose]() { fs.closeSync(this.fd); }
  }
  const promises = { constants };
  for (const name of [...names, 'realpath']) {
    if (name === 'open' || name === 'close') continue;
    const sync = fs[name + 'Sync'];
    promises[name] = async (...args) => sync(...args);
  }
  promises.open = async (p, flags, mode) => new FileHandle(fs.openSync(p, flags, mode));
  promises.watch = async function* () { track('fs.promises.watch'); await new Promise(() => {}); };
  fs.promises = promises;
  fs.FileHandle = FileHandle;
  fs.ReadStream = stream.Readable; fs.WriteStream = stream.Writable;
  return fs;
}
