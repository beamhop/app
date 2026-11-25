// Fake synchronous "kernel" that lives in the same dedicated worker as the guest.
// Classic script, loaded with importScripts() in both modes (plain and SES).
// Everything here is trusted code; guest code only ever sees what makeGuest() endows.
'use strict';
(function () {
  const real = {
    setTimeout: self.setTimeout.bind(self),
    clearTimeout: self.clearTimeout.bind(self),
    setInterval: self.setInterval.bind(self),
    clearInterval: self.clearInterval.bind(self),
    queueMicrotask: self.queueMicrotask.bind(self),
    now: () => performance.now(),
    crypto: self.crypto,
  };
  const indirectEval = (0, eval);

  // ---------------------------------------------------------------- path utils
  function norm(p) {
    const abs = p.charCodeAt(0) === 47;
    const out = [];
    for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') out.pop();
      else out.push(seg);
    }
    return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
  }
  function dirname(p) {
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }
  function join(a, b) { return norm(a + '/' + b); }

  // ------------------------------------------------------------------- fake fs
  function makeFs(image) {
    const files = new Map();
    const dirs = new Map([['/', new Set()]]);
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    function addDirs(p) {
      let child = p;
      for (;;) {
        const d = dirname(child);
        let set = dirs.get(d);
        if (!set) { set = new Set(); dirs.set(d, set); }
        const name = child.slice(d === '/' ? 1 : d.length + 1);
        if (set.has(name)) break;
        set.add(name);
        if (d === '/') break;
        child = d;
      }
    }
    for (const k of Object.keys(image.files)) { files.set(k, image.files[k]); addDirs(k); }
    function enoent(op, p) {
      const e = new Error(`ENOENT: no such file or directory, ${op} '${p}'`);
      e.code = 'ENOENT'; e.errno = -2; e.syscall = op; e.path = p;
      return e;
    }
    const abs = (p) => norm(String(p).charCodeAt(0) === 47 ? String(p) : '/app/' + p);
    const fs = {
      readFileSync(p, options) {
        const path = abs(p);
        const v = files.get(path);
        if (v === undefined) throw enoent('open', path);
        const encoding = typeof options === 'string' ? options : options && options.encoding;
        if (encoding) return typeof v === 'string' ? v : dec.decode(v);
        return typeof v === 'string' ? enc.encode(v) : v.slice();
      },
      writeFileSync(p, data) {
        const path = abs(p);
        if (dirs.has(path)) { const e = new Error(`EISDIR: illegal operation on a directory, open '${path}'`); e.code = 'EISDIR'; throw e; }
        if (!dirs.has(dirname(path))) throw enoent('open', path);
        files.set(path, typeof data === 'string' ? data : new Uint8Array(data));
        addDirs(path);
      },
      mkdirSync(p) { const path = abs(p); if (!dirs.has(path)) { dirs.set(path, new Set()); addDirs(path); } },
      existsSync(p) { const path = abs(p); return files.has(path) || dirs.has(path); },
      readdirSync(p) {
        const path = abs(p);
        const set = dirs.get(path);
        if (!set) throw enoent('scandir', path);
        return [...set].sort();
      },
      statSync(p) {
        const path = abs(p);
        const isDir = dirs.has(path);
        const v = files.get(path);
        if (!isDir && v === undefined) throw enoent('stat', path);
        const size = isDir ? 0 : v.length;
        return { size, mtimeMs: 0, mode: isDir ? 0o40755 : 0o100644, isFile: () => !isDir, isDirectory: () => isDir, isSymbolicLink: () => false };
      },
    };
    // fast paths for the module loader (kernel internal, never endowed)
    const internal = {
      isFile: (p) => files.has(p),
      isDir: (p) => dirs.has(p),
      read: (p) => { const v = files.get(p); return typeof v === 'string' ? v : v === undefined ? undefined : dec.decode(v); },
      fileCount: () => files.size,
    };
    return { fs, internal, cjs: new Map(Object.entries(image.cjs || {})) };
  }

  // ------------------------------------------------- CommonJS loader over the fs
  const CORE_FILES = {
    path: '/node_modules/path-browserify/index.js',
    util: '/node_modules/util/util.js',
    events: '/node_modules/events/events.js',
    assert: '/node_modules/assert/build/assert.js',
    buffer: '/node_modules/buffer/index.js',
    os: '/app/core-os.js',
    tty: '/app/core-tty.js',
    url: '/app/core-url.js',
    timers: '/app/core-timers.js',
  };
  const EXTS = ['.js', '.cjs', '.mjs', '.json'];

  function makeRequire({ vfs, cjs, evaluate, coreValues }) {
    const { internal } = vfs;
    const cache = new Map();
    const pjCache = new Map();
    const stats = { modules: 0, sourceBytes: 0, esmModules: 0 };

    function readPj(dir) {
      if (pjCache.has(dir)) return pjCache.get(dir);
      const src = internal.read(dir + '/package.json');
      let pj = null;
      if (src !== undefined) { try { pj = JSON.parse(src); } catch (e) { pj = null; } }
      pjCache.set(dir, pj);
      return pj;
    }
    function tryFile(p) {
      if (internal.isFile(p)) return p;
      for (const e of EXTS) if (internal.isFile(p + e)) return p + e;
      return null;
    }
    function tryDir(p) {
      const pj = readPj(p);
      if (pj) {
        const m = (typeof pj.browser === 'string' && pj.browser) || pj.main;
        if (m) { const r = tryFile(join(p, m)) || tryFile(join(p, m + '/index')); if (r) return r; }
      }
      return tryFile(p + '/index');
    }
    function resolveTarget(pkgDir, target, conds, star, from, isEsm) {
      if (typeof target === 'string') {
        const t = star === null ? target : target.split('*').join(star);
        if (t.startsWith('./')) { const f = join(pkgDir, t); return internal.isFile(f) ? f : null; }
        return resolve(t, from, isEsm); // "imports" may point at another package
      }
      if (Array.isArray(target)) {
        for (const t of target) { const r = resolveTarget(pkgDir, t, conds, star, from, isEsm); if (r) return r; }
        return null;
      }
      if (target && typeof target === 'object') {
        for (const k of Object.keys(target)) {
          if (k === 'default' || conds.includes(k)) {
            const r = resolveTarget(pkgDir, target[k], conds, star, from, isEsm);
            if (r) return r;
          }
        }
      }
      return null;
    }
    function resolveMap(pkgDir, map, key, conds, from, isEsm) {
      if (Object.prototype.hasOwnProperty.call(map, key)) return resolveTarget(pkgDir, map[key], conds, null, from, isEsm);
      let best = null, bestStar = null;
      for (const k of Object.keys(map)) {
        const i = k.indexOf('*');
        if (i < 0) continue;
        const pre = k.slice(0, i), post = k.slice(i + 1);
        if (key.length >= k.length && key.startsWith(pre) && key.endsWith(post) && (!best || pre.length > best.indexOf('*'))) {
          best = k; bestStar = key.slice(pre.length, key.length - post.length);
        }
      }
      if (best) return resolveTarget(pkgDir, map[best], conds, bestStar, from, isEsm);
      return null;
    }
    function notFound(spec, from) {
      const e = new Error(`Cannot find module '${spec}' (required from ${from})`);
      e.code = 'MODULE_NOT_FOUND';
      return e;
    }
    function resolve(spec, from, isEsm) {
      if (spec.startsWith('node:')) spec = spec.slice(5);
      if (coreValues.has(spec)) return 'core:' + spec;
      if (Object.prototype.hasOwnProperty.call(CORE_FILES, spec)) return CORE_FILES[spec];
      const conds = isEsm ? ['import', 'browser', 'default'] : ['require', 'browser', 'default'];
      const fromDir = dirname(from);
      if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..' || spec.startsWith('/')) {
        const p = spec.startsWith('/') ? norm(spec) : join(fromDir, spec);
        const r = tryFile(p) || (internal.isDir(p) ? tryDir(p) : null);
        if (!r) throw notFound(spec, from);
        return r;
      }
      if (spec.startsWith('#')) {
        for (let d = fromDir; ; d = dirname(d)) {
          const pj = readPj(d);
          if (pj && pj.imports) {
            const r = resolveMap(d, pj.imports, spec, conds, from, isEsm);
            if (r) return r;
            break;
          }
          if (d === '/') break;
        }
        throw notFound(spec, from);
      }
      if (spec.endsWith('/')) spec = spec.slice(0, -1); // e.g. require('util/')
      const parts = spec.split('/');
      const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      const sub = parts.slice(spec.startsWith('@') ? 2 : 1).join('/');
      for (let d = fromDir; ; d = dirname(d)) {
        const cand = (d === '/' ? '' : d) + '/node_modules/' + name;
        if (internal.isDir(cand)) {
          const pj = readPj(cand);
          let r = null;
          if (pj && pj.exports !== undefined && pj.exports !== null) {
            let exp = pj.exports;
            if (typeof exp === 'string' || Array.isArray(exp) || !Object.keys(exp).some((k) => k.startsWith('.'))) exp = { '.': exp };
            r = resolveMap(cand, exp, sub ? './' + sub : '.', conds, from, isEsm);
            if (!r) { const e = new Error(`Package subpath '${sub || '.'}' is not exported by ${name} for conditions [${conds}] (required from ${from})`); e.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED'; throw e; }
          } else if (sub) {
            const p = cand + '/' + sub;
            r = tryFile(p) || (internal.isDir(p) ? tryDir(p) : null);
          } else r = tryDir(cand);
          if (r) return r;
        }
        if (d === '/') break;
      }
      throw notFound(spec, from);
    }
    function isEsmPath(file) {
      if (file.endsWith('.mjs')) return true;
      if (!file.endsWith('.js')) return false;
      for (let d = dirname(file); ; d = dirname(d)) {
        const pj = readPj(d);
        if (pj) return pj.type === 'module';
        if (d === '/') return false;
      }
    }
    function load(file) {
      if (file.startsWith('core:')) return coreValues.get(file.slice(5));
      const hit = cache.get(file);
      if (hit) return hit.exports;
      const module = { id: file, filename: file, exports: {}, loaded: false, children: [], paths: [] };
      cache.set(file, module);
      try {
        if (file.endsWith('.json')) {
          module.exports = JSON.parse(internal.read(file));
        } else {
          let src = cjs.get(file);
          const esm = src !== undefined;
          if (!esm) {
            if (isEsmPath(file)) throw new Error(`ESM module has no CJS transform available: ${file}`);
            src = internal.read(file);
          }
          if (src.charCodeAt(0) === 35 && src.charCodeAt(1) === 33) src = '//' + src; // shebang
          stats.modules++; stats.sourceBytes += src.length; if (esm) stats.esmModules++;
          const wrapped = '(function (exports, require, module, __filename, __dirname) {' + src + '\n})\n//# sourceURL=guest://' + file;
          const fn = evaluate(wrapped, file);
          const req = localRequire(file, esm);
          fn.call(module.exports, module.exports, req, module, file, dirname(file));
        }
        module.loaded = true;
      } catch (e) {
        cache.delete(file);
        throw e;
      }
      return module.exports;
    }
    function localRequire(from, isEsm) {
      const req = (spec) => load(resolve(String(spec), from, isEsm));
      req.resolve = (spec) => resolve(String(spec), from, isEsm);
      req.cache = Object.create(null);
      return req;
    }
    return { require: localRequire('/app/__entry__.js', false), stats, resolve, cache };
  }

  // ----------------------------------------------------------------- the guest
  // opts.mode: 'ses' | 'plain'
  // opts.profile: 'minimal' (exactly the endowments named in the brief) or
  //               'extended' (+ Date, Math, crypto.getRandomValues, performance.now, global)
  // opts.pinGlobals: make every global of the compartment non-writable/non-configurable
  //               before the first evaluate, so SES hoists them into consts (perf experiment)
  let guestCounter = 0;
  function makeGuest(vfs, opts) {
    const mode = opts.mode;
    const profile = opts.profile || 'extended';
    const id = ++guestCounter;
    const out = [];
    const censored = [];
    const t0 = real.now();
    const stamp = (kind, text) => { out.push([Math.round((real.now() - t0) * 100) / 100, kind, text]); if (out.length > 2000) out.shift(); };
    const fmt = (args) => args.map((a) => { try { return typeof a === 'string' ? a : typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a); } catch (e) { return '[unprintable]'; } }).join(' ');
    const mkLog = (kind) => (...args) => { stamp(kind, fmt(args)); };
    const guestConsole = { log: mkLog('log'), info: mkLog('info'), warn: mkLog('warn'), error: mkLog('error'), debug: mkLog('debug'), trace: mkLog('trace') };

    const needFn = (fn) => { if (typeof fn !== 'function') throw new TypeError('callback must be a function (string callbacks are not supported)'); };
    const timers = {
      setTimeout: (fn, ms, ...args) => { needFn(fn); return real.setTimeout(() => { fn(...args); }, Number(ms) || 0); },
      clearTimeout: (h) => { real.clearTimeout(Number(h)); },
      setInterval: (fn, ms, ...args) => { needFn(fn); return real.setInterval(() => { fn(...args); }, Number(ms) || 0); },
      clearInterval: (h) => { real.clearInterval(Number(h)); },
      queueMicrotask: (fn) => { needFn(fn); real.queueMicrotask(() => { fn(); }); },
    };
    const stream = (kind) => ({ write: (s) => { stamp(kind, String(s)); return true; }, isTTY: false, columns: 80 });
    // `process` is per guest and deliberately left mutable (packages write to process.env);
    // the functions hanging off it are hardened individually in SES mode.
    const process = {
      argv: ['node', '/app/main.js'],
      env: { NODE_ENV: 'production' },
      cwd: () => '/app',
      platform: 'browser',
      browser: true,
      version: '',
      versions: {},
      stdout: stream('stdout'),
      stderr: stream('stderr'),
      nextTick: (fn, ...args) => { needFn(fn); real.queueMicrotask(() => { fn(...args); }); },
    };
    const kernel = { fs: vfs.fs, process };

    const endow = {
      console: guestConsole,
      kernel,
      process,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      queueMicrotask: timers.queueMicrotask,
      TextEncoder: self.TextEncoder,
      TextDecoder: self.TextDecoder,
      URL: self.URL,
    };
    if (profile === 'extended') {
      Object.assign(endow, {
        // After lockdown the start compartment still holds the "initial" Date/Math
        // (with a working Date.now / Math.random); compartments get tamed "shared" ones.
        Date: self.Date,
        Math: self.Math,
        URLSearchParams: self.URLSearchParams,
        crypto: {
          getRandomValues: (arr) => real.crypto.getRandomValues(arr),
          randomUUID: () => real.crypto.randomUUID(),
        },
        performance: { now: () => real.now(), timeOrigin: 0 },
      });
    }
    if (opts.extraEndowments) Object.assign(endow, opts.extraEndowments);

    let evaluate;
    let compartment = null;
    let guestGlobal;
    if (mode === 'ses') {
      const hardened = {};
      for (const k of Object.keys(endow)) {
        if (k === 'process') { hardened[k] = process; continue; }
        if (k === 'kernel') { hardened[k] = Object.freeze({ fs: harden(vfs.fs), process }); continue; }
        hardened[k] = opts.noHarden ? endow[k] : harden(endow[k]);
      }
      for (const k of Object.keys(process)) if (typeof process[k] === 'function') harden(process[k]);
      harden(process.stdout); harden(process.stderr);
      compartment = new Compartment({ __options__: true, name: 'guest-' + id, globals: hardened });
      guestGlobal = compartment.globalThis;
      if (profile === 'extended') { guestGlobal.global = guestGlobal; }
      if (opts.pinGlobals) {
        for (const k of Object.getOwnPropertyNames(guestGlobal)) {
          const d = Object.getOwnPropertyDescriptor(guestGlobal, k);
          if (d && 'value' in d && d.configurable) Object.defineProperty(guestGlobal, k, { value: d.value, writable: false, configurable: false, enumerable: d.enumerable });
        }
      }
      if (opts.freezeGlobal) Object.freeze(guestGlobal);
      const evade = { __evadeHtmlCommentTest__: true, __evadeImportExpressionTest__: true, __rejectSomeDirectEvalExpressions__: false };
      evaluate = (src, name) => {
        if (opts.alwaysEvade) return compartment.evaluate(src, evade);
        try {
          return compartment.evaluate(src);
        } catch (e) {
          const m = e instanceof SyntaxError && /\((SES_[A-Z_]+)\)/.exec(e.message);
          if (!m) throw e;
          censored.push({ file: name, code: m[1] });
          return compartment.evaluate(src, evade);
        }
      };
    } else {
      guestGlobal = self;
      // plain mode: the guest runs in the worker's real global scope (control case)
      self.kernel = kernel; self.process = process; self.global = self;
      evaluate = (src) => indirectEval(src);
    }
    const coreValues = new Map([['fs', vfs.fs], ['process', process]]);
    const loader = makeRequire({ vfs, cjs: opts.cjs || vfs.cjs, evaluate, coreValues });
    return { id, mode, compartment, globalThis: guestGlobal, evaluate, require: loader.require, loader, out, censored, process };
  }

  self.SpikeKernel = { makeFs, makeGuest, makeRequire, real, norm, dirname, join };
})();
