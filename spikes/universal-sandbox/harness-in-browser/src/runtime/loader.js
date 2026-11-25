// CommonJS + ESM loader over the VFS.
// CJS: classic function wrapper. ESM: files are pre-transformed (build machine, Babel) to System.register
// format and shipped beside the image as a compile cache keyed by path; this loader implements the
// System.register linking protocol (live bindings, cycles, top-level await, dynamic import, import.meta).
import { Buffer } from 'buffer';

const decoder = new TextDecoder();

// Identifiers shadowed inside every module so a worker global never leaks into "Node" code.
const SHADOWED = ['self', 'window', 'document', 'importScripts', 'WorkerGlobalScope', 'DedicatedWorkerGlobalScope', 'location', 'postMessage', 'onmessage', 'close'];

export function createLoader({ vfs, esmCache, builtins, process, evaluate, globalsForModules, track, path, debugPatches }) {
  const cjsCache = Object.create(null); // filename -> module
  const esmRecords = new Map(); // filename -> record
  const pkgCache = new Map();
  const stats = { cjs: 0, esm: 0, json: 0, evalMs: 0, evalBytes: 0, missingEsm: [] };
  const shadowNames = SHADOWED.filter((n) => !(n in globalsForModules));
  const injectedNames = Object.keys(globalsForModules);
  const injectedValues = injectedNames.map((n) => globalsForModules[n]);

  const isBuiltin = (id) => { if (id.startsWith('node:')) id = id.slice(5); return Object.prototype.hasOwnProperty.call(builtins, id); };
  function getBuiltin(id) {
    const name = id.startsWith('node:') ? id.slice(5) : id;
    if (!Object.prototype.hasOwnProperty.call(builtins, name)) return undefined;
    let v = builtins[name];
    if (typeof v === 'function' && v.__lazyBuiltin) { v = v(); builtins[name] = v; }
    return v;
  }

  // ---------- resolution ----------
  const statKind = (p) => { const n = vfs.tryLookup(p); return n ? n.kind : null; };
  function readPkg(dir) {
    const file = dir + '/package.json';
    if (pkgCache.has(file)) return pkgCache.get(file);
    let pkg = null;
    const node = vfs.tryLookup(file);
    if (node && node.kind === 'file') { try { pkg = JSON.parse(decoder.decode(node.data)); } catch { pkg = {}; } }
    pkgCache.set(file, pkg);
    return pkg;
  }
  function findPkgScope(file) {
    let dir = path.dirname(file);
    for (;;) {
      const pkg = readPkg(dir === '/' ? '' : dir);
      if (pkg) return { dir, pkg };
      if (dir === '/') return null;
      if (dir.endsWith('/node_modules')) return null;
      dir = path.dirname(dir);
    }
  }
  function resolveTarget(target, conditions, subpathMatch) {
    if (typeof target === 'string') return subpathMatch != null ? target.replace(/\*/g, subpathMatch) : target;
    if (Array.isArray(target)) { for (const t of target) { const r = resolveTarget(t, conditions, subpathMatch); if (r) return r; } return null; }
    if (target && typeof target === 'object') {
      for (const key of Object.keys(target)) {
        if (key === 'default' || conditions.includes(key)) { const r = resolveTarget(target[key], conditions, subpathMatch); if (r) return r; }
      }
    }
    return null;
  }
  function resolveExportsMap(map, subpath, conditions) {
    if (typeof map === 'string' || Array.isArray(map) || (map && !Object.keys(map).some((k) => k.startsWith('.') || k.startsWith('#')))) map = { '.': map };
    if (Object.prototype.hasOwnProperty.call(map, subpath)) return resolveTarget(map[subpath], conditions);
    let best = null, bestMatch = null;
    for (const key of Object.keys(map)) {
      const star = key.indexOf('*');
      if (star === -1) { if (key.endsWith('/') && subpath.startsWith(key) && (!best || key.length > best.length)) { best = key; bestMatch = subpath.slice(key.length); } continue; }
      const pre = key.slice(0, star), post = key.slice(star + 1);
      if (subpath.startsWith(pre) && subpath.endsWith(post) && subpath.length >= key.length - 1 && (!best || pre.length > best.indexOf('*'))) { best = key; bestMatch = subpath.slice(pre.length, subpath.length - post.length); }
    }
    if (!best) return null;
    if (best.endsWith('/')) { const t = resolveTarget(map[best], conditions); return t ? t + bestMatch : null; }
    return resolveTarget(map[best], conditions, bestMatch);
  }
  const EXTS = ['.js', '.json', '.node', '.cjs', '.mjs'];
  function tryFile(p) {
    if (statKind(p) === 'file') return p;
    for (const ext of EXTS) if (statKind(p + ext) === 'file') return p + ext;
    return null;
  }
  function tryDir(p) {
    if (statKind(p) !== 'dir') return null;
    const pkg = readPkg(p);
    if (pkg && pkg.main) { const m = tryFile(path.join(p, pkg.main)) || tryFile(path.join(p, pkg.main, 'index')); if (m) return m; }
    return tryFile(p + '/index');
  }
  function notFound(spec, parent, extra = '') {
    const e = new Error(`Cannot find module '${spec}'${extra}\nRequire stack:\n- ${parent}`);
    e.code = 'MODULE_NOT_FOUND';
    return e;
  }
  function resolve(spec, parent, isImport) {
    if (isBuiltin(spec)) return { builtin: spec };
    if (spec.startsWith('node:')) { const e = new Error(`No such built-in module: ${spec}`); e.code = 'ERR_UNKNOWN_BUILTIN_MODULE'; track('unknown-builtin', spec); throw e; }
    const conditions = isImport ? ['node', 'import', 'module-sync', 'node-addons'] : ['node', 'require', 'module-sync', 'node-addons'];
    if (spec.startsWith('file:')) spec = decodeURIComponent(new URL(spec).pathname);
    const parentDir = parent ? path.dirname(parent) : process.cwd();
    if (spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
      const abs = spec.startsWith('/') ? path.normalize(spec) : path.join(parentDir, spec);
      const r = tryFile(abs) || tryDir(abs);
      if (!r) throw notFound(spec, parent);
      return { file: vfs.realpath(r) };
    }
    if (spec.startsWith('#')) {
      const scope = findPkgScope(parent);
      const target = scope && scope.pkg.imports && resolveExportsMap(scope.pkg.imports, spec, conditions);
      if (!target) throw notFound(spec, parent, ' (package imports)');
      if (!target.startsWith('.')) return resolve(target, parent, isImport);
      return { file: vfs.realpath(path.join(scope.dir, target)) };
    }
    const parts = spec.split('/');
    const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const sub = '.' + spec.slice(pkgName.length);
    // self reference
    const scope = parent && findPkgScope(parent);
    const candidates = [];
    if (scope && scope.pkg.name === pkgName && scope.pkg.exports) candidates.push(scope.dir);
    for (let dir = parentDir; ; dir = path.dirname(dir)) {
      if (!dir.endsWith('/node_modules')) candidates.push((dir === '/' ? '' : dir) + '/node_modules/' + pkgName);
      if (dir === '/') break;
    }
    for (const pkgDir of candidates) {
      if (statKind(pkgDir) !== 'dir') continue;
      const pkg = readPkg(pkgDir) || {};
      if (pkg.exports != null) {
        const target = resolveExportsMap(pkg.exports, sub, conditions);
        if (!target) { const e = new Error(`Package subpath '${sub}' is not defined by "exports" in ${pkgDir}/package.json (imported from ${parent})`); e.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED'; throw e; }
        const f = path.join(pkgDir, target);
        if (statKind(f) !== 'file') throw notFound(spec, parent, ` (exports target ${f} missing)`);
        return { file: vfs.realpath(f) };
      }
      const abs = sub === '.' ? pkgDir : path.join(pkgDir, sub);
      let r = sub === '.' ? null : tryFile(abs);
      if (!r && sub === '.' && isImport && pkg.module && false) r = tryFile(path.join(pkgDir, pkg.module));
      r = r || tryDir(abs);
      if (r) return { file: vfs.realpath(r) };
    }
    throw notFound(spec, parent);
  }

  // ---------- format detection ----------
  function formatOf(file) {
    if (file.endsWith('.mjs')) return 'esm';
    if (file.endsWith('.cjs')) return 'cjs';
    if (file.endsWith('.json')) return 'json';
    if (file.endsWith('.node')) return 'addon';
    if (file.endsWith('.wasm')) return 'wasm';
    const scope = findPkgScope(file);
    if (scope && scope.pkg.type === 'module') return 'esm';
    if (esmCache.has(file) && !(scope && scope.pkg.type === 'commonjs')) return 'esm'; // build-time syntax detection for ambiguous .js
    return 'cjs';
  }
  const readText = (file) => decoder.decode(vfs.readFile(file));
  function timedEval(code, file) {
    const t = performance.now();
    try { return evaluate(code, file); } finally { stats.evalMs += performance.now() - t; stats.evalBytes += code.length; }
  }
  const wrapperParams = [...shadowNames, ...injectedNames].join(', ');
  const shadowArgs = shadowNames.map(() => undefined);

  // ---------- CommonJS ----------
  class Module {
    constructor(id, parent) { this.id = id; this.filename = id; this.path = path.dirname(id); this.exports = {}; this.loaded = false; this.children = []; this.parent = parent || null; this.paths = nodeModulePaths(this.path); }
    require(spec) { return makeRequire(this)(spec); }
  }
  function nodeModulePaths(dir) { const out = []; for (let d = dir; ; d = path.dirname(d)) { if (!d.endsWith('/node_modules')) out.push((d === '/' ? '' : d) + '/node_modules'); if (d === '/') break; } return out; }
  function dynamicImportFrom(parentFile) {
    return (spec, attrs) => new Promise((res) => res()).then(() => importModule(String(spec), parentFile));
  }
  function makeRequire(mod) {
    const require = (spec) => {
      if (typeof spec !== 'string') { const e = new TypeError('The "id" argument must be of type string. Received ' + typeof spec); e.code = 'ERR_INVALID_ARG_TYPE'; throw e; }
      const r = resolve(spec, mod.filename, false);
      if (r.builtin) return getBuiltin(r.builtin);
      return loadFile(r.file, mod);
    };
    require.resolve = Object.assign((spec, opts) => { const r = resolve(spec, mod.filename, false); return r.builtin || r.file; }, { paths: (spec) => nodeModulePaths(mod.path) });
    require.cache = cjsCache;
    require.main = mainModule;
    require.extensions = { '.js': () => {}, '.json': () => {}, '.node': () => {} };
    return require;
  }
  let mainModule = null;
  function loadFile(file, parent) {
    const cached = cjsCache[file];
    if (cached) return cached.exports;
    const format = formatOf(file);
    if (format === 'esm') {
      const rec = loadEsm(file);
      const p = execEsm(rec, new Set());
      if (p) { p.catch(() => {}); const e = new Error(`require() cannot be used on an ESM graph with top-level await: ${file}`); e.code = 'ERR_REQUIRE_ASYNC_MODULE'; throw e; }
      return 'module.exports' in rec.ns ? rec.ns['module.exports'] : rec.ns;
    }
    if (format === 'addon') { track('native-addon', file); const e = new Error(`Cannot load native addon in the browser: ${file}`); e.code = 'ERR_DLOPEN_FAILED'; throw e; }
    const mod = new Module(file, parent);
    cjsCache[file] = mod;
    if (parent) parent.children.push(mod);
    try {
      if (format === 'json') { stats.json++; mod.exports = JSON.parse(readText(file)); }
      else {
        stats.cjs++;
        let src = readText(file);
        if (src.startsWith('#!')) src = '//' + src;
        if (src.includes('import(')) src = src.replace(/(^|[^.\w$])import\s*\(/g, '$1__dynamicImport(');
        const fn = timedEval(`(function (exports, require, module, __filename, __dirname, __dynamicImport, ${wrapperParams}) {${src}\n})`, file);
        fn.call(mod.exports, mod.exports, makeRequire(mod), mod, file, path.dirname(file), dynamicImportFrom(file), ...shadowArgs, ...injectedValues);
      }
      mod.loaded = true;
    } catch (e) { delete cjsCache[file]; throw e; }
    return mod.exports;
  }

  // ---------- ESM (System.register records) ----------
  const NEW = 0, LINKED = 1, EXECUTING = 2, DONE = 3, FAILED = 4;
  function makeNs() { const ns = Object.create(null); Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' }); return ns; }
  function syntheticNs(value) {
    const ns = makeNs();
    if (value != null && (typeof value === 'object' || typeof value === 'function')) {
      for (const key in value) { if (key !== 'default') { try { ns[key] = value[key]; } catch {} } }
      for (const key of Object.getOwnPropertyNames(value)) { if (key !== 'default' && !(key in ns) && !['length', 'name', 'prototype', 'caller', 'arguments'].includes(key)) { try { ns[key] = value[key]; } catch {} } }
      if (value.__esModule && 'default' in value && false) ns.default = value.default;
    }
    ns.default = value;
    return ns;
  }
  function loadEsm(file) {
    let rec = esmRecords.get(file);
    if (rec) return rec;
    const cached = esmCache.get(file);
    if (!cached) {
      stats.missingEsm.push(file);
      throw new Error(`ESM file has no precompiled System.register form in the image and there is no in-worker transformer: ${file}`);
    }
    stats.esm++;
    rec = { file, kind: 'esm', ns: makeNs(), state: NEW, deps: [], depRecs: [], setters: [], execute: null, importers: [], error: null, promise: null };
    esmRecords.set(file, rec);
    const url = 'file://' + file;
    const meta = { url, filename: file, dirname: path.dirname(file), resolve: (spec) => { const r = resolve(spec, file, true); return r.builtin ? (r.builtin.startsWith('node:') ? r.builtin : 'node:' + r.builtin) : 'file://' + r.file; }, main: false };
    const _export = (name, value) => {
      if (typeof name === 'object' && name !== null) { for (const k of Object.keys(name)) rec.ns[k] = name[k]; }
      else rec.ns[name] = value;
      for (const imp of rec.importers) imp.setter && imp.setter(rec.ns);
      return value;
    };
    const _context = { id: url, meta, import: (spec) => dynamicImportFrom(file)(spec) };
    let declared = false;
    const System = { register(deps, declare) { declared = true; rec.deps = deps; const d = declare(_export, _context); rec.setters = d.setters || []; rec.execute = d.execute || (() => {}); } };
    let code = decoder.decode(cached);
    if (debugPatches) for (const [suffix, from, to] of debugPatches) if (file.endsWith(suffix)) code = code.split(from).join(to); // development aid only; never set by the spike runner
    const fn = timedEval(`(function (System, require, ${wrapperParams}) {${code}\n})`, file);
    // `require` is not defined in ESM; bundles that need it create their own via createRequire.
    fn.call(undefined, System, undefined, ...shadowArgs, ...injectedValues);
    if (!declared) throw new Error('precompiled ESM did not call System.register: ' + file);
    rec.state = LINKED;
    rec.depRecs = rec.deps.map((spec, i) => {
      const r = resolve(spec, file, true);
      let dep;
      if (r.builtin) dep = builtinRecord(r.builtin);
      else if (formatOf(r.file) === 'esm') dep = loadEsm(r.file);
      else dep = cjsRecord(r.file);
      const setter = rec.setters[i];
      if (dep.kind === 'esm') { dep.importers.push({ setter }); setter && setter(dep.ns); }
      return dep;
    });
    return rec;
  }
  const syntheticRecords = new Map();
  function builtinRecord(id) {
    const key = 'builtin:' + (id.startsWith('node:') ? id.slice(5) : id);
    let rec = syntheticRecords.get(key);
    if (!rec) { rec = { kind: 'builtin', file: key, ns: syntheticNs(getBuiltin(id)), state: DONE }; syntheticRecords.set(key, rec); }
    return rec;
  }
  function cjsRecord(file) {
    let rec = syntheticRecords.get(file);
    if (!rec) { rec = { kind: 'cjs', file, ns: null, state: LINKED }; syntheticRecords.set(file, rec); }
    return rec;
  }
  // Returns undefined when finished synchronously, or a Promise (top-level await somewhere in the graph).
  function execEsm(rec, stack) {
    if (rec.state === DONE) return undefined;
    if (rec.state === FAILED) throw rec.error;
    if (rec.kind === 'cjs') {
      try { rec.ns = syntheticNs(loadFile(rec.file, null)); rec.state = DONE; } catch (e) { if (!cjsCache[rec.file]) { rec.state = LINKED; } throw e; }
      return undefined;
    }
    if (rec.state === EXECUTING) return stack.has(rec) ? undefined : rec.promise || undefined;
    rec.state = EXECUTING;
    stack.add(rec);
    let i = 0;
    const fail = (e) => { rec.state = FAILED; rec.error = e; throw e; };
    const step = () => {
      while (i < rec.depRecs.length) {
        const idx = i++, dep = rec.depRecs[idx];
        const r = execEsm(dep, stack);
        const after = () => { if (dep.kind !== 'esm' || true) { const s = rec.setters[idx]; s && dep.ns && s(dep.ns); } };
        if (r) return r.then(() => { after(); return step(); });
        after();
      }
      const r = rec.execute.call(undefined);
      if (r && typeof r.then === 'function') return r.then(() => { rec.state = DONE; });
      rec.state = DONE;
      return undefined;
    };
    let r;
    try { r = step(); } catch (e) { fail(e); }
    if (r) { rec.promise = r.then(() => { rec.promise = null; }, fail); return rec.promise; }
    return undefined;
  }
  function importModule(spec, parentFile) {
    const r = resolve(spec, parentFile, true);
    if (r.builtin) return Promise.resolve(builtinRecord(r.builtin).ns);
    const format = formatOf(r.file);
    if (format !== 'esm') { const rec = cjsRecord(r.file); execEsm(rec, new Set()); return Promise.resolve(rec.ns); }
    const rec = loadEsm(r.file);
    const p = execEsm(rec, new Set());
    return p ? p.then(() => rec.ns) : Promise.resolve(rec.ns);
  }

  // ---------- node:module ----------
  function createRequire(from) {
    let file = typeof from === 'string' ? from : String(from);
    if (file.startsWith('file:')) file = decodeURIComponent(new URL(file).pathname);
    const mod = new Module(file, null);
    return makeRequire(mod);
  }
  const moduleBuiltin = Object.assign(Module, {
    Module, createRequire, isBuiltin,
    builtinModules: Object.keys(builtins).filter((k) => !k.startsWith('_')),
    enableCompileCache: () => ({ status: 3 /* DISABLED */ }), getCompileCacheDir: () => undefined, flushCompileCache: () => {},
    constants: { compileCacheStatus: { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 } },
    register: () => { track('module.register'); }, registerHooks: () => { track('module.registerHooks'); return { deregister() {} }; },
    syncBuiltinESMExports: () => {}, findSourceMap: () => undefined, SourceMap: class SourceMap {},
    findPackageJSON: (spec, base) => { const s = findPkgScope(typeof base === 'string' && base.startsWith('file:') ? decodeURIComponent(new URL(base).pathname) : String(base || process.cwd() + '/x')); return s ? s.dir + '/package.json' : undefined; },
    stripTypeScriptTypes: () => { throw new Error('module.stripTypeScriptTypes is not available in the emulation layer'); },
    wrap: (src) => `(function (exports, require, module, __filename, __dirname) { ${src}\n});`,
    _cache: cjsCache, _extensions: { '.js': () => {}, '.json': () => {}, '.node': () => {} }, _pathCache: {},
    _nodeModulePaths: nodeModulePaths,
    _resolveFilename: (spec, parent) => { const r = resolve(spec, parent && parent.filename, false); return r.builtin || r.file; },
    _load: (spec, parent) => { const r = resolve(spec, parent && parent.filename, false); return r.builtin ? getBuiltin(r.builtin) : loadFile(r.file, parent); },
    runMain: () => {},
  });

  return {
    stats, resolve, getBuiltin, isBuiltin, moduleBuiltin, createRequire, importModule,
    // Run a program the way `node file` would. Returns a promise for the entry module's evaluation.
    runMain(file) {
      const real = vfs.realpath(file);
      if (formatOf(real) === 'esm') { return importModule(real, real); }
      mainModule = new Module(real, null);
      loadFile(real, null);
      return Promise.resolve();
    },
  };
}
