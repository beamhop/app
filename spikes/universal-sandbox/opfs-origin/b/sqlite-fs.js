// Toy filesystem on SQLite.
//
//   inodes(ino, parent, name, path, mode, size, mtime, data_id)
//   chunks(id = data_id*65536 + idx, data)   64 KiB blobs, ordinary rowid table (default)
//     or chunks(data_id, idx, data) PRIMARY KEY(data_id, idx) WITHOUT ROWID  (opts.chunkTable = 'without-rowid';
//     kept only to measure it: it turned out to more than double the file size for 1-4 KB files,
//     because index b-trees keep at most ~1/4 page of a row inline and spill the rest to overflow pages)
//   shared(data_id)                   data ids referenced by more than one inode (set by fork)
//
// File content is addressed through inodes.data_id rather than ino, so a fork of a directory tree
// is one INSERT ... SELECT over inode rows and copies no file data. A write to a file whose data_id
// is in `shared` allocates a fresh data_id first (copy-on-write at file granularity).
//
// Toy limitations: no unlink/GC of shared data, no rename (it would have to rewrite descendant
// `path` values), no hard links, single writer assumed (data ids are allocated in JS).
export const CHUNK = 64 * 1024;
export const S_IFDIR = 0o040755;
export const S_IFREG = 0o100644;

export class ToyFs {
  constructor(db, opts = {}) {
    this.db = db;
    const wr = (this.withoutRowid = opts.chunkTable === 'without-rowid');
    db.exec(`
      CREATE TABLE IF NOT EXISTS inodes(
        ino INTEGER PRIMARY KEY, parent INTEGER NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
        mode INTEGER NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL, data_id INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS inodes_path ON inodes(path);
      CREATE UNIQUE INDEX IF NOT EXISTS inodes_parent_name ON inodes(parent, name);
      ${wr
        ? 'CREATE TABLE IF NOT EXISTS chunks(data_id INTEGER NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(data_id, idx)) WITHOUT ROWID;'
        : 'CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, data BLOB NOT NULL);'}
      CREATE TABLE IF NOT EXISTS shared(data_id INTEGER PRIMARY KEY) WITHOUT ROWID;
      INSERT OR IGNORE INTO inodes VALUES(1, 0, '', '/', ${S_IFDIR}, 0, 0, 0);
    `);
    this.nextData = (db.selectValue('SELECT max(data_id) FROM inodes') || 0) + 1;
    this.dirs = new Map([['/', 1]]);
    this.q = {
      stat: db.prepare('SELECT ino, mode, size, mtime, data_id FROM inodes WHERE path = ?'),
      insInode: db.prepare('INSERT INTO inodes(parent, name, path, mode, size, mtime, data_id) VALUES(?,?,?,?,?,?,?)'),
      updInode: db.prepare('UPDATE inodes SET size = ?, mtime = ?, data_id = ? WHERE ino = ?'),
      insChunk: db.prepare(wr ? 'INSERT INTO chunks(data_id, idx, data) VALUES(?1,?2,?3)' : 'INSERT INTO chunks(id, data) VALUES(?1 * 65536 + ?2, ?3)'),
      delChunks: db.prepare(wr ? 'DELETE FROM chunks WHERE data_id = ?1' : 'DELETE FROM chunks WHERE id >= ?1 * 65536 AND id < (?1 + 1) * 65536'),
      selChunks: db.prepare(wr ? 'SELECT data FROM chunks WHERE data_id = ?1 ORDER BY idx' : 'SELECT data FROM chunks WHERE id >= ?1 * 65536 AND id < (?1 + 1) * 65536 ORDER BY id'),
      isShared: db.prepare('SELECT 1 FROM shared WHERE data_id = ?'),
      list: db.prepare('SELECT name, mode, size FROM inodes WHERE parent = ?'),
    };
  }
  close() { for (const s of Object.values(this.q)) s.finalize(); }

  stat(path) {
    const s = this.q.stat;
    try {
      s.bind(1, path);
      if (!s.step()) return null;
      return { ino: s.getInt(0), mode: s.getInt(1), size: s.getInt(2), mtime: s.get(3), dataId: s.getInt(4) };
    } finally { s.reset(); }
  }
  _parentOf(path) {
    const i = path.lastIndexOf('/');
    const ppath = i === 0 ? '/' : path.slice(0, i);
    let ino = this.dirs.get(ppath);
    if (ino === undefined) {
      const st = this.stat(ppath);
      if (!st) throw new Error('ENOENT: ' + ppath);
      ino = st.ino;
      this.dirs.set(ppath, ino);
    }
    return { parent: ino, name: path.slice(i + 1) };
  }
  mkdir(path) {
    const { parent, name } = this._parentOf(path);
    this.q.insInode.bind([parent, name, path, S_IFDIR, 0, Date.now(), 0]).stepReset();
    const ino = Number(this.db.selectValue('SELECT last_insert_rowid()'));
    this.dirs.set(path, ino);
    return ino;
  }
  // General write: create or replace. `data` is a Uint8Array.
  writeFile(path, data) {
    const st = this.stat(path);
    let dataId;
    if (st) {
      dataId = st.dataId;
      let shared = false;
      try { shared = this.q.isShared.bind(1, dataId).step(); } finally { this.q.isShared.reset(); }
      if (shared) dataId = this.nextData++; // copy-on-write: leave the shared chunks alone
      else this.q.delChunks.bind(1, dataId).stepReset();
      this.q.updInode.bind([data.length, Date.now(), dataId, st.ino]).stepReset();
    } else {
      const { parent, name } = this._parentOf(path);
      dataId = this.nextData++;
      this.q.insInode.bind([parent, name, path, S_IFREG, data.length, Date.now(), dataId]).stepReset();
    }
    const ins = this.q.insChunk;
    for (let off = 0, idx = 0; off < data.length; off += CHUNK, idx++) {
      ins.bind(1, dataId).bind(2, idx).bind(3, data.subarray(off, Math.min(off + CHUNK, data.length))).stepReset();
    }
  }
  readFile(path) {
    const st = this.stat(path);
    if (!st) return null;
    const out = new Uint8Array(st.size);
    const s = this.q.selChunks;
    try {
      s.bind(1, st.dataId);
      let off = 0;
      while (s.step()) { const b = s.getBlob(0); out.set(b, off); off += b.length; }
    } finally { s.reset(); }
    return out;
  }
  readdir(path) {
    const st = this.stat(path);
    if (!st) return null;
    const s = this.q.list;
    const out = [];
    try {
      s.bind(1, st.ino);
      while (s.step()) out.push({ name: s.getString(0), mode: s.getInt(1), size: s.getInt(2) });
    } finally { s.reset(); }
    return out;
  }
  // Copy-on-write fork of the tree at `src` to the new path `dst`. Copies inode rows only.
  fork(src, dst) {
    const st = this.stat(src);
    if (!st) throw new Error('ENOENT: ' + src);
    if (this.stat(dst)) throw new Error('EEXIST: ' + dst);
    const { parent, name } = this._parentOf(dst);
    const delta = Number(this.db.selectValue('SELECT max(ino) FROM inodes'));
    this.db.exec({
      sql: `INSERT INTO inodes(ino, parent, name, path, mode, size, mtime, data_id)
              SELECT ino + $delta,
                     CASE WHEN ino = $src_ino THEN $dst_parent ELSE parent + $delta END,
                     CASE WHEN ino = $src_ino THEN $dst_name ELSE name END,
                     $dst || substr(path, length($src) + 1), mode, size, mtime, data_id
              FROM inodes WHERE path = $src OR (path > $src || '/' AND path < $src || '0')`,
      bind: { $delta: delta, $src_ino: st.ino, $dst_parent: parent, $dst_name: name, $dst: dst, $src: src },
    });
    const rows = this.db.changes();
    this.db.exec({
      sql: `INSERT OR IGNORE INTO shared(data_id)
              SELECT data_id FROM inodes WHERE data_id != 0 AND (path > $dst || '/' AND path < $dst || '0' OR path = $dst)`,
      bind: { $dst: dst },
    });
    return rows;
  }
  // Deep copy for comparison: same inode copy, plus every chunk row duplicated inside SQLite.
  forkDeep(src, dst) {
    const st = this.stat(src);
    const { parent, name } = this._parentOf(dst);
    const delta = Number(this.db.selectValue('SELECT max(ino) FROM inodes'));
    const ddelta = this.nextData;
    this.db.exec({
      sql: `INSERT INTO inodes(ino, parent, name, path, mode, size, mtime, data_id)
              SELECT ino + $delta,
                     CASE WHEN ino = $src_ino THEN $dst_parent ELSE parent + $delta END,
                     CASE WHEN ino = $src_ino THEN $dst_name ELSE name END,
                     $dst || substr(path, length($src) + 1), mode, size, mtime,
                     CASE WHEN data_id = 0 THEN 0 ELSE data_id + $ddelta END
              FROM inodes WHERE path = $src OR (path > $src || '/' AND path < $src || '0')`,
      bind: { $delta: delta, $ddelta: ddelta, $src_ino: st.ino, $dst_parent: parent, $dst_name: name, $dst: dst, $src: src },
    });
    const rows = this.db.changes();
    this.db.exec({
      sql: this.withoutRowid
        ? `INSERT INTO chunks(data_id, idx, data)
              SELECT c.data_id + $ddelta, c.idx, c.data FROM chunks c
              WHERE c.data_id IN (SELECT data_id FROM inodes WHERE data_id != 0 AND path > $src || '/' AND path < $src || '0')`
        : `INSERT INTO chunks(id, data)
              SELECT c.id + $ddelta * 65536, c.data FROM chunks c
              WHERE (c.id >> 16) IN (SELECT data_id FROM inodes WHERE data_id != 0 AND path > $src || '/' AND path < $src || '0')`,
      bind: { $ddelta: ddelta, $src: src },
    });
    this.nextData += ddelta;
    return rows;
  }
}
