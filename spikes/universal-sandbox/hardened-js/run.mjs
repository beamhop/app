// Playwright driver. Prints one JSON document with all results on stdout
// (progress goes to stderr) and also writes dist/results.json.
// SPIKE_ONLY=csp,compat,perf,confine,liveness,memory,esm limits the sections that run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.dirname(fileURLToPath(import.meta.url));
const only = process.env.SPIKE_ONLY ? new Set(process.env.SPIKE_ONLY.split(',')) : null;
const want = (s) => !only || only.has(s);
const log = (...a) => console.error('[spike]', ...a);
const q = (o) => new URLSearchParams(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))).toString();
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = (x) => Math.round(x * 100) / 100;

// The lockdown options the spike settled on (see RESULTS.md). Everything else is SES default.
const LOCKDOWN = { errorTaming: 'unsafe', overrideTaming: 'moderate', consoleTaming: 'safe', stackFiltering: 'verbose' };

const { server, url: base } = await startServer();
const LAUNCH = { args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] };
let browser = await chromium.launch(LAUNCH);
const results = {
  meta: JSON.parse(fs.readFileSync(path.join(root, 'dist/meta.json'), 'utf8')),
  machine: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, totalMemGb: r2(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.release()}`, node: process.version, browser: 'chromium ' + browser.version() + ' (headless shell, Playwright)', loadAvgAtStart: os.loadavg().map(r2) },
  lockdownOptionsUsed: LOCKDOWN,
  harness: { browserRestartsAfterExternalKill: 0 },
};
delete results.meta.packages;
const sesConsole = new Set();

// The container this ran in is shared with other jobs, and something outside this spike
// SIGTERMs Chromium processes every so often. So every unit of work gets a fresh browser
// and is simply re-run from scratch if the browser disappears underneath it.
async function unit(label, fn, tries = 10) {
  for (let i = 1; ; i++) {
    if (!browser.isConnected()) browser = await chromium.launch(LAUNCH);
    try {
      return await fn();
    } catch (e) {
      const died = !browser.isConnected() || /has been closed|Target closed|Target crashed|browser has disconnected/i.test(e.message);
      if (!died || i >= tries) throw e;
      results.harness.browserRestartsAfterExternalKill++;
      log(`${label}: browser went away (attempt ${i}), re-running this unit`);
      await browser.close().catch(() => {});
    }
  }
}

async function newPage(query = '') {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => log('pageerror', e.message));
  page.on('crash', () => log('PAGE CRASHED'));
  page.on('console', (m) => { const t = m.text(); if (/^(SES |Removing )/.test(t)) sesConsole.add(t); });
  await page.goto(`${base}/src/page.html${query ? '?' + query : ''}`);
  const H = {
    page,
    spawn: (query) => page.evaluate((query) => self.H.spawn(query), query),
    call: (id, cmd, args) => page.evaluate(([id, cmd, args]) => self.H.call(id, cmd, args), [id, cmd, args]),
    kill: (id) => page.evaluate((id) => self.H.kill(id), id),
    close: () => context.close(),
  };
  return H;
}
async function worker(H, opts, image = '/dist/image.json') {
  const s = await H.spawn(q(opts));
  if (s.boot.errors.length) throw new Error('worker boot errors: ' + s.boot.errors.join('; '));
  const img = await H.call(s.id, 'loadImage', { url: image });
  return { id: s.id, boot: s.boot, spawnToReadyMs: s.spawnToReadyMs, img };
}

try {
  // ------------------------------------------------------------------ boot + lockdown options
  {
    const variants = {
      'defaults {}': {},
      'spike options': LOCKDOWN,
      "overrideTaming:'severe'": { ...LOCKDOWN, overrideTaming: 'severe' },
      "overrideTaming:'min'": { ...LOCKDOWN, overrideTaming: 'min' },
      "errorTaming:'safe'": { ...LOCKDOWN, errorTaming: 'safe' },
      "consoleTaming:'unsafe'": { ...LOCKDOWN, consoleTaming: 'unsafe' },
    };
    results.lockdown = await unit('lockdown', async () => {
      const H = await newPage();
      const out = {};
      results.env = await H.page.evaluate(() => ({ userAgent: navigator.userAgent, crossOriginIsolated: self.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer, hardwareConcurrency: navigator.hardwareConcurrency }));
      for (const [name, opts] of Object.entries(variants)) {
        const runs = [];
        for (let i = 0; i < 7; i++) { const s = await H.spawn(q({ mode: 'ses', lockdown: opts })); runs.push(s); await H.kill(s.id); }
        out[name] = {
          options: opts, errors: runs[0].boot.errors,
          lockdownMsMedian: r2(median(runs.map((r) => r.boot.lockdownMs))), sesScriptMsMedian: r2(median(runs.map((r) => r.boot.sesScriptMs))),
          firstEvaluateMsMedian: r2(median(runs.map((r) => r.boot.firstEvaluateMs))), spawnToReadyMsMedian: r2(median(runs.map((r) => r.spawnToReadyMs))),
          lockdownMsAll: runs.map((r) => r2(r.boot.lockdownMs)),
        };
      }
      const plain = [];
      for (let i = 0; i < 7; i++) { const s = await H.spawn(q({ mode: 'plain' })); plain.push(s.spawnToReadyMs); await H.kill(s.id); }
      out['(plain worker, no ses)'] = { spawnToReadyMsMedian: r2(median(plain)) };
      await H.close();
      return out;
    });
    results.sesConsoleMessagesAtLockdown = [...sesConsole];
    log('lockdown', JSON.stringify(Object.fromEntries(Object.entries(results.lockdown).map(([k, v]) => [k, v.lockdownMsMedian ?? v.spawnToReadyMsMedian]))));
  }

  // ------------------------------------------------------------------ CSP
  if (want('csp')) {
    results.csp = [];
    const cases = [
      { label: 'no CSP', page: '', worker: '' },
      { label: "page+worker: script-src 'self'", page: "script-src 'self'", worker: "script-src 'self'" },
      { label: "page+worker: script-src 'self', lockdown evalTaming:'no-eval'", page: "script-src 'self'", worker: "script-src 'self'", lockdown: { ...LOCKDOWN, evalTaming: 'no-eval' } },
      { label: "page+worker: script-src 'self' 'wasm-unsafe-eval'", page: "script-src 'self' 'wasm-unsafe-eval'", worker: "script-src 'self' 'wasm-unsafe-eval'" },
      { label: "page+worker: script-src 'self' 'unsafe-eval'", page: "script-src 'self' 'unsafe-eval'", worker: "script-src 'self' 'unsafe-eval'" },
      { label: "page only: script-src 'self' (worker response has no CSP header)", page: "script-src 'self'", worker: '' },
      { label: "page: script-src 'self'; worker: script-src 'self' 'unsafe-eval'", page: "script-src 'self'", worker: "script-src 'self' 'unsafe-eval'" },
      { label: "worker: script-src 'self' 'unsafe-eval'; connect-src 'none' (defence in depth)", page: '', worker: "script-src 'self' 'unsafe-eval'; connect-src 'none'", noImage: true },
    ];
    for (const c of cases) {
      const rec = await unit('csp', async () => {
        const H = await newPage(c.page ? q({ csp: c.page }) : '');
        const rec = { label: c.label };
        try {
          const o = { mode: 'ses', lockdown: c.lockdown || LOCKDOWN };
          if (c.worker) o.csp = c.worker;
          const s = await H.spawn(q(o));
          rec.lockdownOk = s.boot.lockdownMs !== undefined && !s.boot.errors.some((e) => e.startsWith('lockdown'));
          rec.compartmentEvaluateOk = s.boot.firstEvaluate === 2;
          rec.errors = s.boot.errors.map((e) => e.trim());
          rec.wasm = await H.call(s.id, 'wasmProbe', {});
          if (rec.compartmentEvaluateOk && !c.noImage) {
            await H.call(s.id, 'loadImage', { url: '/dist/image-small.json' });
            const r = await H.call(s.id, 'compat', { test: 'ajv' });
            rec.guestPackageOk = r.ok ? 'ajv ok' : r.error.message;
          }
          if (c.noImage) rec.kernelFetch = await H.call(s.id, 'loadImage', { url: '/dist/image-small.json' }).then(() => 'fetch allowed', (e) => { if (!browser.isConnected()) throw e; return 'kernel fetch() blocked by connect-src: ' + e.message.split('\n')[0]; });
        } catch (e) { if (!browser.isConnected()) throw e; rec.spawnError = e.message; }
        await H.close();
        return rec;
      });
      results.csp.push(rec);
      log('csp', JSON.stringify(rec).slice(0, 400));
    }
  }

  // ------------------------------------------------------------------ compatibility
  if (want('compat')) {
    const configs = {
      plain: { mode: 'plain' },
      'ses-moderate-minimal': { mode: 'ses', lockdown: LOCKDOWN, profile: 'minimal' },
      'ses-moderate': { mode: 'ses', lockdown: LOCKDOWN, profile: 'extended' },
      'ses-severe': { mode: 'ses', lockdown: { ...LOCKDOWN, overrideTaming: 'severe' }, profile: 'extended' },
      'ses-min': { mode: 'ses', lockdown: { ...LOCKDOWN, overrideTaming: 'min' }, profile: 'extended' },
      'ses-moderate-errorTaming-safe': { mode: 'ses', lockdown: { ...LOCKDOWN, errorTaming: 'safe' }, profile: 'extended' },
      'ses-moderate-no-evade': { mode: 'ses', lockdown: LOCKDOWN, profile: 'extended', noEvade: true },
    };
    results.compat = { configs, tests: {}, summary: {} };
    for (const [name, cfg] of Object.entries(configs)) {
      const rows = await unit('compat ' + name, async () => {
        const H = await newPage();
        const w = await worker(H, { mode: cfg.mode, lockdown: cfg.lockdown || {} });
        const list = await H.call(w.id, 'compatList', {});
        const rows = [];
        for (const test of list) rows.push(await H.call(w.id, 'compat', { test, profile: cfg.profile, noEvade: cfg.noEvade }));
        await H.close();
        return rows;
      });
      let pass = 0;
      for (const r of rows) {
        (results.compat.tests[r.test] ||= {})[name] = r.ok
          ? { ok: true, detail: r.detail, ms: r.ms, modules: r.modules, esmModules: r.esmModules, censored: summarizeCensor(r.censored) }
          : { ok: false, error: `${r.error.name}: ${r.error.message}`, stack: r.error.stack, censored: summarizeCensor(r.censored) };
        if (r.ok) pass++; else log('compat FAIL', name, r.test, (r.error.name + ': ' + r.error.message).slice(0, 200));
      }
      results.compat.summary[name] = `${pass}/${rows.length}`;
      log('compat', name, `${pass}/${rows.length}`);
    }
  }

  // ------------------------------------------------------------------ performance
  if (want('perf')) {
    const modes = {
      plain: { spawn: { mode: 'plain' }, run: {} },
      ses: { spawn: { mode: 'ses', lockdown: LOCKDOWN }, run: {} },
      'ses+pinnedGlobals': { spawn: { mode: 'ses', lockdown: LOCKDOWN }, run: { pinGlobals: true } },
    };
    const workloads = [['tscheck', 5, 1], ['marked', 7, 2], ['zod', 7, 2], ['numericLocals', 7, 2], ['numericGlobals', 5, 1], ['json', 7, 2], ['lodash', 7, 2], ['acorn', 7, 2]];
    const ROUNDS = 3;
    const perf = {};
    const loads = {};
    for (let round = 0; round < ROUNDS; round++) {
      // module load time on a cold worker (first require of each module in that worker)
      for (const [mode, cfg] of Object.entries(modes)) {
        const rs = await unit(`load ${mode}`, async () => {
          const H = await newPage();
          const w = await worker(H, cfg.spawn);
          const out = [];
          for (const spec of ['typescript', 'lodash', 'zod', 'prettier/standalone']) out.push(await H.call(w.id, 'loadTime', { spec, runs: 3, ...cfg.run }));
          await H.close();
          return out;
        });
        for (const r of rs) ((loads[r.spec] ||= {})[mode] ||= []).push(r);
        log('load', `round ${round}`, mode, rs.map((r) => `${r.spec}=${r.first}`).join(' '));
      }
      // one fresh browser + worker per (workload, mode); modes interleaved to spread machine noise
      for (const [workload, iters, warmup] of workloads) {
        for (const [mode, cfg] of Object.entries(modes)) {
          const r = await unit(`perf ${workload} ${mode}`, async () => {
            const H = await newPage();
            const w = await worker(H, cfg.spawn);
            const r = await H.call(w.id, 'perf', { workload, iters, warmup, ...cfg.run });
            await H.close();
            return r;
          });
          ((perf[workload] ||= {})[mode] ||= []).push(...r.times);
          log('perf', `round ${round}`, workload, mode, 'median', r.median, 'ms');
        }
      }
    }
    results.perf = { rounds: ROUNDS, note: 'every (workload, mode, round) runs in its own fresh browser + worker; timed iterations pooled over rounds; warm-up iterations excluded', workloads: {} };
    for (const [workload, byMode] of Object.entries(perf)) {
      const row = {};
      for (const [mode, times] of Object.entries(byMode)) row[mode] = { medianMs: r2(median(times)), minMs: Math.min(...times), maxMs: Math.max(...times), n: times.length };
      row.slowdownSes = r2(row.ses.medianMs / row.plain.medianMs);
      row.slowdownSesPinned = r2(row['ses+pinnedGlobals'].medianMs / row.plain.medianMs);
      results.perf.workloads[workload] = row;
    }
    results.perf.moduleLoad = {};
    for (const [spec, byMode] of Object.entries(loads)) {
      const row = {};
      for (const [mode, rs] of Object.entries(byMode)) row[mode] = { coldFirstLoadMs: rs.map((r) => r.first), coldFirstLoadMedianMs: r2(median(rs.map((r) => r.first))), reloadInFreshGuestMedianMs: r2(median(rs.flatMap((r) => r.times.slice(1)))), modules: rs[0].modules, sourceBytes: rs[0].sourceBytes };
      row.slowdownColdSes = r2(row.ses.coldFirstLoadMedianMs / row.plain.coldFirstLoadMedianMs);
      row.slowdownReloadSes = r2(row.ses.reloadInFreshGuestMedianMs / row.plain.reloadInFreshGuestMedianMs);
      results.perf.moduleLoad[spec] = row;
    }
    results.perf.compartmentCreate = await unit('compartmentCreate', async () => {
      const H = await newPage();
      const w = await worker(H, { mode: 'ses', lockdown: LOCKDOWN }, '/dist/image-small.json');
      const r = await H.call(w.id, 'compartmentCreate', { n: 200 });
      await H.close();
      return r;
    });
  }

  // ------------------------------------------------------------------ confinement
  if (want('confine')) {
    const run = (opts) => unit('confine', async () => {
      const H = await newPage();
      const w = await worker(H, opts, '/dist/image-small.json');
      const r = await H.call(w.id, 'confine', {});
      await H.close();
      return r;
    });
    const a = await run({ mode: 'ses', lockdown: LOCKDOWN });
    const s = await run({ mode: 'ses', lockdown: { ...LOCKDOWN, errorTaming: 'safe' } });
    const b = await run({ mode: 'plain' });
    results.confinement = {
      note: 'status is for the SES compartment (spike lockdown options); controlPlain is the same probe run by plain indirect eval in a worker without SES',
      realGlobalSideEffects: a.realGlobalSideEffects, intrinsicsStillFrozen: a.intrinsicsStillFrozen, objectPrototypeUnpolluted: a.pollutedCheck,
      results: a.results.map((r, i) => ({ ...r, controlPlain: b.results[i].status, errorTamingSafe: s.results[i].status !== r.status || r.group === 'errors' ? { status: s.results[i].status, how: s.results[i].how } : undefined })),
    };
    const counts = {};
    for (const r of a.results) counts[r.status + (r.whatIf ? ' (what-if)' : '')] = (counts[r.status + (r.whatIf ? ' (what-if)' : '')] || 0) + 1;
    results.confinement.counts = counts;
    log('confine', JSON.stringify(counts), 'side effects:', JSON.stringify(a.realGlobalSideEffects));
    for (const r of a.results) if (r.status === 'reachable') log('REACHABLE', r.name, '-', r.how);
  }

  // ------------------------------------------------------------------ liveness
  if (want('liveness')) {
    const query = q({ mode: 'ses', lockdown: LOCKDOWN });
    const inPage = (fn) => unit('liveness', async () => {
      const H = await newPage();
      // warm the HTTP cache so restarts measure a cached image, as a real reload would
      await H.page.evaluate(() => Promise.all([fetch('/dist/image.json').then((r) => r.text()), fetch('/dist/image-small.json').then((r) => r.text())]).then(() => null));
      const r = await fn(H);
      await H.close();
      return r;
    });
    results.liveness = {};
    results.liveness.infiniteLoop = await inPage((H) => H.page.evaluate(([query]) => self.H.liveness(query, '/dist/image-small.json', 500), [query]));
    results.liveness.coldStartSmallImage = await inPage((H) => H.page.evaluate(([query]) => self.H.coldStartStats(query, '/dist/image-small.json', 7), [query]));
    results.liveness.coldStartFullImage = await inPage((H) => H.page.evaluate(([query]) => self.H.coldStartStats(query, '/dist/image.json', 7), [query]));
    results.liveness.coldStartPlainSmallImage = await inPage((H) => H.page.evaluate(([query]) => self.H.coldStartStats(query, '/dist/image-small.json', 7), [q({ mode: 'plain' })]));
    results.liveness.interleave = await inPage(async (H) => {
      const w = await worker(H, { mode: 'ses', lockdown: LOCKDOWN }, '/dist/image-small.json');
      const pinger = H.page.evaluate(async (id) => { const end = performance.now() + 700; while (performance.now() < end) { await self.H.call(id, 'ping', {}); await new Promise((r) => setTimeout(r, 10)); } }, w.id);
      const r = await H.call(w.id, 'interleave', {});
      await pinger;
      return r;
    });
    log('liveness', JSON.stringify({ detect: results.liveness.infiniteLoop.detectedAfterMs, restart: results.liveness.infiniteLoop.restart.totalMs, small: results.liveness.coldStartSmallImage.median, full: results.liveness.coldStartFullImage.median }));
  }

  // ------------------------------------------------------------------ memory
  if (want('memory')) {
    results.memory = { note: 'usedJSHeapSize of the worker isolate via performance.memory inside the worker, after gc() x2 (--expose-gc, --enable-precise-memory-info)', series: {} };
    const mb = (b) => (b === null ? null : r2(b / 2 ** 20));
    Object.assign(results.memory, await unit('memory base', async () => {
      const H = await newPage();
      const out = {};
      const s = await H.spawn(q({ mode: 'plain' }));
      const m0 = await H.call(s.id, 'mem', {});
      out.gcAvailable = m0.gc; out.performanceMemoryInWorker = m0.usedJSHeapSize !== null;
      out.plainWorkerNoImageMb = mb(m0.usedJSHeapSize);
      await H.call(s.id, 'loadImage', { url: '/dist/image-small.json' });
      out.plainAfterSmallImageMb = mb((await H.call(s.id, 'mem', {})).usedJSHeapSize);
      await H.kill(s.id);
      const s2 = await H.spawn(q({ mode: 'ses', lockdown: LOCKDOWN }));
      out.sesAfterLockdownNoImageMb = mb((await H.call(s2.id, 'mem', {})).usedJSHeapSize);
      await H.call(s2.id, 'loadImage', { url: '/dist/image-small.json' });
      out.sesAfterSmallImageMb = mb((await H.call(s2.id, 'mem', {})).usedJSHeapSize);
      out.lockdownCostMb = r2(out.sesAfterLockdownNoImageMb - out.plainWorkerNoImageMb);
      await H.close();
      return out;
    }));
    for (const spec of [null, 'semver', 'lodash', 'zod']) {
      results.memory.series[spec || '(empty compartment, one evaluate)'] = await unit('memory ' + spec, async () => {
        const H = await newPage();
        const w = await worker(H, { mode: 'ses', lockdown: LOCKDOWN }, '/dist/image-small.json');
        const series = [{ n: 0, mb: mb((await H.call(w.id, 'mem', {})).usedJSHeapSize) }];
        let have = 0;
        for (const n of [1, 10, 50]) {
          await H.call(w.id, 'makeCompartments', { n: n - have, spec }); have = n;
          series.push({ n, mb: mb((await H.call(w.id, 'mem', {})).usedJSHeapSize) });
        }
        await H.close();
        return { series, firstCompartmentKb: r2((series[1].mb - series[0].mb) * 1024), perAdditionalCompartmentKb: r2(((series[3].mb - series[1].mb) * 1024) / 49) };
      });
    }
    // measureUserAgentSpecificMemory needs cross-origin isolation; try it on a COOP/COEP page.
    try {
      results.memory.measureUserAgentSpecificMemory = await unit('memory muasm', async () => {
        const C = await newPage(q({ coi: '1' }));
        const before = await C.page.evaluate(() => self.H.pageMemory(20000));
        const s = await C.spawn(q({ mode: 'ses', lockdown: LOCKDOWN, coi: '1' }));
        await C.call(s.id, 'loadImage', { url: '/dist/image-small.json' });
        await C.call(s.id, 'makeCompartments', { n: 50, spec: 'semver' });
        const after = await C.page.evaluate(() => self.H.pageMemory(20000));
        await C.close();
        return { before, afterWorkerWith50Compartments: after };
      }, 4);
    } catch (e) { results.memory.measureUserAgentSpecificMemory = { error: e.message.split('\n')[0] }; }
    log('memory', JSON.stringify(results.memory.series));
  }

  // ------------------------------------------------------------------ ESM experiments
  if (want('esm')) {
    results.esm = {};
    const pkgs = ['chalk', 'uuid', 'marked', 'nanoid', 'commander', 'chai', 'zod', 'date-fns'];
    const one = (mode, cmd, args) => unit('esm ' + cmd, async () => {
      const H = await newPage();
      const w = await worker(H, { mode, lockdown: LOCKDOWN });
      const r = await H.call(w.id, cmd, args);
      await H.close();
      return r;
    });
    results.esm.candidates = await one('ses', 'esmCandidates', { pkgs });
    for (const mode of ['ses', 'plain']) {
      results.esm['esbuildWasm:' + mode] = await one(mode, 'esbuildWasm', { pkgs });
      results.esm['moduleSource:' + mode] = await one(mode, 'moduleSource', { pkgs, entry: 'chalk' });
    }
    log('esm', JSON.stringify(results.esm).slice(0, 2500));
  }
} finally {
  await browser.close().catch(() => {});
  server.close();
}

function summarizeCensor(list) {
  if (!list || !list.length) return undefined;
  const by = {};
  for (const c of list) by[c.code] = (by[c.code] || 0) + 1;
  return by;
}

results.machine.loadAvgAtEnd = os.loadavg().map(r2);
fs.writeFileSync(path.join(root, 'dist/results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
