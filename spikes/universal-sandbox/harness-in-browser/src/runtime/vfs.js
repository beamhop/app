// In-memory file system ("kernel" side). Synchronous; every Node fs API is a direct call into it.
// Files loaded from an image are zero-copy subarrays of the image buffer (replaced on write).

const S_IFREG = 0o100000, S_IFDIR = 0o040000, S_IFLNK = 0o120000;
let inoCounter = 2;

export class FsError extends Error {
  constructor(code, syscall, path, dest) {
    const text = { ENOENT: 'no such file or directory', EEXIST: 'file already exists', ENOTDIR: 'not a directory', EISDIR: 'illegal operation on a directory', ENOTEMPTY: 'directory not empty', EINVAL: 'invalid argument', EBADF: 'bad file descriptor', ELOOP: 'too many symbolic links encountered', EPERM: 'operation not permitted', EACCES: 'permission denied' }[code] || code;
    super(`${code}: ${text}, ${syscall}${path != null ? ` '${path}'` : ''}${dest != null ? ` -> '${dest}'` : ''}`);
    this.code = code;
    this.errno = { ENOENT: -2, EEXIST: -17, ENOTDIR: -20, EISDIR: -21, ENOTEMPTY: -39, EINVAL: -22, EBADF: -9, ELOOP: -40, EPERM: -1, EACCES: -13 }[code] || -1;
    this.syscall = syscall;
    if (path != null) this.path = path;
    if (dest != null) this.dest = dest;
  }
}

function mkNode(kind, mode) {
  const now = Date.now();
  const n = { kind, mode, ino: inoCounter++, mtime: now, ctime: now, atime: now, birthtime: now, nlink: 1 };
  if (kind === 'dir') n.children = new Map();
  if (kind === 'file') n.data = new Uint8Array(0);
  return n;
}

export function normalize(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

export class VFS {
  constructor() {
    this.root = mkNode('dir', 0o755);
    this.stats = { files: 0, bytes: 0 };
    this.watchers = new Set();
  }

  // Resolve a path to { node, parent, name, path }. followLast: follow a symlink in the final component.
  _walk(path, followLast = true, syscall = 'stat', depth = 0, origPath = path) {
    if (depth > 40) throw new FsError('ELOOP', syscall, origPath);
    const parts = normalize(path).split('/').filter(Boolean);
    let node = this.root, parent = null, name = '', cur = '';
    for (let i = 0; i < parts.length; i++) {
      if (node.kind !== 'dir') throw new FsError('ENOTDIR', syscall, origPath);
      parent = node; name = parts[i];
      const child = node.children.get(name);
      if (!child) {
        if (i === parts.length - 1) return { node: null, parent, name, path: cur + '/' + name };
        throw new FsError('ENOENT', syscall, origPath);
      }
      if (child.kind === 'link' && (i < parts.length - 1 || followLast)) {
        const target = child.target.startsWith('/') ? child.target : cur + '/' + child.target;
        const rest = parts.slice(i + 1).join('/');
        return this._walk(target + (rest ? '/' + rest : ''), followLast, syscall, depth + 1, origPath);
      }
      node = child; cur += '/' + name;
    }
    return { node, parent, name, path: cur || '/' };
  }
  lookup(path, follow = true, syscall = 'stat') {
    const r = this._walk(path, follow, syscall);
    if (!r.node) throw new FsError('ENOENT', syscall, path);
    return r.node;
  }
  tryLookup(path, follow = true) {
    try { return this._walk(path, follow).node; } catch { return null; }
  }
  realpath(path) {
    const r = this._walk(path, true, 'realpath');
    if (!r.node) throw new FsError('ENOENT', 'realpath', path);
    return r.path;
  }
  mkdir(path, { recursive = false, mode = 0o755 } = {}) {
    if (recursive) {
      const parts = normalize(path).split('/').filter(Boolean);
      let cur = '', first;
      for (const part of parts) {
        cur += '/' + part;
        const r = this._walk(cur, true, 'mkdir');
        if (!r.node) { r.parent.children.set(r.name, mkNode('dir', mode)); first ??= cur; }
        else if (r.node.kind !== 'dir') throw new FsError('EEXIST', 'mkdir', path);
      }
      return first;
    }
    const r = this._walk(path, true, 'mkdir');
    if (r.node) throw new FsError('EEXIST', 'mkdir', path);
    r.parent.children.set(r.name, mkNode('dir', mode));
    r.parent.mtime = Date.now();
  }
  writeFile(path, data, { mode = 0o644, flag = 'w' } = {}) {
    const r = this._walk(path, true, 'open');
    let node = r.node;
    if (node && node.kind === 'dir') throw new FsError('EISDIR', 'open', path);
    if (node && flag.includes('x')) throw new FsError('EEXIST', 'open', path);
    if (!node) {
      if (!r.parent) throw new FsError('ENOENT', 'open', path);
      node = mkNode('file', mode);
      r.parent.children.set(r.name, node);
      r.parent.mtime = Date.now();
    }
    if (flag.startsWith('a')) {
      const merged = new Uint8Array(node.data.length + data.length);
      merged.set(node.data, 0); merged.set(data, node.data.length);
      node.data = merged;
    } else node.data = data;
    node.mtime = node.ctime = Date.now();
    this._notify(path);
    return node;
  }
  readFile(path) {
    const node = this.lookup(path, true, 'open');
    if (node.kind === 'dir') throw new FsError('EISDIR', 'read', path);
    return node.data;
  }
  readdir(path) {
    const node = this.lookup(path, true, 'scandir');
    if (node.kind !== 'dir') throw new FsError('ENOTDIR', 'scandir', path);
    return [...node.children.entries()];
  }
  unlink(path) {
    const r = this._walk(path, false, 'unlink');
    if (!r.node) throw new FsError('ENOENT', 'unlink', path);
    if (r.node.kind === 'dir') throw new FsError('EISDIR', 'unlink', path);
    r.parent.children.delete(r.name);
    this._notify(path);
  }
  rmdir(path) {
    const r = this._walk(path, false, 'rmdir');
    if (!r.node) throw new FsError('ENOENT', 'rmdir', path);
    if (r.node.kind !== 'dir') throw new FsError('ENOTDIR', 'rmdir', path);
    if (r.node.children.size) throw new FsError('ENOTEMPTY', 'rmdir', path);
    r.parent.children.delete(r.name);
  }
  rm(path, { recursive = false, force = false } = {}) {
    let r;
    try { r = this._walk(path, false, 'rm'); } catch (e) { if (force) return; throw e; }
    if (!r.node) { if (force) return; throw new FsError('ENOENT', 'rm', path); }
    if (r.node.kind === 'dir' && !recursive) throw new FsError('EISDIR', 'rm', path);
    if (!r.parent) throw new FsError('EPERM', 'rm', path);
    r.parent.children.delete(r.name);
    this._notify(path);
  }
  rename(from, to) {
    const a = this._walk(from, false, 'rename');
    if (!a.node) throw new FsError('ENOENT', 'rename', from, to);
    const b = this._walk(to, false, 'rename');
    if (!b.parent) throw new FsError('ENOENT', 'rename', from, to);
    if (b.node && b.node.kind === 'dir' && b.node.children.size) throw new FsError('ENOTEMPTY', 'rename', from, to);
    a.parent.children.delete(a.name);
    b.parent.children.set(b.name, a.node);
    this._notify(from); this._notify(to);
  }
  symlink(target, path) {
    const r = this._walk(path, false, 'symlink');
    if (r.node) throw new FsError('EEXIST', 'symlink', target, path);
    const n = mkNode('link', 0o777); n.target = target;
    r.parent.children.set(r.name, n);
  }
  link(existing, path) {
    const node = this.lookup(existing, true, 'link');
    const r = this._walk(path, false, 'link');
    if (r.node) throw new FsError('EEXIST', 'link', existing, path);
    r.parent.children.set(r.name, node); node.nlink++;
  }
  statOf(node) {
    const size = node.kind === 'file' ? node.data.length : node.kind === 'link' ? node.target.length : 4096;
    const type = node.kind === 'file' ? S_IFREG : node.kind === 'dir' ? S_IFDIR : S_IFLNK;
    return { kind: node.kind, mode: type | node.mode, size, ino: node.ino, mtimeMs: node.mtime, ctimeMs: node.ctime, atimeMs: node.atime, birthtimeMs: node.birthtime, nlink: node.nlink };
  }
  _notify(path) {
    if (this.watchers.size) for (const w of this.watchers) { try { w(path); } catch {} }
  }
  count() {
    let files = 0, bytes = 0, dirs = 0;
    const visit = (n) => {
      if (n.kind === 'file') { files++; bytes += n.data.length; }
      else if (n.kind === 'dir') { dirs++; for (const c of n.children.values()) visit(c); }
    };
    visit(this.root);
    return { files, dirs, bytes };
  }

  // Image: [u32 LE header length][header JSON][blob]. header = { dirs, files:[[path,off,len,mode]], links:[[path,target]], esm:{path:[off,len]} }
  loadImage(buffer, mountAt = '') {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const headerLen = new DataView(u8.buffer, u8.byteOffset, 4).getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(u8.subarray(4, 4 + headerLen)));
    const base = 4 + headerLen;
    for (const d of header.dirs) this.mkdir(mountAt + d, { recursive: true });
    const dirCache = new Map();
    for (const [path, off, len, mode] of header.files) {
      const full = mountAt + path;
      const slash = full.lastIndexOf('/');
      const dirPath = full.slice(0, slash) || '/';
      let dir = dirCache.get(dirPath);
      if (!dir) { this.mkdir(dirPath, { recursive: true }); dir = this.lookup(dirPath); dirCache.set(dirPath, dir); }
      const node = mkNode('file', mode || 0o644);
      node.data = u8.subarray(base + off, base + off + len);
      dir.children.set(full.slice(slash + 1), node);
    }
    for (const [path, target] of header.links || []) { try { this.symlink(target, mountAt + path); } catch {} }
    const esm = new Map();
    for (const [path, [off, len]] of Object.entries(header.esm || {})) esm.set(mountAt + path, u8.subarray(base + off, base + off + len));
    return { esm, meta: header.meta || {} };
  }
}
