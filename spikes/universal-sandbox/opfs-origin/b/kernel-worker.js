// Kernel worker (module, dedicated) on origin B. Owns OPFS sync access handles and SQLite.
import { ToyFs, CHUNK } from '/sqlite-fs.js';

const MB = 1024 * 1024;
const violations = [];
self.addEventListener('securitypolicyviolation', (e) => violations.push(`${e.effectiveDirective} blocked ${e.blockedURI}`));
const logs = [];

// deterministic PRNG so every run writes the same sizes
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const POOL = new Uint8Array(8 * MB);
for (let o = 0; o < POOL.length; o += 65536) crypto.getRandomValues(POOL.subarray(o, o + 65536));
const r1 = (x) => Math.round(x * 10) / 10;
const rate = (n, ms) => Math.round(n / (ms / 1000));
const mbps = (bytes, ms) => r1(bytes / MB / (ms / 1000));

const cmds = {};

// ---------------- 1. environment ----------------
cmds.env = async () => {
  const out = {
    context: self.constructor.name,
    origin: self.location.origin,
    crossOriginIsolated: self.crossOriginIsolated,
    isSecureContext: self.isSecureContext,
    typeofSharedArrayBuffer: typeof SharedArrayBuffer,
    typeofAtomicsWaitAsync: typeof Atomics.waitAsync,
    hasCreateSyncAccessHandle: 'createSyncAccessHandle' in FileSystemFileHandle.prototype,
    typeofWebAssemblySuspending: typeof WebAssembly.Suspending,
    typeofRTCPeerConnection: typeof RTCPeerConnection,
    typeofWebTransport: typeof WebTransport,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    userAgent: navigator.userAgent,
    performanceNowResolutionNote: 'not cross-origin isolated: performance.now() is coarsened (100 us in Chromium)',
  };
  try { out.storageEstimate = await navigator.storage.estimate(); } catch (e) { out.storageEstimate = `throws ${e.name}: ${e.message}`; }
  try { out.persisted = await navigator.storage.persisted(); } catch (e) { out.persisted = `throws ${e.name}`; }
  try { const b = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }).buffer; out.sharedWasmMemory = b.constructor.name; } catch (e) { out.sharedWasmMemory = `throws ${e.name}: ${e.message}`; }
  return out;
};

async function listOpfs(dir, prefix = '') {
  const names = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'directory') names.push(...(await listOpfs(h, prefix + name + '/')));
    else names.push(prefix + name);
  }
  return names.sort();
}
cmds.listOpfs = async () => listOpfs(await navigator.storage.getDirectory());

// ---------------- 2. raw OPFS sync access handle benchmark ----------------
cmds.opfsBench = async ({ sizeMB = 64, randomOps = 20000 } = {}) => {
  const root = await navigator.storage.getDirectory();
  const out = {};
  let t = performance.now();
  const fh = await root.getFileHandle('raw-bench.bin', { create: true });
  const h = await fh.createSyncAccessHandle();
  out.openMs = r1(performance.now() - t);
  h.truncate(0);
  const size = sizeMB * MB;

  for (const [label, cs] of [['1MB', MB], ['64KB', 65536]]) {
    h.truncate(0);
    t = performance.now();
    for (let off = 0; off < size; off += cs) { const n = h.write(POOL.subarray(off % POOL.length, (off % POOL.length) + cs), { at: off }); if (n !== cs) throw new Error('short write ' + n); }
    const tw = performance.now() - t;
    h.flush();
    const twf = performance.now() - t;
    out[`seqWrite_${label}_MBps`] = mbps(size, tw);
    out[`seqWrite_${label}_inclFlush_MBps`] = mbps(size, twf);
    const buf = new Uint8Array(cs);
    let sum = 0;
    t = performance.now();
    for (let off = 0; off < size; off += cs) { const n = h.read(buf, { at: off }); if (n !== cs) throw new Error('short read ' + n); sum += buf[0] + buf[cs - 1]; }
    out[`seqRead_${label}_MBps`] = mbps(size, performance.now() - t);
    let expect = 0;
    for (let off = 0; off < size; off += cs) { const p = off % POOL.length; expect += POOL[p] + POOL[p + cs - 1]; }
    if (sum !== expect) throw new Error('read-back mismatch');
  }
  out.fileSizeBytes = h.getSize();

  const rnd = rng(42);
  const pages = size / 4096;
  const offs = new Uint32Array(randomOps);
  for (let i = 0; i < randomOps; i++) offs[i] = Math.floor(rnd() * pages);
  const b4 = new Uint8Array(4096);
  t = performance.now();
  for (let i = 0; i < randomOps; i++) h.read(b4, { at: offs[i] * 4096 });
  out.rand4kRead_opsPerSec = rate(randomOps, performance.now() - t);
  t = performance.now();
  for (let i = 0; i < randomOps; i++) h.write(POOL.subarray(i * 4096 % (POOL.length - 4096), (i * 4096 % (POOL.length - 4096)) + 4096), { at: offs[i] * 4096 });
  const tw = performance.now() - t;
  h.flush();
  out.rand4kWrite_opsPerSec = rate(randomOps, tw);
  out.rand4kWrite_inclFinalFlush_opsPerSec = rate(randomOps, performance.now() - t);
  const nf = 2000;
  t = performance.now();
  for (let i = 0; i < nf; i++) { h.write(b4, { at: offs[i] * 4096 }); h.flush(); }
  out.rand4kWrite_flushEach_opsPerSec = rate(nf, performance.now() - t);
  h.close();
  await root.removeEntry('raw-bench.bin');
  return out;
};

// second-open behaviour of a raw sync access handle (used by the two-tab test)
let heldHandle = null;
cmds.holdHandle = async () => {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle('lock-test.bin', { create: true });
  try { heldHandle = await fh.createSyncAccessHandle(); return { ok: true }; } catch (e) { return { ok: false, error: `${e.name}: ${e.message}` }; }
};

// ---------------- 3. SQLite (opfs-sahpool) ----------------
let sqlite3 = null;
let pool = null;
// NOTE: by default a failed installOpfsSAHPoolVfs() calls removeVfs(), which recursively DELETES the
// pool directory (sqlite-wasm 3.54.1 dist/index.mjs; it only spares files another tab holds locked).
// `preserve: true` maps to the preserveOnInitFailure option, which just unregisters the VFS instead.
cmds.sqliteInit = async ({ poolName = 'kernel-pool', force = false, preserve = true } = {}) => {
  const out = {};
  let t = performance.now();
  const t00 = t;
  if (!sqlite3) {
    const mod = await import('/vendor/sqlite/index.mjs');
    out.importJsMs = r1(performance.now() - t);
    t = performance.now();
    sqlite3 = await mod.default({ print: (...a) => logs.push(a.join(' ')), printErr: (...a) => logs.push('ERR ' + a.join(' ')) });
    out.initModuleMs = r1(performance.now() - t);
  }
  t = performance.now();
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: poolName, directory: '/' + poolName, initialCapacity: 12, clearOnInit: false, forceReinitIfPreviouslyFailed: force, preserveOnInitFailure: preserve });
  } catch (e) {
    out.poolError = `${e.name}: ${e.message}`;
    out.poolFailedAfterMs = r1(performance.now() - t);
    return out;
  }
  out.installSahPoolMs = r1(performance.now() - t);
  out.totalMs = r1(performance.now() - t00);
  out.sqliteVersion = sqlite3.version.libVersion;
  out.vfsList = sqlite3.capi.sqlite3_js_vfs_list();
  out.hasOpfsVfsNeedingSAB = !!sqlite3.oo1.OpfsDb;
  out.poolCapacity = pool.getCapacity();
  out.poolFiles = pool.getFileNames();
  out.resources = performance.getEntriesByType('resource').filter((r) => /vendor\/sqlite/.test(r.name)).map((r) => ({ name: r.name.split('/').pop(), transferSize: r.transferSize, encodedBodySize: r.encodedBodySize, decodedBodySize: r.decodedBodySize, durationMs: r1(r.duration) }));
  out.logs = logs.splice(0);
  return out;
};

function openDb(name, pragmas = true) {
  const db = new pool.OpfsSAHPoolDb(name);
  if (pragmas) db.exec('PRAGMA synchronous=NORMAL; PRAGMA cache_size=-16384; PRAGMA temp_store=MEMORY;');
  return db;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

cmds.sqliteBench = async ({ nFiles = 20000, bigMB = 50, dirEntries = 5000, tag = 'r', chunkTable = 'rowid', journal = 'delete' } = {}) => {
  const out = {};
  const dbName = `/bench-${tag}.db`;
  try { pool.unlink(dbName); } catch (e) { /* not there */ }
  const db = openDb(dbName);
  // WAL has no shared-memory support in this VFS; it is only reachable through locking_mode=EXCLUSIVE
  if (journal === 'wal') db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL;');
  out.config = { chunkTable, journal };
  out.pragmas = {
    journal_mode: db.selectValue('PRAGMA journal_mode'), synchronous: db.selectValue('PRAGMA synchronous'),
    page_size: db.selectValue('PRAGMA page_size'), cache_size: db.selectValue('PRAGMA cache_size'), locking_mode: db.selectValue('PRAGMA locking_mode'),
  };
  const fs = new ToyFs(db, { chunkTable });
  const nDirs = nFiles / 100;
  const rnd = rng(7);
  const sizes = new Uint16Array(nFiles);
  let totalBytes = 0;
  for (let i = 0; i < nFiles; i++) { sizes[i] = 1024 + Math.floor(rnd() * 3072); totalBytes += sizes[i]; }
  const pathOf = (rootDir, i) => `${rootDir}/pkg${String(Math.floor(i / 100)).padStart(3, '0')}/lib/file${i % 100}.js`;
  const dataOf = (i) => { const off = (i * 4099) % (POOL.length - 4096); return POOL.subarray(off, off + sizes[i]); };
  const mkTree = (rootDir) => { fs.mkdir(rootDir); for (let d = 0; d < nDirs; d++) { const p = `${rootDir}/pkg${String(d).padStart(3, '0')}`; fs.mkdir(p); fs.mkdir(p + '/lib'); } };
  out.smallFiles = { count: nFiles, totalMB: r1(totalBytes / MB), dirs: nDirs * 2 + 1 };

  // --- create: one transaction ---
  let t = performance.now();
  db.exec('BEGIN');
  mkTree('/nm');
  for (let i = 0; i < nFiles; i++) fs.writeFile(pathOf('/nm', i), dataOf(i));
  const tBody = performance.now() - t;
  db.exec('COMMIT');
  let ms = performance.now() - t;
  out.createOneTx = { ms: r1(ms), commitMs: r1(ms - tBody), filesPerSec: rate(nFiles, ms), MBps: mbps(totalBytes, ms) };

  // --- stat ---
  const order = new Uint32Array(nFiles);
  for (let i = 0; i < nFiles; i++) order[i] = i;
  for (let i = nFiles - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const x = order[i]; order[i] = order[j]; order[j] = x; }
  const paths = Array.from(order, (i) => pathOf('/nm', i));
  t = performance.now();
  let found = 0;
  for (let i = 0; i < nFiles; i++) if (fs.stat(paths[i])) found++;
  ms = performance.now() - t;
  out.stat = { ms: r1(ms), opsPerSec: rate(nFiles, ms), found };
  t = performance.now();
  let missing = 0;
  for (let i = 0; i < nFiles; i++) if (!fs.stat(paths[i] + '.map')) missing++;
  ms = performance.now() - t;
  out.statMissing = { ms: r1(ms), opsPerSec: rate(nFiles, ms), missing };

  // --- read all back ---
  t = performance.now();
  let readBytes = 0;
  let mismatches = 0;
  for (let k = 0; k < nFiles; k++) {
    const i = order[k];
    const b = fs.readFile(paths[k]);
    readBytes += b.length;
    const d = dataOf(i);
    if (b.length !== d.length || b[0] !== d[0] || b[b.length - 1] !== d[d.length - 1]) mismatches++;
  }
  ms = performance.now() - t;
  out.readAll = { ms: r1(ms), filesPerSec: rate(nFiles, ms), MBps: mbps(readBytes, ms), bytesOk: readBytes === totalBytes, mismatches };

  // --- create: batches of 500 files per transaction ---
  t = performance.now();
  db.exec('BEGIN'); mkTree('/nm-batched'); db.exec('COMMIT');
  for (let i = 0; i < nFiles; i += 500) {
    db.exec('BEGIN');
    for (let j = i; j < i + 500 && j < nFiles; j++) fs.writeFile(pathOf('/nm-batched', j), dataOf(j));
    db.exec('COMMIT');
  }
  ms = performance.now() - t;
  out.createBatched500 = { ms: r1(ms), filesPerSec: rate(nFiles, ms), MBps: mbps(totalBytes, ms), transactions: nFiles / 500 + 1 };

  // --- overwrite existing small files (stat + delete chunks + update + insert) ---
  t = performance.now();
  db.exec('BEGIN');
  for (let i = 0; i < 5000; i++) fs.writeFile(pathOf('/nm-batched', i), dataOf(i + 1));
  db.exec('COMMIT');
  ms = performance.now() - t;
  out.overwrite5000OneTx = { ms: r1(ms), filesPerSec: rate(5000, ms) };

  // --- one big file ---
  const big = new Uint8Array(bigMB * MB);
  for (let off = 0; off < big.length; off += POOL.length) big.set(POOL.subarray(0, Math.min(POOL.length, big.length - off)), off);
  big[big.length - 1] = 0x5a;
  t = performance.now();
  db.exec('BEGIN'); fs.writeFile('/big.bin', big); db.exec('COMMIT');
  ms = performance.now() - t;
  out.bigWrite = { MB: bigMB, ms: r1(ms), MBps: mbps(big.length, ms), chunks: Math.ceil(big.length / CHUNK) };
  t = performance.now();
  const back = fs.readFile('/big.bin');
  ms = performance.now() - t;
  let ok = back.length === big.length && back[back.length - 1] === 0x5a;
  for (let i = 0; ok && i < back.length; i += 4093) ok = back[i] === big[i];
  out.bigRead = { MB: bigMB, ms: r1(ms), MBps: mbps(back.length, ms), contentOk: ok };

  // --- directory with 5,000 entries ---
  t = performance.now();
  db.exec('BEGIN'); fs.mkdir('/wide');
  for (let i = 0; i < dirEntries; i++) fs.writeFile(`/wide/entry-${i}.txt`, POOL.subarray(i, i + 16));
  db.exec('COMMIT');
  out.wideDirCreateMs = r1(performance.now() - t);
  const lt = [];
  let listed = 0;
  for (let k = 0; k < 15; k++) { t = performance.now(); listed = fs.readdir('/wide').length; lt.push(performance.now() - t); }
  out.listDir = { entries: listed, firstMs: r1(lt[0]), medianMs: r1(median(lt)), entriesPerSec: rate(listed, median(lt)) };

  // --- copy-on-write fork of /nm (20,000 files) ---
  const pagesBefore = db.selectValue('PRAGMA page_count');
  t = performance.now();
  db.exec('BEGIN'); const rows = fs.fork('/nm', '/nm-fork'); db.exec('COMMIT');
  ms = performance.now() - t;
  const pagesAfter = db.selectValue('PRAGMA page_count');
  const pageSize = db.selectValue('PRAGMA page_size');
  const probe = pathOf('/nm-fork', 1234);
  const orig = pathOf('/nm', 1234);
  const same = fs.readFile(probe).every((v, i) => v === dataOf(1234)[i]);
  db.exec('BEGIN'); fs.writeFile(probe, new TextEncoder().encode('changed in fork')); db.exec('COMMIT');
  const origUntouched = fs.readFile(orig).length === sizes[1234] && fs.readFile(orig)[0] === dataOf(1234)[0];
  const forkChanged = new TextDecoder().decode(fs.readFile(probe)) === 'changed in fork';
  db.exec('BEGIN'); fs.writeFile(orig, new TextEncoder().encode('changed in original')); db.exec('COMMIT');
  const other = pathOf('/nm-fork', 1235);
  out.forkCow = {
    ms: r1(ms), inodeRowsCopied: rows, rowsPerSec: rate(rows, ms), dbGrowthMB: r1((pagesAfter - pagesBefore) * pageSize / MB),
    forkReadsSameContent: same, writeInForkLeavesOriginal: origUntouched, forkSeesItsWrite: forkChanged,
    writeInOriginalLeavesFork: fs.readFile(other).length === sizes[1235] && new TextDecoder().decode(fs.readFile(probe)) === 'changed in fork',
  };
  t = performance.now();
  db.exec('BEGIN'); const rows2 = fs.forkDeep('/nm', '/nm-deep'); db.exec('COMMIT');
  ms = performance.now() - t;
  out.forkDeepCopy = { ms: r1(ms), inodeRowsCopied: rows2, MBps: mbps(totalBytes, ms), dbGrowthMB: r1((db.selectValue('PRAGMA page_count') - pagesAfter) * pageSize / MB) };

  // --- sizes ---
  out.db = {
    pageCount: db.selectValue('PRAGMA page_count'), pageSize,
    fileSizeMB: r1(db.selectValue('PRAGMA page_count') * pageSize / MB),
    freelistPages: db.selectValue('PRAGMA freelist_count'),
    inodeRows: db.selectValue('SELECT count(*) FROM inodes'), chunkRows: db.selectValue('SELECT count(*) FROM chunks'),
    logicalPayloadMB: r1(db.selectValue('SELECT sum(length(data)) FROM chunks') / MB),
  };
  out.db.overheadFactor = Math.round(out.db.fileSizeMB / out.db.logicalPayloadMB * 100) / 100;
  fs.close();
  db.close();
  try { out.storageEstimateAfter = await navigator.storage.estimate(); } catch (e) { /* ignore */ }
  out.poolFileCount = pool.getFileCount();
  pool.unlink(dbName);
  return out;
};

// Cost of one transaction per file under different journal settings. WAL has no shared-memory
// support in the SAH pool VFS, so it is only reachable through locking_mode=EXCLUSIVE.
cmds.txModes = async ({ n = 1000 } = {}) => {
  const out = {};
  const modes = {
    'delete/NORMAL (default journal)': 'PRAGMA synchronous=NORMAL;',
    'delete/OFF': 'PRAGMA synchronous=OFF;',
    'truncate/NORMAL': 'PRAGMA journal_mode=TRUNCATE; PRAGMA synchronous=NORMAL;',
    'persist/NORMAL': 'PRAGMA journal_mode=PERSIST; PRAGMA synchronous=NORMAL;',
    'memory-journal/NORMAL (not crash safe)': 'PRAGMA journal_mode=MEMORY; PRAGMA synchronous=NORMAL;',
    'wal+exclusive/NORMAL': 'PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;',
    'wal+exclusive/FULL': 'PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;',
  };
  out.plainWalWithoutExclusive = (() => { try { pool.unlink('/txm.db'); } catch (e) { /* */ } const d = new pool.OpfsSAHPoolDb('/txm.db'); const r = d.selectValue('PRAGMA journal_mode=WAL'); d.close(); pool.unlink('/txm.db'); return 'PRAGMA journal_mode=WAL -> ' + r; })();
  for (const [label, pragmas] of Object.entries(modes)) {
    try { pool.unlink('/txm.db'); } catch (e) { /* */ }
    const db = new pool.OpfsSAHPoolDb('/txm.db');
    try {
      db.exec(pragmas);
      const fs = new ToyFs(db);
      db.exec('BEGIN'); fs.mkdir('/d'); db.exec('COMMIT');
      const t = performance.now();
      for (let i = 0; i < n; i++) { db.exec('BEGIN'); fs.writeFile('/d/f' + i, POOL.subarray(i * 3, i * 3 + 1024 + (i * 7919) % 3072)); db.exec('COMMIT'); }
      const ms = performance.now() - t;
      out[label] = { journalMode: db.selectValue('PRAGMA journal_mode'), filesPerSec: rate(n, ms), msPerTx: Math.round(ms / n * 1000) / 1000, rowsOk: db.selectValue('SELECT count(*) FROM inodes') === n + 2 };
      fs.close();
    } catch (e) { out[label] = { error: `${e.name}: ${e.message}` }; }
    db.close();
  }
  out.poolFilesAfter = pool.getFileNames();
  try { pool.unlink('/txm.db'); } catch (e) { /* */ }
  return out;
};

// ---------------- 4. persistence ----------------
cmds.persistWrite = async ({ token }) => {
  const db = openDb('/persist.db');
  db.exec('CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT)');
  db.exec({ sql: 'INSERT OR REPLACE INTO kv VALUES(?, ?)', bind: ['token-' + token, new Date().toISOString()] });
  const fs = new ToyFs(db);
  if (!fs.stat('/persisted')) fs.mkdir('/persisted');
  fs.writeFile('/persisted/' + token + '.txt', new TextEncoder().encode('hello ' + token));
  fs.close();
  db.close();
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle('raw-persist-' + token + '.txt', { create: true });
  const h = await fh.createSyncAccessHandle();
  h.write(new TextEncoder().encode('raw ' + token), { at: 0 }); h.flush(); h.close();
  return cmds.persistRead();
};
cmds.persistRead = async () => {
  const out = { kv: [], files: [], rawOpfs: (await cmds.listOpfs()).filter((n) => n.startsWith('raw-persist-')) };
  out.poolFiles = pool.getFileNames();
  if (!out.poolFiles.includes('/persist.db')) return out;
  const db = openDb('/persist.db');
  out.kv = db.selectValues('SELECT k FROM kv ORDER BY k');
  const fs = new ToyFs(db);
  out.files = (fs.readdir('/persisted') || []).map((e) => e.name + '=' + new TextDecoder().decode(fs.readFile('/persisted/' + e.name)));
  fs.close();
  db.close();
  return out;
};

// ---------------- 8. bridge: echo server on a port handed over by A ----------------
cmds.bridgePort = async (_args, ports) => {
  const port = ports[0];
  port.onmessage = (e) => {
    const d = e.data;
    if (d.buf) port.postMessage({ id: d.id, buf: d.buf }, [d.buf]);
    else port.postMessage({ id: d.id, v: d.v });
  };
  port.postMessage({ type: 'bridge-ready' });
  return true;
};

// ---------------- 6. preview "dev server" ----------------
const PREVIEW_FILES = {
  'index.html': '<!doctype html><meta charset="utf-8"><title>preview</title><div id="out">loading</div><script type="module" src="./main.js"></script>',
  'main.js': `
    const id = location.pathname.split('/')[2];
    const first = await (await fetch('./api/hello')).json();
    document.getElementById('out').textContent = JSON.stringify(first);
    const lat = [];
    for (let i = 0; i < 300; i++) { const t = performance.now(); const r = await fetch('./api/hello?i=' + i); await r.json(); lat.push(performance.now() - t); }
    const nav = performance.getEntriesByType('navigation')[0];
    let controlled = null; try { controlled = !!navigator.serviceWorker.controller; } catch (e) { controlled = 'throws ' + e.name; }
    let parentReach = null; try { parentReach = typeof parent.spike; } catch (e) { parentReach = 'throws ' + e.name; }
    let opfs = null; try { opfs = (await navigator.storage.getDirectory()).name === '' ? 'accessible' : 'accessible'; } catch (e) { opfs = 'throws ' + e.name; }
    parent.postMessage({ type: 'preview-result', id, kind: 'bench', first, lat, controlled, origin: self.origin, parentReach, opfs,
      nav: { responseStartMs: nav.responseStart, domContentLoadedMs: nav.domContentLoadedEventEnd, workerStartMs: nav.workerStart } }, '*');
  `,
  'egress.html': '<!doctype html><meta charset="utf-8"><title>preview egress</title><script src="/egress-lib.js"></script><script type="module" src="./egress-run.js"></script>',
  'egress-run.js': `
    const id = location.pathname.split('/')[2];
    const r = await runDocEgress('preview-' + id);
    parent.postMessage({ type: 'preview-result', id, kind: 'egress', r }, '*');
  `,
  'nav.html': '<!doctype html><meta charset="utf-8"><title>preview nav</title><script type="module" src="./nav.js"></script>',
  'nav.js': `
    const id = location.pathname.split('/')[2];
    const kind = new URLSearchParams(location.search).get('kind') || 'self-nav';
    const url = 'http://localhost:8103/hit/preview-' + id + '/' + kind;
    let r = 'scheduled';
    try {
      if (kind === 'self-nav') setTimeout(() => { location.href = url; }, 50);
      else if (kind === 'top-nav') { top.location.href = url; r = 'assigned'; }
      else if (kind === 'window-open') { r = window.open(url) ? 'opened' : 'returned null'; }
    } catch (e) { r = 'throws ' + e.name + ': ' + e.message; }
    parent.postMessage({ type: 'preview-result', id, kind: 'nav', r }, '*');
  `,
};
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json' };
let previewFs = null;
let previewDb = null;
let helloCount = 0;
const enc = new TextEncoder();
function servePreview(d) {
  const u = new URL(d.url);
  const rest = u.pathname.split('/').slice(3).join('/');
  if (rest.startsWith('api/hello')) {
    const body = enc.encode(JSON.stringify({ hello: 'from the kernel worker', n: ++helloCount, source: previewFs ? 'sqlite-fs' : 'memory' })).buffer;
    return { dir: 'res', id: d.id, status: 200, contentType: TYPES.json, body };
  }
  let bytes = null;
  if (previewFs) bytes = previewFs.readFile('/www/' + rest);
  else if (PREVIEW_FILES[rest] != null) bytes = enc.encode(PREVIEW_FILES[rest]);
  if (!bytes) return { dir: 'res', id: d.id, status: 404, contentType: 'text/plain', body: enc.encode('not found in kernel fs: ' + rest).buffer };
  const b = bytes.buffer.byteLength === bytes.length ? bytes.buffer : bytes.slice().buffer;
  return { dir: 'res', id: d.id, status: 200, contentType: TYPES[rest.split('.').pop()] || 'application/octet-stream', body: b };
}
let previewBc = null;
cmds.previewInit = async ({ useSqlite = true } = {}) => {
  if (useSqlite && pool && !previewFs) {
    // the preview files live in the SQLite toy filesystem, so each request includes a real FS read
    try { pool.unlink('/preview.db'); } catch (e) { /* */ }
    previewDb = openDb('/preview.db');
    previewFs = new ToyFs(previewDb);
    previewDb.exec('BEGIN');
    previewFs.mkdir('/www');
    for (const [name, text] of Object.entries(PREVIEW_FILES)) previewFs.writeFile('/www/' + name, enc.encode(text));
    previewDb.exec('COMMIT');
  }
  if (!previewBc) {
    previewBc = new BroadcastChannel('preview-rpc');
    previewBc.onmessage = (e) => { if (e.data.dir === 'req') previewBc.postMessage(servePreview(e.data)); };
  }
  return { source: previewFs ? 'sqlite-fs' : 'memory' };
};
cmds.previewPort = async (_args, ports) => {
  const port = ports[0];
  port.onmessage = (e) => { const r = servePreview(e.data); port.postMessage(r, [r.body]); };
  return true;
};

cmds.violations = async () => violations;

self.onmessage = async (e) => {
  const { id, cmd, args } = e.data;
  try {
    if (!cmds[cmd]) throw new Error('unknown command ' + cmd);
    const result = await cmds[cmd](args || {}, e.ports);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: `${err && err.name}: ${err && err.message}\n${err && err.stack}` });
  }
};
