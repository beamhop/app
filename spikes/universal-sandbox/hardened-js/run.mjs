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
const browser = await chromium.launch({ args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const results = {
  meta: JSON.parse(fs.readFileSync(path.join(root, 'dist/meta.json'), 'utf8')),
  machine: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, totalMemGb: r2(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${os.release()}`, node: process.version, browser: 'chromium ' + browser.version() + ' (headless, Playwright)' },
  lockdownOptionsUsed: LOCKDOWN,
};
delete results.meta.packages;

async function newPage(query = '') {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => log('pageerror', e.message));
  page.on('crash', () => log('PAGE CRASHED'));
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
    const H = await newPage();
    const env = await H.page.evaluate(() => ({ userAgent: navigator.userAgent, crossOriginIsolated: self.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer, hardwareConcurrency: navigator.hardwareConcurrency }));
    results.env = env;
    const variants = {
      'defaults {}': {},
      'spike options': LOCKDOWN,
      "overrideTaming:'severe'": { ...LOCKDOWN, overrideTaming: 'severe' },
      "overrideTaming:'min'": { ...LOCKDOWN, overrideTaming: 'min' },
      "errorTaming:'safe'": { ...LOCKDOWN, errorTaming: 'safe' },
      "consoleTaming:'unsafe'": { ...LOCKDOWN, consoleTaming: 'unsafe' },
    };
    results.lockdown = {};
    for (const [name, opts] of Object.entries(variants)) {
      const runs = [];
      for (let i = 0; i < 5; i++) { const s = await H.spawn(q({ mode: 'ses', lockdown: opts })); runs.push(s); await H.kill(s.id); }
      results.lockdown[name] = {
        options: opts, errors: runs[0].boot.errors,
        lockdownMsMedian: r2(median(runs.map((r) => r.boot.lockdownMs))), sesScriptMsMedian: r2(median(runs.map((r) => r.boot.sesScriptMs))),
        firstEvaluateMsMedian: r2(median(runs.map((r) => r.boot.firstEvaluateMs))), spawnToReadyMsMedian: r2(median(runs.map((r) => r.spawnToReadyMs))),
        lockdownMsAll: runs.map((r) => r2(r.boot.lockdownMs)),
      };
    }
    const plain = [];
    for (let i = 0; i < 5; i++) { const s = await H.spawn(q({ mode: 'plain' })); plain.push(s.spawnToReadyMs); await H.kill(s.id); }
    results.lockdown['(plain worker, no ses)'] = { spawnToReadyMsMedian: r2(median(plain)) };
    log('lockdown', JSON.stringify(Object.fromEntries(Object.entries(results.lockdown).map(([k, v]) => [k, v.lockdownMsMedian ?? v.spawnToReadyMsMedian]))));
    await H.close();
  }

  // ------------------------------------------------------------------ CSP
  if (want('csp')) {
    results.csp = [];
    const cases = [
      { label: "no CSP", page: '', worker: '' },
      { label: "page+worker: script-src 'self'", page: "script-src 'self'", worker: "script-src 'self'" },
      { label: "page+worker: script-src 'self', lockdown evalTaming:'no-eval'", page: "script-src 'self'", worker: "script-src 'self'", lockdown: { ...LOCKDOWN, evalTaming: 'no-eval' } },
      { label: "page+worker: script-src 'self' 'wasm-unsafe-eval'", page: "script-src 'self' 'wasm-unsafe-eval'", worker: "script-src 'self' 'wasm-unsafe-eval'" },
      { label: "page+worker: script-src 'self' 'unsafe-eval'", page: "script-src 'self' 'unsafe-eval'", worker: "script-src 'self' 'unsafe-eval'" },
      { label: "page only: script-src 'self' (worker response has no CSP header)", page: "script-src 'self'", worker: '' },
      { label: "page: script-src 'self'; worker: script-src 'self' 'unsafe-eval'", page: "script-src 'self'", worker: "script-src 'self' 'unsafe-eval'" },
      { label: "worker: script-src 'self' 'unsafe-eval'; connect-src 'none' (defence in depth)", page: '', worker: "script-src 'self' 'unsafe-eval'; connect-src 'none'", noImage: true },
    ];
    for (const c of cases) {
      const H = await newPage(c.page ? q({ csp: c.page }) : '');
      const rec = { label: c.label };
      try {
        const o = { mode: 'ses', lockdown: c.lockdown || LOCKDOWN };
        if (c.worker) o.csp = c.worker;
        const s = await H.spawn(q(o));
        rec.lockdownOk = s.boot.lockdownMs !== undefined && !s.boot.errors.some((e) => e.startsWith('lockdown'));
        rec.compartmentEvaluateOk = s.boot.firstEvaluate === 2;
        rec.errors = s.boot.errors;
        rec.wasm = await H.call(s.id, 'wasmProbe', {});
        if (rec.compartmentEvaluateOk && !c.noImage) {
          await H.call(s.id, 'loadImage', { url: '/dist/image-small.json' });
          const r = await H.call(s.id, 'compat', { test: 'ajv' });
          rec.guestPackageOk = r.ok ? 'ajv ok' : r.error.message;
        }
        if (c.noImage) rec.kernelFetch = await H.call(s.id, 'loadImage', { url: '/dist/image-small.json' }).then(() => 'fetch allowed', (e) => 'fetch blocked: ' + e.message.split('\n')[0]);
      } catch (e) { rec.spawnError = e.message; }
      results.csp.push(rec);
      log('csp', JSON.stringify(rec));
      await H.close();
    }
  }

  // ------------------------------------------------------------------ compatibility
  if (want('compat')) {
    const H = await newPage();
    const configs = {
      plain: { mode: 'plain' },
      'ses-moderate-minimal': { mode: 'ses', lockdown: LOCKDOWN, profile: 'minimal' },
      'ses-moderate': { mode: 'ses', lockdown: LOCKDOWN, profile: 'extended' },
      'ses-severe': { mode: 'ses', lockdown: { ...LOCKDOWN, overrideTaming: 'severe' }, profile: 'extended' },
      'ses-min': { mode: 'ses', lockdown: { ...LOCKDOWN, overrideTaming: 'min' }, profile: 'extended' },
      'ses-moderate-errorTaming-safe': { mode: 'ses', lockdown: { ...LOCKDOWN, errorTaming: 'safe' }, profile: 'extended' },
    };
    results.compat = { configs, tests: {} };
    for (const [name, cfg] of Object.entries(configs)) {
      const w = await worker(H, { mode: cfg.mode, lockdown: cfg.lockdown || {} });
      const list = await H.call(w.id, 'compatList', {});
      let pass = 0;
      for (const test of list) {
        const r = await H.call(w.id, 'compat', { test, profile: cfg.profile });
        (results.compat.tests[test] ||= {})[name] = r.ok
          ? { ok: true, detail: r.detail, ms: r.ms, modules: r.modules, esmModules: r.esmModules, censored: summarizeCensor(r.censored) }
          : { ok: false, error: `${r.error.name}: ${r.error.message}`, stack: r.error.stack, censored: summarizeCensor(r.censored) };
        if (r.ok) pass++; else log('compat FAIL', name, test, r.error.name + ': ' + r.error.message.slice(0, 300));
      }
      log('compat', name, `${pass}/${list.length}`);
      await H.kill(w.id);
    }
    await H.close();
  }

  // ------------------------------------------------------------------ performance
  if (want('perf')) {
    const H = await newPage();
    const modes = {
      plain: { spawn: { mode: 'plain' }, run: {} },
      ses: { spawn: { mode: 'ses', lockdown: LOCKDOWN }, run: {} },
      'ses+pinnedGlobals': { spawn: { mode: 'ses', lockdown: LOCKDOWN }, run: { pinGlobals: true } },
    };
    const workloads = [['tscheck', 5, 1], ['marked', 7, 2], ['zod', 7, 2], ['numericLocals', 9, 2], ['numericGlobals', 9, 2], ['json', 7, 2], ['lodash', 7, 2], ['acorn', 7, 2]];
    const ROUNDS = 2;
    const perf = {};
    const loads = {};
    for (let round = 0; round < ROUNDS; round++) {
      for (const [mode, cfg] of Object.entries(modes)) {
        const w = await worker(H, cfg.spawn);
        // module load time first, on a cold worker
        for (const spec of ['typescript', 'lodash', 'zod', 'prettier/standalone']) {
          const r = await H.call(w.id, 'loadTime', { spec, runs: 3, ...cfg.run });
          log('load', `round ${round}`, mode, spec, JSON.stringify(r.times));
          ((loads[spec] ||= {})[mode] ||= []).push(r);
        }
        for (const [workload, iters, warmup] of workloads) {
          const r = await H.call(w.id, 'perf', { workload, iters, warmup, ...cfg.run });
          ((perf[workload] ||= {})[mode] ||= []).push(...r.times);
          log('perf', `round ${round}`, mode, workload, 'median', r.median, 'ms');
        }
        await H.kill(w.id);
      }
    }
    results.perf = { rounds: ROUNDS, note: 'each mode runs in its own fresh worker per round; times pooled over rounds', workloads: {} };
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
      for (const [mode, rs] of Object.entries(byMode)) row[mode] = { coldFirstLoadMs: rs.map((r) => r.first), coldFirstLoadMedianMs: r2(median(rs.map((r) => r.first))), warmReloadMedianMs: r2(median(rs.flatMap((r) => r.times.slice(1)))), modules: rs[0].modules, sourceBytes: rs[0].sourceBytes };
      row.slowdownColdSes = r2(row.ses.coldFirstLoadMedianMs / row.plain.coldFirstLoadMedianMs);
      results.perf.moduleLoad[spec] = row;
    }
    const w = await worker(H, { mode: 'ses', lockdown: LOCKDOWN });
    results.perf.compartmentCreate = await H.call(w.id, 'compartmentCreate', { n: 200 });
    await H.close();
  }

  // ------------------------------------------------------------------ confinement
  if (want('confine')) {
    const H = await newPage();
    const ses = await worker(H, { mode: 'ses', lockdown: LOCKDOWN });
    const a = await H.call(ses.id, 'confine', {});
    const safe = await worker(H, { mode: 'ses', lockdown: { ...LOCKDOWN, errorTaming: 'safe' } });
    const s = await H.call(safe.id, 'confine', {});
    const plain = await worker(H, { mode: 'plain' });
    const b = await H.call(plain.id, 'confine', {});
    results.confinement = {
      note: 'status is for the SES compartment (spike lockdown options); controlPlain is the same probe run by plain eval in a worker without SES',
      realGlobalSideEffects: a.realGlobalSideEffects, intrinsicsStillFrozen: a.intrinsicsStillFrozen,
      results: a.results.map((r, i) => ({ ...r, controlPlain: b.results[i].status, errorTamingSafe: s.results[i].status !== r.status || r.group === 'errors' ? { status: s.results[i].status, how: s.results[i].how } : undefined })),
    };
    const counts = {};
    for (const r of a.results) counts[r.status + (r.whatIf ? ' (what-if)' : '')] = (counts[r.status + (r.whatIf ? ' (what-if)' : '')] || 0) + 1;
    results.confinement.counts = counts;
    log('confine', JSON.stringify(counts), 'side effects:', JSON.stringify(a.realGlobalSideEffects));
    for (const r of a.results) if (r.status === 'reachable') log('REACHABLE', r.name, '-', r.how);
    await H.close();
  }

  // ------------------------------------------------------------------ liveness
  if (want('liveness')) {
    const H = await newPage();
    const query = q({ mode: 'ses', lockdown: LOCKDOWN });
    // warm the HTTP cache so restarts measure a cached image, as a real reload would
    await H.page.evaluate(() => Promise.all([fetch('/dist/image.json').then((r) => r.text()), fetch('/dist/image-small.json').then((r) => r.text())]).then(() => null));
    results.liveness = {};
    results.liveness.infiniteLoop = await H.page.evaluate(([query]) => self.H.liveness(query, '/dist/image-small.json', 500), [query]);
    results.liveness.coldStartSmallImage = await H.page.evaluate(([query]) => self.H.coldStartStats(query, '/dist/image-small.json', 7), [query]);
    results.liveness.coldStartFullImage = await H.page.evaluate(([query]) => self.H.coldStartStats(query, '/dist/image.json', 7), [query]);
    results.liveness.coldStartPlainSmallImage = await H.page.evaluate(([query]) => self.H.coldStartStats(query, '/dist/image-small.json', 7), [q({ mode: 'plain' })]);
    const w = await worker(H, { mode: 'ses', lockdown: LOCKDOWN }, '/dist/image-small.json');
    const pinger = H.page.evaluate(async (id) => { const end = performance.now() + 700; while (performance.now() < end) { await self.H.call(id, 'ping', {}); await new Promise((r) => setTimeout(r, 10)); } }, w.id);
    results.liveness.interleave = await H.call(w.id, 'interleave', {});
    await pinger;
    log('liveness', JSON.stringify({ detect: results.liveness.infiniteLoop.detectedAfterMs, restart: results.liveness.infiniteLoop.restart.totalMs, small: results.liveness.coldStartSmallImage.median, full: results.liveness.coldStartFullImage.median }));
    await H.close();
  }

  // ------------------------------------------------------------------ memory
  if (want('memory')) {
    results.memory = { note: 'usedJSHeapSize of the worker isolate via performance.memory inside the worker, after gc() x2 (--expose-gc, --enable-precise-memory-info)', series: {} };
    const H = await newPage();
    const mb = (b) => (b === null ? null : r2(b / 2 ** 20));
    {
      const s = await H.spawn(q({ mode: 'plain' }));
      const m0 = await H.call(s.id, 'mem', {});
      results.memory.gcAvailable = m0.gc; results.memory.performanceMemoryInWorker = m0.usedJSHeapSize !== null;
      results.memory.plainWorkerNoImageMb = mb(m0.usedJSHeapSize);
      await H.kill(s.id);
      const s2 = await H.spawn(q({ mode: 'ses', lockdown: LOCKDOWN }));
      results.memory.sesAfterLockdownNoImageMb = mb((await H.call(s2.id, 'mem', {})).usedJSHeapSize);
      await H.call(s2.id, 'loadImage', { url: '/dist/image-small.json' });
      results.memory.sesAfterSmallImageMb = mb((await H.call(s2.id, 'mem', {})).usedJSHeapSize);
      await H.kill(s2.id);
    }
    for (const spec of [null, 'semver', 'lodash', 'zod']) {
      const w = await worker(H, { mode: 'ses', lockdown: LOCKDOWN }, '/dist/image-small.json');
      const series = [{ n: 0, mb: mb((await H.call(w.id, 'mem', {})).usedJSHeapSize) }];
      let have = 0;
      for (const n of [1, 10, 50]) {
        await H.call(w.id, 'makeCompartments', { n: n - have, spec }); have = n;
        series.push({ n, mb: mb((await H.call(w.id, 'mem', {})).usedJSHeapSize) });
      }
      const perCompartmentKb = r2(((series[3].mb - series[1].mb) * 1024) / 49);
      results.memory.series[spec || '(empty compartment, one evaluate)'] = { series, perCompartmentKb };
      await H.kill(w.id);
    }
    await H.close();
    // measureUserAgentSpecificMemory needs cross-origin isolation; try it on a COOP/COEP page.
    const C = await newPage(q({ coi: '1' }));
    try {
      const before = await C.page.evaluate(() => self.H.pageMemory(45000));
      const s = await C.spawn(q({ mode: 'ses', lockdown: LOCKDOWN, coi: '1' }));
      await C.call(s.id, 'loadImage', { url: '/dist/image-small.json' });
      await C.call(s.id, 'makeCompartments', { n: 50, spec: 'semver' });
      const after = await C.page.evaluate(() => self.H.pageMemory(45000));
      results.memory.measureUserAgentSpecificMemory = { before, afterWorkerWith50Compartments: after };
    } catch (e) { results.memory.measureUserAgentSpecificMemory = { error: e.message }; }
    await C.close();
    log('memory', JSON.stringify(results.memory.series));
  }

  // ------------------------------------------------------------------ ESM experiments
  if (want('esm')) {
    const H = await newPage();
    results.esm = {};
    const pkgs = ['chalk', 'uuid', 'marked', 'nanoid', 'commander', 'chai', 'zod', 'date-fns'];
    const w0 = await worker(H, { mode: 'ses', lockdown: LOCKDOWN });
    results.esm.candidates = await H.call(w0.id, 'esmCandidates', {});
    await H.kill(w0.id);
    for (const mode of ['ses', 'plain']) {
      const w = await worker(H, { mode, lockdown: LOCKDOWN });
      results.esm['esbuildWasm:' + mode] = await H.call(w.id, 'esbuildWasm', { pkgs });
      await H.kill(w.id);
      const w2 = await worker(H, { mode, lockdown: LOCKDOWN });
      results.esm['moduleSource:' + mode] = await H.call(w2.id, 'moduleSource', { pkgs, entry: 'chalk' });
      await H.kill(w2.id);
    }
    log('esm', JSON.stringify(results.esm).slice(0, 1500));
    await H.close();
  }
} finally {
  await browser.close();
  server.close();
}

function summarizeCensor(list) {
  if (!list || !list.length) return undefined;
  const by = {};
  for (const c of list) by[c.code] = (by[c.code] || 0) + 1;
  return by;
}

fs.writeFileSync(path.join(root, 'dist/results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
