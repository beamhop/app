// Build: (1) bundle the emulation layer + worker into dist/web, (2) pack each installed harness, unmodified,
// into a file-system image, and (3) precompile the ESM files a harness can reach to System.register form
// (stored beside the files in the image as a compile cache; the original files stay byte-identical).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { VFS } from '../src/runtime/vfs.js';
import { createLoader } from '../src/runtime/loader.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist'), web = path.join(dist, 'web'), cacheDir = path.join(dist, 'esm-cache');
fs.mkdirSync(web, { recursive: true }); fs.mkdirSync(cacheDir, { recursive: true });
const only = process.argv.slice(2);

// ---------- 1. runtime bundle ----------
const t0 = Date.now();
const r = await esbuild.build({
  entryPoints: [path.join(root, 'src/worker.js')], outfile: path.join(web, 'worker.js'), bundle: true, format: 'iife', platform: 'browser', target: 'es2022', minify: false, metafile: true, legalComments: 'none',
  plugins: [{ name: 'spike-aliases', setup(b) {
    b.onResolve({ filter: /^process\/?$/ }, () => ({ path: path.join(root, 'src/runtime/process-shim.js') }));
    b.onResolve({ filter: /^node:zlib$/ }, () => ({ path: path.join(root, 'src/runtime/zlib-for-bash.js') }));
  } }],
  inject: [path.join(root, 'src/runtime/inject-process.js')],
  define: { global: 'globalThis' },
  logLevel: 'warning',
});
fs.copyFileSync(path.join(root, 'node_modules/ses/dist/ses.umd.js'), path.join(web, 'ses.umd.js'));
// SES patch: overrideTaming:'severe' has no entry for generator objects, and pi (via the OpenAI SDK stream code it
// bundles) assigns `.return` on an async generator. SES has no public API to add enablements, so the spike ships a
// copy of ses.umd.js with two extra lines in its severe enablement table.
{
  const src = fs.readFileSync(path.join(root, 'node_modules/ses/dist/ses.umd.js'), 'utf8');
  const anchor = "  '%ObjectPrototype%': '*',\n";
  if (src.split(anchor).length !== 2) throw new Error('ses patch anchor not found exactly once');
  fs.writeFileSync(path.join(web, 'ses.patched.umd.js'), src.replace(anchor, anchor + "  '%AsyncGeneratorPrototype%': '*',\n  '%GeneratorPrototype%': '*',\n"));
}
fs.copyFileSync(path.join(root, 'src/page.html'), path.join(web, 'index.html'));
fs.copyFileSync(path.join(root, 'src/page.js'), path.join(web, 'page.js'));
const bundled = {};
for (const [file, info] of Object.entries(r.metafile.inputs)) { const m = file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/); const k = m ? m[1] : '(spike source)'; bundled[k] = (bundled[k] || 0) + info.bytes; }
console.error(`[build] runtime bundle ${(fs.statSync(path.join(web, 'worker.js')).size / 1e6).toFixed(2)} MB in ${Date.now() - t0} ms`);

// ---------- 2 + 3. images ----------
const HARNESSES = {
  pi: { dir: 'harnesses/pi', mount: '/opt/pi', entries: ['node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'], precompileDirs: ['node_modules/@earendil-works/pi-coding-agent/dist/bundle'] },
  // gemini: the bundle directory holds several generations of 17 MB chunks; only the import closure of the entry is precompiled.
  gemini: { dir: 'harnesses/gemini', mount: '/opt/gemini', entries: ['node_modules/@google/gemini-cli/bundle/gemini.js'], precompileDirs: [] },
  // claude: @anthropic-ai/claude-code@latest is a native-binary launcher; 2.1.112 is the last release that shipped cli.js.
  claude: { dir: 'harnesses/claude-js', mount: '/opt/claude', entries: ['node_modules/@anthropic-ai/claude-code/cli.js'], precompileDirs: [] },
};
const EXCLUDE = [/\.map$/, /\.d\.[mc]?ts$/, /\.tsbuildinfo$/, /(^|\/)\.package-lock\.json$/];
const MAX_FILE = 30 * 1024 * 1024;

class Pool {
  constructor(n) { this.idle = []; this.queue = []; this.pending = new Map(); this.id = 0; this.workers = Array.from({ length: n }, () => { const w = new Worker(new URL('./babel-worker.mjs', import.meta.url)); w.on('message', (m) => { const p = this.pending.get(m.id); this.pending.delete(m.id); this.idle.push(w); this._next(); m.error ? p.reject(new Error(m.error)) : p.resolve(m.code); }); this.idle.push(w); return w; }); }
  run(code, filename) { return new Promise((resolve, reject) => { this.queue.push({ code, filename, resolve, reject }); this._next(); }); }
  _next() { while (this.idle.length && this.queue.length) { const w = this.idle.pop(), job = this.queue.shift(), id = ++this.id; this.pending.set(id, job); w.postMessage({ id, code: job.code, filename: job.filename }); } }
  close() { for (const w of this.workers) w.terminate(); }
}
const pool = new Pool(4);
const BABEL_VERSION = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@babel/core/package.json'), 'utf8')).version;
async function toSystem(code, filename, stat) {
  const key = crypto.createHash('sha1').update(BABEL_VERSION + '\0v2\0' + code).digest('hex');
  const file = path.join(cacheDir, key + '.js');
  if (fs.existsSync(file)) { stat.cached++; return fs.readFileSync(file, 'utf8'); }
  const t = Date.now();
  const out = await pool.run(code, filename);
  stat.transformed++; stat.transformMs += Date.now() - t;
  fs.writeFileSync(file, out);
  return out;
}

async function buildImage(name, spec) {
  const t1 = Date.now();
  const srcRoot = path.join(root, spec.dir);
  if (!fs.existsSync(path.join(srcRoot, 'node_modules'))) { console.error(`[build] ${name}: not installed, skipping`); return null; }
  const files = [], links = [], dirs = [], excluded = { byPattern: 0, bytesByPattern: 0, tooBig: [] };
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name), r = rel + '/' + e.name;
      if (e.isSymbolicLink()) links.push([r, fs.readlinkSync(abs)]);
      else if (e.isDirectory()) { dirs.push(r); walk(abs, r); }
      else if (e.isFile()) {
        const st = fs.statSync(abs);
        if (EXCLUDE.some((re) => re.test(r))) { excluded.byPattern++; excluded.bytesByPattern += st.size; continue; }
        if (st.size > MAX_FILE) { excluded.tooBig.push({ path: r, bytes: st.size }); continue; }
        files.push({ rel: r, abs, size: st.size, mode: st.mode & 0o777 });
      }
    }
  };
  for (const top of ['node_modules', 'package.json']) { const abs = path.join(srcRoot, top); if (!fs.existsSync(abs)) continue; if (fs.statSync(abs).isDirectory()) { dirs.push('/' + top); walk(abs, '/' + top); } else files.push({ rel: '/' + top, abs, size: fs.statSync(abs).size, mode: 0o644 }); }

  // Load into a VFS (same class the worker uses) so the build-time tracer resolves exactly like the runtime.
  const vfs = new VFS();
  for (const d of dirs) vfs.mkdir(spec.mount + d, { recursive: true });
  for (const f of files) { f.data = fs.readFileSync(f.abs); vfs.writeFile(spec.mount + f.rel, f.data, { mode: f.mode }); }
  for (const [p, target] of links) { try { vfs.symlink(target, spec.mount + p); } catch {} }
  const esmCache = new Map();
  const builtinNames = ['assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'dns/promises', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'readline/promises', 'repl', 'stream', 'stream/promises', 'stream/web', 'string_decoder', 'sys', 'timers', 'timers/promises', 'tls', 'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib', 'sqlite', 'test', 'sea'];
  const loader = createLoader({ vfs, esmCache, builtins: Object.fromEntries(builtinNames.map((n) => [n, {}])), process: { cwd: () => spec.mount }, evaluate: () => { throw new Error('no eval at build time'); }, globalsForModules: {}, track: () => {}, path: path.posix });
  const isEsmFile = (p) => {
    if (p.endsWith('.mjs')) return true;
    if (!p.endsWith('.js')) return false;
    for (let d = path.posix.dirname(p); ; d = path.posix.dirname(d)) { const n = vfs.tryLookup(d + '/package.json'); if (n) { try { return JSON.parse(Buffer.from(n.data).toString()).type === 'module'; } catch { return false; } } if (d === '/' || d.endsWith('/node_modules')) return false; }
  };
  const stat = { cached: 0, transformed: 0, transformMs: 0, failed: [], unresolved: [] };
  const done = new Set(), queue = [];
  const enqueue = (p) => { if (!done.has(p)) { done.add(p); queue.push(p); } };
  for (const e of spec.entries) enqueue(vfs.realpath(spec.mount + '/' + e));
  for (const d of spec.precompileDirs) for (const f of files) if (f.rel.startsWith('/' + d + '/') && /\.m?js$/.test(f.rel) && isEsmFile(spec.mount + f.rel)) enqueue(spec.mount + f.rel);
  const active = new Set();
  const handle = async (p) => {
    if (!isEsmFile(p)) return;
    const src = Buffer.from(vfs.readFile(p)).toString('utf8');
    let out;
    try { out = await toSystem(src, p, stat); } catch (e) { stat.failed.push({ file: p, error: e.message }); return; }
    esmCache.set(p, Buffer.from(out));
    // trace static deps (System.register dependency array) and string-literal dynamic imports
    const m = out.match(/^System\.register\((\[[^\]]*\])/);
    const deps = m ? JSON.parse(m[1]) : [];
    for (const dm of out.matchAll(/_context\.import\((["'])([^"'\\]+)\1\)/g)) deps.push(dm[2]);
    for (const spec2 of deps) {
      try { const res = loader.resolve(spec2, p, true); if (res.file) enqueue(res.file); } catch (e) { if (e.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') stat.unresolved.push({ from: p.replace(spec.mount, ''), spec: spec2 }); }
    }
  };
  while (queue.length || active.size) {
    while (queue.length) { const p = queue.shift(); const job = handle(p).finally(() => active.delete(job)); active.add(job); }
    if (active.size) await Promise.race(active);
  }

  // Serialize.
  const header = { meta: { name, mount: spec.mount, builtAt: new Date().toISOString() }, dirs: dirs.map((d) => spec.mount + d), files: [], links: links.map(([p, t]) => [spec.mount + p, t]), esm: {} };
  const chunks = []; let off = 0;
  for (const f of files) { header.files.push([spec.mount + f.rel, off, f.data.length, f.mode]); chunks.push(f.data); off += f.data.length; }
  const fileBytes = off;
  for (const [p, data] of esmCache) { header.esm[p] = [off, data.length]; chunks.push(data); off += data.length; }
  const headerBuf = Buffer.from(JSON.stringify(header));
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32LE(headerBuf.length);
  const image = Buffer.concat([lenBuf, headerBuf, ...chunks]);
  const outFile = path.join(web, name + '.img');
  fs.writeFileSync(outFile, image);
  const gz = zlib.gzipSync(image, { level: 6 });
  fs.writeFileSync(outFile + '.gz', gz);
  const info = { name, mount: spec.mount, files: files.length, dirs: dirs.length, symlinks: links.length, fileBytes, esmPrecompiled: esmCache.size, esmPrecompiledBytes: off - fileBytes, imageBytes: image.length, imageGzipBytes: gz.length, excluded: { sourceMapsAndTypeDecls: excluded.byPattern, sourceMapsAndTypeDeclsBytes: excluded.bytesByPattern, largerThan30MB: excluded.tooBig }, babel: { transformed: stat.transformed, fromCache: stat.cached, transformMs: stat.transformMs, failed: stat.failed, unresolvedSpecifiers: stat.unresolved.slice(0, 40), unresolvedCount: stat.unresolved.length }, buildMs: Date.now() - t1 };
  console.error(`[build] ${name}: ${info.files} files, ${(image.length / 1e6).toFixed(1)} MB (${(gz.length / 1e6).toFixed(1)} MB gzip), ${esmCache.size} ESM precompiled (${stat.transformed} transformed, ${stat.cached} cached), ${info.buildMs} ms`);
  return info;
}

const manifestFile = path.join(dist, 'build-manifest.json');
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { images: {} };
manifest.runtime = { workerJsBytes: fs.statSync(path.join(web, 'worker.js')).size, workerJsGzipBytes: zlib.gzipSync(fs.readFileSync(path.join(web, 'worker.js'))).length, sesBytes: fs.statSync(path.join(web, 'ses.umd.js')).size, bundledInputBytesByPackage: bundled };
for (const [name, spec] of Object.entries(HARNESSES)) {
  if (only.length && !only.includes(name)) continue;
  const info = await buildImage(name, spec);
  if (info) manifest.images[name] = info;
}
pool.close();
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
