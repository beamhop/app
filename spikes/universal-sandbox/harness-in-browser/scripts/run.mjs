// `npm run spike`: drives every scenario in headless Chromium and prints one JSON document (also dist/results.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { startMock, FILE_NAME, FILE_TEXT, FINAL_PREFIX } from '../servers/mock-model.mjs';
import { startStatic } from '../servers/static.mjs';
import { startCorsProxy } from '../servers/cors-proxy.mjs';
import { startRelay } from '../servers/ws-relay.mjs';
import { scenario } from './scenarios.mjs';
import { connectSampler, freePort } from './heap-sampler.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist/build-manifest.json'), 'utf8'));
const REPEAT = Number(process.env.REPEAT || 5);
const log = (...a) => console.error('[spike]', ...a);
const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const mb = (x) => (x == null ? null : Math.round((x / 1048576) * 10) / 10);

// Both proxies only allow the mock model server: a harness must not reach a real provider from this spike.
const mock = await startMock();
const [stat, proxy, relay] = await Promise.all([startStatic({ dir: path.join(root, 'dist/web') }), startCorsProxy({ allow: (u) => u.hostname === '127.0.0.1' && Number(u.port) === mock.port }), startRelay({ allow: (h, p) => h === '127.0.0.1' && p === mock.port })]);
const debugPort = await freePort();
// The debugging port is used only by the heap sampler (scripts/heap-sampler.mjs); it does not change isolation.
const browser = await chromium.launch({ args: ['--remote-debugging-port=' + debugPort] });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(`http://127.0.0.1:${stat.port}/`);
const pageInfo = await page.evaluate(() => window.pageInfo());
const ports = { mockPort: mock.port, proxyPort: proxy.port, relayPort: relay.port };

async function runOne(harness, opts = {}) {
  const marks = { mock: mock.log.length, proxy: proxy.log.length, relay: relay.log.length };
  const cfg = scenario(harness, { ...ports, timeoutMs: 45000, ...opts });
  if (opts.script) { cfg.files['/work/probe.cjs'] = opts.script; cfg.entry = '/work/probe.cjs'; cfg.args = []; }
  const out = await page.evaluate((c) => window.runHarness(c), cfg);
  const rep = out.report || {}, m = rep.metrics || {};
  return {
    out, rep,
    mockLog: mock.log.slice(marks.mock), proxyLog: proxy.log.slice(marks.proxy), relayLog: relay.log.slice(marks.relay),
    summary: {
      exit: rep.exit, timedOut: out.timedOut, fatal: out.fatal || out.workerError || null,
      ms: { imageFetch: r1(m.images?.[0]?.fetchMs), imageMount: r1(m.images?.[0]?.mountMs), booted: r1(m.tBooted), firstOutput: r1(Math.min(m.tFirstStdout ?? Infinity, m.tFirstStderr ?? Infinity)), firstStdout: r1(m.tFirstStdout), exit: r1(m.tExit), moduleEval: r1(rep.loader?.evalMs) },
      modules: rep.loader && { esm: rep.loader.esm, cjs: rep.loader.cjs, json: rep.loader.json, evalMB: mb(rep.loader.evalBytes), missingEsm: [...new Set(rep.loader.missingEsm)] },
    },
  };
}
const firstLine = (s) => (s || '').split('\n').find((l) => l.trim()) || '';
function turnChecks(harness, r, netMode) {
  const { out, rep } = r;
  let finalAnswer = null;
  if (harness === 'pi') { for (const line of out.stdout.split('\n')) { try { const ev = JSON.parse(line); if (ev.type === 'agent_end') { const last = ev.messages.filter((x) => x.role === 'assistant').at(-1); finalAnswer = (last.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''); } } catch {} } }
  else if (harness === 'claude') { try { finalAnswer = JSON.parse(out.stdout.trim().split('\n').at(-1)).result; } catch {} }
  else if (harness === 'gemini') { try { finalAnswer = JSON.parse(out.stdout.slice(out.stdout.indexOf('{'))).response; } catch {} }
  const agentSteps = r.mockLog.filter((l) => l.agentRequest !== false && l.step != null && ['openai', 'anthropic', 'gemini'].includes(l.kind) && (l.kind !== 'gemini' || l.method === 'streamGenerateContent')).map((l) => l.step);
  const shellSpawn = (rep.childProcess?.spawns || []).find((s) => /cat hello\.txt/.test(s.args.join(' ')));
  const checks = {
    exitCode0: rep.exit?.code === 0,
    fileWrittenInVfs: rep.fsChecks?.['/work/' + FILE_NAME] === FILE_TEXT,
    shellToolRanInJustBash: !!shellSpawn && shellSpawn.exitCode === 0,
    mockSawThreeSteps: [0, 1, 2].every((s) => agentSteps.includes(s)),
    toolResultReachedModel: /hello from the universal sandbox\s*\n?lines=1/.test(r.mockLog.map((l) => l.lastToolResult || '').join('\n')),
    finalAnswerArrived: typeof finalAnswer === 'string' && finalAnswer.startsWith(FINAL_PREFIX) && finalAnswer.includes('lines=1'),
    networkOnlyViaExpectedProxy: netMode === 'bridge' ? r.proxyLog.length === r.mockLog.length && r.relayLog.length === 0 : r.relayLog.length > 0 && r.proxyLog.length === 0,
  };
  return { checks, pass: Object.values(checks).every(Boolean), finalAnswer: finalAnswer && finalAnswer.slice(0, 160), shellCommand: shellSpawn && { command: shellSpawn.command, exitCode: shellSpawn.exitCode, ms: shellSpawn.ms } };
}

const results = { environment: { note: 'headless Chromium (Playwright) in a cloud container; not a phone, not a desktop browser; nothing here says anything about Safari/iOS or Firefox', browser: browser.version(), userAgent: pageInfo.userAgent, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, totalMemGB: Math.round(os.totalmem() / 2 ** 30 * 10) / 10, node: process.version, date: new Date().toISOString(), repeat: REPEAT },
  isolation: { page: { crossOriginIsolated: pageInfo.crossOriginIsolated, typeofSharedArrayBuffer: pageInfo.sharedArrayBuffer } }, harnesses: {} };

const HARNESSES = (process.env.HARNESSES || 'pi,gemini,claude').split(',').filter((h) => manifest.images[h]);
const apiUsage = {}, syncObserved = {}, spawnsObserved = {};
const collect = (h, rep) => {
  for (const [k, v] of Object.entries(rep.usage || {})) { if (/^socket\.(ref|unref|destroy)$/.test(k)) continue; const u = ((apiUsage[h] ||= {})[k] ||= { count: 0, samples: [] }); u.count = Math.max(u.count, v.count); for (const s of v.samples) if (u.samples.length < 4 && !u.samples.includes(s)) u.samples.push(String(s).slice(0, 160)); }
  for (const c of rep.childProcess?.syncCalls || []) (syncObserved[h] ||= new Set()).add(c.api + ' ' + c.command.replace(/\d{6,}/g, 'N'));
  for (const s of rep.childProcess?.spawns || []) (spawnsObserved[h] ||= new Set()).add((s.enoent ? '[ENOENT] ' : '') + [s.command, ...s.args].join(' ').replace(/\s+/g, ' ').replace(/[0-9a-f]{8,}|\d{6,}|-[a-z0-9]{6}\b/g, '*').slice(0, 110));
};

for (const h of HARNESSES) {
  log(h, 'version/help');
  const H = (results.harnesses[h] = { image: manifest.images[h] && { bytes: manifest.images[h].imageBytes, gzipBytes: manifest.images[h].imageGzipBytes, files: manifest.images[h].files, dirs: manifest.images[h].dirs, esmPrecompiled: manifest.images[h].esmPrecompiled, esmPrecompiledBytes: manifest.images[h].esmPrecompiledBytes } });
  const v = await runOne(h, { args: ['--version'] }); collect(h, v.rep);
  H.version = { output: firstLine(v.out.stdout), stderr: v.out.stderr.slice(0, 300), ...v.summary, pass: v.rep.exit?.code === 0 && /\d+\.\d+\.\d+/.test(v.out.stdout) };
  results.isolation.worker ??= { crossOriginIsolated: v.rep.metrics.crossOriginIsolated, typeofSharedArrayBuffer: v.rep.metrics.typeofSharedArrayBuffer, typeofAtomicsWait: v.rep.metrics.typeofAtomicsWait, measureUserAgentSpecificMemory: v.rep.metrics.measureUserAgentSpecificMemory };
  const hp = await runOne(h, { args: ['--help'] }); collect(h, hp.rep);
  H.help = { firstLine: firstLine(hp.out.stdout), stdoutBytes: hp.out.stdout.length, exit: hp.rep.exit, pass: hp.rep.exit?.code === 0 && /usage/i.test(hp.out.stdout) };

  H.turn = {};
  for (const [label, opts] of Object.entries({ 'plain+bridge': { variant: 'plain', netMode: 'bridge' }, 'plain+tunnel': { variant: 'plain', netMode: 'tunnel' }, 'ses+bridge': { variant: 'ses', netMode: 'bridge' } })) {
    log(h, 'turn', label);
    const runs = [];
    for (let i = 0; i < REPEAT; i++) { const r = await runOne(h, opts); collect(h, r.rep); runs.push({ r, t: turnChecks(h, r, opts.netMode) }); }
    const last = runs.at(-1);
    const T = (H.turn[label] = {
      pass: runs.every((x) => x.t.pass), runs: runs.length, checks: last.t.checks, finalAnswer: last.t.finalAnswer, shellCommand: last.t.shellCommand, exit: last.r.rep.exit,
      stderrFirstLines: last.r.out.stderr.split('\n').filter(Boolean).slice(0, 6).map((l) => l.slice(0, 200)),
      medianMs: Object.fromEntries(Object.keys(last.r.summary.ms).map((k) => [k, median(runs.map((x) => x.r.summary.ms[k]))])),
      minMaxExitMs: [Math.min(...runs.map((x) => x.r.summary.ms.exit ?? Infinity)), Math.max(...runs.map((x) => x.r.summary.ms.exit ?? -Infinity))],
      modules: last.r.summary.modules,
      network: opts.netMode === 'bridge'
        ? { proxyRequests: last.r.proxyLog.length, mockRequests: last.r.mockLog.length, relayConnections: last.r.relayLog.length, socketsOpenedByHarness: last.r.rep.net?.sockets, viaEmulatedFetch: last.r.rep.net?.requests.filter((q) => q.via === 'proxied-fetch').length, streaming: (last.r.rep.net?.requests || []).filter((q) => q.chunks > 1).slice(-1).map((q) => ({ chunks: q.chunks, firstChunkMs: r1(q.tFirstChunk), endMs: r1(q.tEnd) }))[0] ?? null, proxyChunksDownLastRequest: last.r.proxyLog.at(-1)?.chunksDown }
        : { relayConnections: last.r.relayLog.length, relayBytesUp: last.r.relayLog.reduce((a, b) => a + b.bytesUp, 0), relayBytesDown: last.r.relayLog.reduce((a, b) => a + b.bytesDown, 0), firstBytesOnTheWire: last.r.relayLog[0]?.firstBytesUp?.split('\r\n')[0], proxyRequests: last.r.proxyLog.length, mockRequests: last.r.mockLog.length },
      ses: last.r.rep.ses && { lockdownError: last.r.rep.ses.lockdownOptions.lockdownError, sesBuild: last.r.rep.ses.lockdownOptions.sesBuild, lockdownMs: r1(last.r.rep.ses.lockdownMs), filesThatWouldHitCensor: last.r.rep.ses.filesThatWouldHitCensor, extraGlobalsEndowed: last.r.rep.ses.extraGlobalsEndowed },
    });
    if (!T.pass) T.failure = { stdoutTail: last.r.out.stdout.slice(-600), stderr: last.r.out.stderr.slice(0, 1500) };
  }
  const p = H.turn['plain+bridge'].medianMs, s = H.turn['ses+bridge'].medianMs;
  H.sesSlowdown = { turnExitMs: { plain: p.exit, ses: s.exit, ratio: r1(s.exit / p.exit) }, firstOutputMs: { plain: p.firstOutput, ses: s.firstOutput, ratio: r1(s.firstOutput / p.firstOutput) }, moduleEvalMs: { plain: p.moduleEval, ses: s.moduleEval, ratio: r1(s.moduleEval / p.moduleEval) } };
}

// ---- heap (separate pass so that sampling does not disturb the timings above) ----
log('heap pass');
try {
  const sampler = await connectSampler(debugPort, `http://127.0.0.1:${stat.port}/`);
  for (const h of HARNESSES) {
    const H = results.harnesses[h];
    const a = await sampler.during(() => runOne(h, { args: ['--version'] }));
    const b = await sampler.during(() => runOne(h, { variant: 'plain', netMode: 'bridge' }));
    const c = await sampler.during(() => runOne(h, { variant: 'ses', netMode: 'bridge' }));
    H.workerHeap = { method: 'CDP Runtime.getHeapUsage on the worker, sampled every ~40 ms; V8 heap only (the image ArrayBuffer is backing store, reported separately when the browser exposes it)', loadOnly_version: a.heap, fullTurn_plain: b.heap, fullTurn_ses: c.heap };
  }
  sampler.close();
} catch (e) { results.heapError = String(e && e.stack || e).slice(0, 400); }

// ---- Hardened JS extras ----
log('ses probes');
const PROBE = `
const out = {};
out.objectPrototypeFrozen = Object.isFrozen(Object.prototype);
out.arrayPrototypeFrozen = Object.isFrozen(Array.prototype);
out.globalIsNotWorkerGlobal = typeof self === 'undefined' && typeof importScripts === 'undefined' && typeof postMessage === 'undefined';
out.functionConstructorGlobal = (() => { try { const g = new Function('return this')(); return g === globalThis ? 'compartment global' : typeof g; } catch (e) { return 'throws: ' + e.message; } })();
out.functionConstructorSeesWorker = (() => { try { return new Function('return typeof importScripts')(); } catch (e) { return 'throws'; } })();
out.pollutionBlocked = (() => { try { Object.prototype.polluted = 1; return ({}).polluted === 1 ? 'NOT blocked' : 'silently ignored'; } catch (e) { return 'throws ' + e.constructor.name; } })();
out.dateNowWorks = typeof Date.now() === 'number' && !Number.isNaN(Date.now());
out.mathRandomWorks = (() => { try { return typeof Math.random() === 'number'; } catch { return false; } })();
out.missingStandardGlobals = ['Float64Array','Float32Array','Float16Array','SharedArrayBuffer','Atomics','DisposableStack','AsyncDisposableStack','SuppressedError','WeakRef','FinalizationRegistry','Iterator','Intl','Proxy','Reflect','WebAssembly'].filter((n) => typeof globalThis[n] === 'undefined');
out.errorCaptureStackTrace = typeof Error.captureStackTrace;
console.log(JSON.stringify(out));
`;
const first = HARNESSES[0];
if (first) {
  const probe = async (opts) => { const r = await runOne(first, { variant: 'ses', script: PROBE, ...opts }); try { return JSON.parse(r.out.stdout); } catch { return { error: (r.out.stderr || r.out.fatal || '').slice(0, 400) }; } };
  results.hardenedJs = { probeInsideCompartment: await probe({}), probeWithoutExtraGlobals: await probe({ sesExtraGlobals: [] }) };
  if (HARNESSES.includes('pi')) {
    const stock = await runOne('pi', { variant: 'ses', sesBuild: 'stock' });
    const t = turnChecks('pi', stock, 'bridge');
    results.hardenedJs.piWithStockSes = { pass: t.pass, checks: t.checks, errorMessages: [...new Set([...stock.out.stdout.matchAll(/"errorMessage":"([^"]*)"/g)].map((m) => m[1]))], stderr: stock.out.stderr.slice(0, 300) };
    const noFloat = await runOne('pi', { variant: 'ses', sesExtraGlobals: [] });
    results.hardenedJs.piWithoutExtraGlobals = { pass: turnChecks('pi', noFloat, 'bridge').pass, stderr: firstLine(noFloat.out.stderr).slice(0, 200) };
  }
}

// ---- native reference for pi (same mock, real Node.js) ----
try {
  const times = [];
  for (let i = 0; i < 3; i++) { const j = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/native-baseline.mjs')], { encoding: 'utf8' })); if (j.code === 0) times.push(j.ms); }
  results.nativeReference = { what: 'same pi turn on real Node.js ' + process.version + ' against the same mock, direct connection (wall time of the child process)', medianMs: median(times), runs: times };
} catch (e) { results.nativeReference = { error: String(e.message).slice(0, 200) }; }

results.observedApiUsage = apiUsage;
results.observedSyncChildProcessCalls = Object.fromEntries(Object.entries(syncObserved).map(([k, v]) => [k, [...v]]));
results.observedSpawns = Object.fromEntries(Object.entries(spawnsObserved).map(([k, v]) => [k, [...v].slice(0, 25)]));
results.runtime = manifest.runtime;
results.imagesBuild = Object.fromEntries(Object.entries(manifest.images).map(([k, v]) => [k, { files: v.files, dirs: v.dirs, symlinks: v.symlinks, fileBytes: v.fileBytes, imageBytes: v.imageBytes, imageGzipBytes: v.imageGzipBytes, esmPrecompiled: v.esmPrecompiled, esmPrecompiledBytes: v.esmPrecompiledBytes, excluded: v.excluded, babelFailed: v.babel.failed.length }]));
try { const scan = JSON.parse(fs.readFileSync(path.join(root, 'dist/sync-scan.json'), 'utf8')); results.staticSyncScan = Object.fromEntries(Object.entries(scan).map(([k, v]) => [k, { filesScanned: v.filesScanned, distinctCallSites: v.counts }])); } catch {}
results.pageErrors = pageErrors;
results.destinationsDeniedByProxy = { corsProxy: [...new Set(proxy.denied)], relay: [...new Set(relay.log.filter((l) => l.denied).map((l) => l.host + ':' + l.port))] };
results.allTurnsPass = Object.fromEntries(Object.entries(results.harnesses).map(([h, H]) => [h, Object.fromEntries(Object.entries(H.turn).map(([k, v]) => [k, v.pass]))]));

await browser.close();
await Promise.all([mock.close(), stat.close(), proxy.close(), relay.close()]);
fs.writeFileSync(path.join(root, 'dist/results.json'), JSON.stringify(results, null, 1));
fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));
