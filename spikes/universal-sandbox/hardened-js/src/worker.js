// Dedicated (classic) worker: kernel + guest in one thread.
// URL params: mode=ses|plain, lockdown=<json lockdown options>
'use strict';
const T_START = performance.now();
const params = new URL(self.location.href).searchParams;
const MODE = params.get('mode') || 'ses';
const LOCKDOWN_OPTS = JSON.parse(params.get('lockdown') || '{}');
const boot = { mode: MODE, lockdownOptions: LOCKDOWN_OPTS, errors: [] };

self.__REAL_GLOBAL_CANARY__ = 1;
const realGc = typeof self.gc === 'function' ? self.gc : null;
const INDIRECT_EVAL = self.eval; // called under another name => indirect eval, survives guests deleting globalThis.eval in plain mode

let t = performance.now();
importScripts('/src/kernel.js', '/src/confine-tests.js');
boot.kernelScriptMs = performance.now() - t;

if (MODE === 'ses') {
  try {
    t = performance.now();
    importScripts('/dist/ses.umd.js');
    boot.sesScriptMs = performance.now() - t;
    t = performance.now();
    lockdown(LOCKDOWN_OPTS);
    boot.lockdownMs = performance.now() - t;
    boot.frozen = { ObjectPrototype: Object.isFrozen(Object.prototype), ArrayPrototype: Object.isFrozen(Array.prototype), FunctionPrototype: Object.isFrozen(Function.prototype) };
  } catch (e) {
    boot.errors.push('lockdown: ' + (e && e.name) + ': ' + (e && e.message));
  }
  // Can a Compartment evaluate at all (needs eval / new Function, i.e. CSP 'unsafe-eval')?
  try {
    t = performance.now();
    boot.firstEvaluate = new Compartment().evaluate('1 + 1');
    boot.firstEvaluateMs = performance.now() - t;
  } catch (e) {
    boot.errors.push('compartment.evaluate: ' + (e && e.name) + ': ' + (e && e.message));
  }
} else {
  try { boot.firstEvaluate = (0, eval)('1 + 1'); } catch (e) { boot.errors.push('eval: ' + e.name + ': ' + e.message); }
}
boot.bootMs = performance.now() - T_START;

const K = self.SpikeKernel;
let vfs = null;
const keep = []; // keeps compartments alive for the memory test
const timeline = [];
let pings = 0;

const errInfo = (e) => {
  if (!e || typeof e !== 'object') return { name: 'Thrown', message: String(e) };
  let stack = '';
  try { stack = String(e.stack || '').split('\n').slice(0, 6).join('\n'); } catch (_) {}
  return { name: String(e.name), message: String(e.message), code: e.code === undefined ? undefined : String(e.code), stack };
};
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = (x) => Math.round(x * 100) / 100;
const guest = (opts) => K.makeGuest(vfs, Object.assign({ mode: MODE }, opts || {}));

const commands = {
  ping() { pings++; timeline.push([r2(performance.now()), 'kernel: ping ' + pings]); return pings; },
  boot() { return boot; },
  wasmProbe() {
    // kernel-side: is WebAssembly compilation allowed under the current CSP?
    try { new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); return 'wasm compile ok'; } catch (e) { return 'wasm blocked: ' + e.name + ': ' + String(e.message).slice(0, 120); }
  },

  async loadImage({ url }) {
    const t0 = performance.now();
    const res = await fetch(url);
    const text = await res.text();
    const t1 = performance.now();
    const image = JSON.parse(text);
    const t2 = performance.now();
    vfs = K.makeFs(image);
    const t3 = performance.now();
    return { fetchMs: r2(t1 - t0), parseMs: r2(t2 - t1), fsBuildMs: r2(t3 - t2), chars: text.length, files: vfs.internal.fileCount() };
  },

  // ---- compatibility ------------------------------------------------------------------
  compatList() { return guest().require('/app/compat.js').list; },
  async compat({ test, profile, alwaysEvade, noEvade }) {
    const g = guest({ profile, alwaysEvade, noEvade });
    const t0 = performance.now();
    try {
      const detail = await g.require('/app/compat.js').run(test);
      return { test, ok: true, detail, ms: r2(performance.now() - t0), modules: g.loader.stats.modules, esmModules: g.loader.stats.esmModules, censored: g.censored };
    } catch (e) {
      return { test, ok: false, error: errInfo(e), ms: r2(performance.now() - t0), censored: g.censored, out: g.out.slice(-5) };
    }
  },

  // ---- performance ----------------------------------------------------------------------
  async perf({ workload, iters, warmup, pinGlobals, freezeGlobal }) {
    const g = guest({ pinGlobals, freezeGlobal });
    const w = g.require('/app/perf.js')[workload];
    const tSetup = performance.now();
    const state = w.setup();
    const setupMs = performance.now() - tSetup;
    let result;
    for (let i = 0; i < warmup; i++) result = w.run(state);
    const times = [];
    for (let i = 0; i < iters; i++) { const t0 = performance.now(); result = w.run(state); times.push(r2(performance.now() - t0)); }
    return { workload, median: r2(median(times)), min: Math.min(...times), max: Math.max(...times), times, setupMs: r2(setupMs), result };
  },
  loadTime({ spec, runs, pinGlobals }) {
    const times = [];
    let info;
    for (let i = 0; i < runs; i++) {
      const g = guest({ pinGlobals });
      const t0 = performance.now();
      g.require(spec);
      times.push(r2(performance.now() - t0));
      info = { modules: g.loader.stats.modules, sourceBytes: g.loader.stats.sourceBytes, censored: g.censored.length };
    }
    return Object.assign({ spec, first: times[0], median: r2(median(times)), times }, info);
  },
  compartmentCreate({ n }) {
    if (MODE !== 'ses') return null;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) guest();
    const t1 = performance.now();
    for (let i = 0; i < n; i++) guest().evaluate('1');
    const t2 = performance.now();
    return { n, createMsEach: r2((t1 - t0) / n), createPlusFirstEvaluateMsEach: r2((t2 - t1) / n) };
  },

  // ---- confinement ------------------------------------------------------------------------
  async confine() {
    const results = [];
    const { PRELUDE, TESTS } = self.CONFINE;
    // "not hardened" what-ifs must run before anything in this worker hardens the shared host
    // classes (harden is irreversible); results are put back in declaration order afterwards.
    const ordered = [...TESTS.filter((t) => t.noHarden), ...TESTS.filter((t) => !t.noHarden)];
    for (const test of ordered) {
      const rec = { group: test.group, name: test.name, whatIf: !!test.whatIf };
      results[TESTS.indexOf(test)] = rec;
      if (MODE === 'plain' && test.group === 'pollution') { rec.status = 'n/a'; rec.how = 'not run in the plain control (it would succeed and wreck the worker)'; continue; }
      const extra = {};
      if (test.extra === 'rawSetTimeout') extra.rawSetTimeout = self.setTimeout.bind(self);
      if (test.extra === 'WebAssembly') extra.WebAssembly = self.WebAssembly;
      const g = guest({ profile: test.profile || 'extended', extraEndowments: extra, noHarden: !!test.noHarden });
      if (MODE === 'plain') for (const k of Object.keys(extra)) self[k] = extra[k];
      const src = '(async () => {' + PRELUDE + test.body + '\n})()';
      let viaEvade = false;
      try {
        let p;
        if (MODE === 'ses') {
          const evade = { __evadeHtmlCommentTest__: true, __evadeImportExpressionTest__: true, __rejectSomeDirectEvalExpressions__: false };
          if (test.evade) p = g.compartment.evaluate(src, evade);
          else {
            try { p = g.compartment.evaluate(src); } catch (e) {
              const m = e instanceof SyntaxError && /\((SES_[A-Z_]+)\)/.exec(e.message);
              if (!m || m[1] === 'SES_IMPORT_REJECTED') throw e;
              viaEvade = m[1];
              p = g.compartment.evaluate(src, evade);
            }
          }
        } else p = INDIRECT_EVAL(src);
        const v = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('probe timed out after 3s')), 3000))]);
        rec.status = v.s; rec.how = v.note;
        if (v.s === 'check') {
          const val = self[v.key];
          rec.status = val === undefined ? 'blocked' : 'reachable';
          rec.how = v.note + (val === undefined ? ' [kernel check: real global untouched]' : ' [kernel check: real global self.' + v.key + ' = ' + String(val) + ']');
          try { delete self[v.key]; } catch (_) {}
        }
      } catch (e) {
        rec.status = 'blocked';
        rec.how = 'threw ' + (e && e.name) + ': ' + String(e && e.message).slice(0, 220);
      }
      if (viaEvade) rec.how = '[default evaluate rejected the probe source with ' + viaEvade + '; re-run with evade options] ' + rec.how;
    }
    const sideEffects = Object.getOwnPropertyNames(self).filter((k) => /^__pwned|^leakedGlobal$|^guestVar$|^polluted$/.test(k)).map((k) => k + '=' + String(self[k]));
    return { results, realGlobalSideEffects: sideEffects, intrinsicsStillFrozen: MODE === 'ses' ? Object.isFrozen(Object.prototype) && Object.isFrozen(Function.prototype) : null, pollutedCheck: ({}).polluted === undefined };
  },

  // ---- liveness ----------------------------------------------------------------------------
  evalGuest({ code, profile }) {
    const g = guest({ profile });
    keep.push(g);
    const v = g.evaluate(code);
    return typeof v === 'function' || (typeof v === 'object' && v !== null) ? String(v) : v;
  },
  async interleave() {
    const g = guest();
    timeline.length = 0;
    const base = performance.now();
    const kernelTick = setInterval(() => { timeline.push([r2(performance.now()), 'kernel: interval tick']); }, 15);
    const log = (s) => timeline.push([r2(performance.now()), 'guest: ' + s]);
    g.globalThis.report = MODE === 'ses' ? harden(log) : log;
    const done = g.evaluate(`(async () => {
      report('start');
      for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 20)); report('timer step ' + i); }
      // a microtask-only loop: never yields to the event loop
      const t0 = Date.now(); let spins = 0;
      report('microtask loop begin');
      while (Date.now() - t0 < 200) { await null; spins++; }
      report('microtask loop end after ' + spins + ' awaits');
      await new Promise((r) => setTimeout(r, 30));
      report('done');
      return spins;
    })()`);
    const spins = await done;
    clearInterval(kernelTick);
    const tl = timeline.map(([ts, s]) => [r2(ts - base), s]);
    const begin = tl.find((e) => e[1].includes('microtask loop begin'))[0];
    const end = tl.find((e) => e[1].includes('microtask loop end'))[0];
    const during = tl.filter((e) => e[0] > begin && e[0] < end && e[1].startsWith('kernel'));
    const timerPhase = tl.filter((e) => e[0] < begin);
    return { spins, timeline: tl, kernelEventsDuringTimerPhase: timerPhase.filter((e) => e[1].startsWith('kernel')).length, guestEventsDuringTimerPhase: timerPhase.filter((e) => e[1].startsWith('guest')).length, kernelEventsDuringMicrotaskLoop: during.length, microtaskLoopMs: r2(end - begin) };
  },

  // ---- memory -------------------------------------------------------------------------------
  mem() {
    if (realGc) { realGc(); realGc(); }
    const m = performance.memory;
    return { gc: !!realGc, usedJSHeapSize: m ? m.usedJSHeapSize : null, totalJSHeapSize: m ? m.totalJSHeapSize : null };
  },
  makeCompartments({ n, spec }) {
    for (let i = 0; i < n; i++) {
      const g = guest();
      if (spec) g.keepExports = g.require(spec);
      else g.evaluate('1');
      keep.push(g);
    }
    return keep.length;
  },

  // ---- ESM experiments ------------------------------------------------------------------------
  esmCandidates({ pkgs }) {
    const out = {};
    for (const [file] of vfs.cjs) { const m = /^\/node_modules\/([^/]+)\//.exec(file); if (m && pkgs.includes(m[1])) (out[m[1]] = out[m[1]] || []).push(file); }
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { files: v.length, bytes: v.reduce((a, f) => a + vfs.internal.read(f).length, 0) }]));
  },
  async esbuildWasm({ pkgs }) {
    const res = { afterLockdown: MODE === 'ses' };
    try {
      let t0 = performance.now();
      importScripts('/dist/esbuild-browser.js');
      res.scriptMs = r2(performance.now() - t0);
      t0 = performance.now();
      await self.esbuild.initialize({ wasmURL: '/dist/esbuild.wasm', worker: false });
      res.initializeMs = r2(performance.now() - t0);
      res.perPackage = {};
      const runtimeCjs = new Map();
      for (const pkg of pkgs) {
        const files = [...vfs.cjs.keys()].filter((f) => f.startsWith('/node_modules/' + pkg + '/'));
        let bytes = 0;
        t0 = performance.now();
        // esbuild-wasm in the browser only has the async API, so this has to happen
        // ahead of time ("install time"), not lazily inside a synchronous require().
        for (const f of files) {
          const src = vfs.internal.read(f); bytes += src.length;
          const r = await self.esbuild.transform(src, { format: 'cjs', target: 'es2022', loader: 'js', sourcefile: f, supported: { 'dynamic-import': false }, logLevel: 'silent' });
          runtimeCjs.set(f, r.code);
        }
        const ms = performance.now() - t0;
        res.perPackage[pkg] = { files: files.length, bytes, ms: r2(ms), mbPerSec: r2(bytes / 1e6 / (ms / 1000)) };
      }
      // prove the runtime-transformed output actually loads in a guest
      const g = guest({ cjs: runtimeCjs });
      const chalk = g.require('chalk');
      res.smoke = new chalk.Chalk({ level: 1 }).green('ok') === '\u001b[32mok\u001b[39m' ? 'chalk loaded from in-worker esbuild-wasm output' : 'chalk output mismatch';
      res.smoke += '; marked: ' + JSON.stringify(g.require('marked').marked.parse('*x*'));
    } catch (e) { res.error = errInfo(e); }
    return res;
  },
  async moduleSource({ pkgs, entry }) {
    const res = { nativeModuleSource: typeof self.ModuleSource, afterLockdown: MODE === 'ses' };
    try {
      let t0 = performance.now();
      importScripts('/dist/module-source.js');
      res.scriptMs = r2(performance.now() - t0);
      const { ModuleSource } = self.EndoModuleSource;
      res.perPackage = {};
      const records = new Map();
      for (const pkg of pkgs) {
        const files = [...vfs.cjs.keys()].filter((f) => f.startsWith('/node_modules/' + pkg + '/'));
        let bytes = 0; const errors = [];
        t0 = performance.now();
        for (const f of files) {
          const src = vfs.internal.read(f); bytes += src.length;
          try { records.set(f, new ModuleSource(src, f)); } catch (e) { errors.push(f + ': ' + String(e.message).slice(0, 120)); }
        }
        const ms = performance.now() - t0;
        res.perPackage[pkg] = { files: files.length, bytes, ms: r2(ms), mbPerSec: r2(bytes / 1e6 / (ms / 1000)), errors: errors.slice(0, 3), errorCount: errors.length };
      }
      // Link and run through SES's own module system (resolveHook + importNowHook).
      if (MODE === 'ses') {
        const g = guest();
        const esmResolver = K.makeRequire({ vfs, cjs: vfs.cjs, evaluate: () => { throw new Error('unused'); }, coreValues: new Map() });
        const made = new Map();
        const c = new Compartment({
          __options__: true,
          name: 'esm-guest',
          globals: { console: g.globalThis.console, process: g.process, Date: self.Date, Math: self.Math },
          // module sources go through the same censorship; there is no per-module evade flag,
          // so replicate SES's evade transforms as compartment-level transforms
          transforms: [(src) => src.replace(/<!--/g, '< ! --').replace(/-->/g, '-- >'), (src) => src.replace(/(^|[^.]|\.\.\.)\bimport(\s*(?:\(|\/[/*]))/g, '$1__import__$2')],
          resolveHook: (spec, referrer) => esmResolver.resolve(spec, referrer, true),
          importNowHook: (full) => {
            let rec = records.get(full);
            if (!rec) { rec = new ModuleSource(vfs.internal.read(full), full); records.set(full, rec); }
            made.set(full, true);
            return rec;
          },
          importHook: async (full) => records.get(full),
        });
        t0 = performance.now();
        const entryFile = esmResolver.resolve(entry, '/app/__entry__.js', true);
        const ns = c.importNow(entryFile);
        res.sesModuleImportMs = r2(performance.now() - t0);
        res.sesModuleCount = made.size;
        res.smoke = entry === 'chalk' ? (new ns.Chalk({ level: 1 }).green('ok') === '\u001b[32mok\u001b[39m' ? 'chalk linked + executed via Compartment.importNow' : 'mismatch') : Object.keys(ns).slice(0, 8).join(',');
        try {
          const mf = esmResolver.resolve('marked', '/app/__entry__.js', true);
          const mns = c.importNow(mf);
          res.smoke += '; marked: ' + JSON.stringify(mns.marked.parse('*x*'));
        } catch (e) { res.markedError = errInfo(e); }
      }
    } catch (e) { res.error = errInfo(e); }
    return res;
  },
};

self.onmessage = async (ev) => {
  const { id, cmd, args } = ev.data;
  try {
    const result = await commands[cmd](args || {});
    self.postMessage({ id, ok: true, result });
  } catch (e) {
    self.postMessage({ id, ok: false, error: errInfo(e) });
  }
};
self.postMessage({ type: 'ready', boot });
