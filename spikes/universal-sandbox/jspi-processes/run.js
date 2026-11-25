#!/usr/bin/env node
// One-command driver: `npm run spike` (or `node run.js [--quick]`).
// Starts the static server (no COOP/COEP), launches headless Chromium via Playwright,
// runs every test/benchmark, prints one JSON document to stdout and writes results.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { start } = require('./server');

const QUICK = process.argv.includes('--quick');
const REPS = QUICK ? 3 : 7;
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sum of Pss (kB) of every process below this node process = the whole browser.
function browserPssMB() {
  const ppid = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      ppid.set(+d, +stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch {}
  }
  let kb = 0;
  for (const pid of ppid.keys()) {
    let p = pid;
    let mine = false;
    for (let i = 0; i < 20 && p > 1; i++) { p = ppid.get(p); if (p === process.pid) { mine = true; break; } }
    if (!mine) continue;
    try {
      const m = /^Pss:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
      if (m) kb += +m[1];
    } catch {}
  }
  return Math.round(kb / 1024);
}

async function openPage(browser, url) {
  const page = await browser.newPage();
  const s = { page, crashed: false };
  s.crash = new Promise((r) => page.on('crash', () => { s.crashed = true; r({ PAGE_CRASHED: true }); }));
  page.on('pageerror', (e) => log('[pageerror]', e.message));
  await page.goto(url);
  await page.evaluate(() => window.spikeReady);
  s.call = (cmd, args, timeoutMs = 120000) =>
    Promise.race([
      page.evaluate(([c, a]) => spike.call(c, a), [cmd, args]).catch((e) => ({ ERROR: e.message.split('\n')[0].slice(0, 300) })),
      s.crash,
      sleep(timeoutMs).then(() => ({ TIMEOUT_MS: timeoutMs })),
    ]);
  s.withPings = (cmd, args, every) => page.evaluate(([c, a, e]) => spike.callWithPings(c, a, e), [cmd, args, every]).catch((e) => ({ ERROR: e.message.slice(0, 300) }));
  s.load = await s.call('load');
  return s;
}

(async () => {
  const server = await start();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const R = {
    meta: {
      date: new Date().toISOString(),
      caveat: 'headless Chromium in a cloud container (not a phone, not Safari, not Firefox); numbers are indicative only',
      cpu: os.cpus()[0].model, cores: os.cpus().length, memGB: +(os.totalmem() / 2 ** 30).toFixed(1),
      node: process.version, repsPerMeasurement: REPS, quick: QUICK,
    },
  };

  // ---- 0. server really sends no isolation headers
  const head = await fetch(url);
  R.served = {
    'cross-origin-opener-policy': head.headers.get('cross-origin-opener-policy'),
    'cross-origin-embedder-policy': head.headers.get('cross-origin-embedder-policy'),
  };

  let browser = await chromium.launch();
  R.meta.chromium = browser.version();
  let s = await openPage(browser, url);
  const med = async (label, cmd, args, pick) => {
    const samples = [];
    let last;
    for (let i = 0; i < REPS; i++) {
      last = await s.call(cmd, args);
      if (last.ERROR || last.TIMEOUT_MS || last.PAGE_CRASHED) return { failed: last };
      samples.push(pick(last));
    }
    log(`  ${label}: median ${median(samples)}  [${samples.join(', ')}]`);
    return { median: median(samples), samples, lastRun: last };
  };

  // ---- 1. environment
  log('env');
  R.env = { page: await s.page.evaluate(() => spike.pageEnv()), worker: await s.call('env') };
  R.programs = s.load;

  // ---- 2. correctness
  log('correctness');
  R.correctness = {
    pipeline_200k_lines_with_sleeps: await s.call('pipeline', { lines: 200000, sleepEvery: 20000, sleepMs: 2 }),
    pipeline_2stage_exact_output_1000_lines: await s.call('pipeline', { lines: 1000, stages: 2, sleepEvery: 100, sleepMs: 1 }),
    pipeline_200k_lines_no_shim: await s.call('pipeline', { lines: 200000, shim: false }),
    waitchild: await s.call('waitchild'),
  };

  // ---- 3. measurements (medians)
  log('measurements');
  const M = (R.measurements = {});
  const N = QUICK ? 1000000 : 3000000;
  M.a_syscall_ns = {};
  for (const [label, args] of [
    ['calc_no_syscall_baseline', { mode: 'calc', n: N }],
    ['nop_plain_import', { mode: 'nop', n: N }],
    ['nop_Suspending_import_returning_number', { mode: 'nop_susp', n: N }],
    ['nop_Suspending_import_returning_resolved_promise', { mode: 'nop_async', n: N }],
    ['clock_time_get_plain_import', { mode: 'clock', n: N }],
    ['fd_write_1byte_null_via_shim', { mode: 'write', n: N, shim: true }],
    ['fd_write_1byte_null_direct_Suspending', { mode: 'write', n: N, shim: false }],
  ]) M.a_syscall_ns[label] = strip(await med(label, 'spin', args, (r) => r.nsPerCall));

  M.a_context_switch_ns = {
    pingpong_shim: strip(await med('pingpong shim', 'pingpong', { rounds: 200000, shim: true }, (r) => r.nsPerProcessSwitch), ['kernelBlocks', 'processSwitches', 'syscalls', 'ms']),
    pingpong_no_shim: strip(await med('pingpong no shim', 'pingpong', { rounds: 200000, shim: false }, (r) => r.nsPerProcessSwitch), ['kernelBlocks', 'processSwitches', 'syscalls', 'ms']),
  };

  const pkeep = ['ok', 'ms', 'syscalls', 'kernelBlocks', 'jspiSuspendingCalls', 'processSwitches', 'blocksPerProc', 'maxBufferedBetweenStages', 'bytesPerStage'];
  M.a_pipeline_MBps = {};
  for (const [label, args] of [
    ['pipe4k_line_buffered_shim', { lines: 200000 }],
    ['pipe4k_line_buffered_no_shim', { lines: 200000, shim: false }],
    ['pipe4k_64k_guest_buffers_shim', { lines: 200000, buf: true }],
    ['pipe64k_line_buffered_shim', { lines: 200000, pipeCap: 65536 }],
    ['pipe4k_line_buffered_shim_timeslice8ms', { lines: 200000, sliceMs: 8 }],
  ]) M.a_pipeline_MBps[label] = strip(await med(label, 'pipeline', args, (r) => r.throughputMBps), pkeep);

  const NB = QUICK ? 5000 : 20000;
  M.b_syscall_us = {
    raw_js_MessageChannel_round_trip_baseline: strip(await med('raw msg round trip', 'msgRoundTrip', { n: NB }, (r) => r.usPerRoundTrip)),
    nop: strip(await med('b nop', 'spin', { mode: 'nop', n: NB, placement: 'b' }, (r) => +(r.nsPerCall / 1000).toFixed(2))),
    clock_time_get: strip(await med('b clock', 'spin', { mode: 'clock', n: NB, placement: 'b' }, (r) => +(r.nsPerCall / 1000).toFixed(2))),
    fd_write_1byte_null: strip(await med('b write', 'spin', { mode: 'write', n: NB, placement: 'b' }, (r) => +(r.nsPerCall / 1000).toFixed(2))),
  };
  M.b_pipeline_MBps = strip(await med('b pipeline', 'pipeline', { lines: QUICK ? 5000 : 20000, placement: 'b' }, (r) => r.throughputMBps), ['ok', 'ms', 'syscalls', 'lines']);

  const sc = [];
  for (let i = 0; i < REPS; i++) sc.push(await s.call('spawnCost', {}));
  M.spawn = {};
  if (sc[0].ERROR) M.spawn.failed = sc[0];
  else for (const key of Object.keys(sc[0]).filter((k2) => typeof sc[0][k2] === 'number')) M.spawn[key] = { median: median(sc.map((x) => x[key])), samples: sc.map((x) => x[key]) };
  M.spawn.note = 'a_* in microseconds per process (batch of 200), b_* in milliseconds; all from an already compiled WebAssembly.Module';

  // ---- 4. is the kernel deaf while coroutines run? (page pings the worker every 5 ms)
  log('responsiveness');
  await s.call('pipeline', { lines: 1000000 }); // warm the expected-output cache
  R.responsiveness = {
    pipeline_1M_lines_no_timeslice: pingSummary(await s.withPings('pipeline', { lines: 1000000 }, 5)),
    pipeline_1M_lines_timeslice_8ms: pingSummary(await s.withPings('pipeline', { lines: 1000000, sliceMs: 8 }, 5)),
    placement_b_burner_killed_by_kernel: await s.withPings('burnRemote', { killAfterMs: 300 }, 5),
  };

  // ---- 5. robustness
  log('robustness');
  R.kill = await s.call('kill');
  R.trap = await s.call('trap', { modes: ['trap', 'panic', 'overflow'] });
  R.manySuspended = { shim: await s.call('many', { shim: true }), noShim: await s.call('many', { shim: false }) };
  R.jsFramesOnStack = await s.call('reentrant');

  // memory: 20 processes x 16 MiB touched, all suspended in fd_read, then killed (unwind mode)
  log('memory');
  const mem = (R.memoryDefaultFlags = { note: 'kill = reject the pending promise (unwind). Pss of the whole browser process tree in MB; default flags, no explicit gc()', rounds: [] });
  mem.baselineMB = browserPssMB();
  for (let round = 0; round < 8; round++) {
    const sp = await s.call('hogSpawn', { n: 20, mb: 16 });
    const live = browserPssMB();
    await s.call('hogKill', { mode: 'unwind' });
    await sleep(300);
    mem.rounds.push({ spawned20: sp.ERROR ? sp : sp.allSuspended, liveMB: live, afterKillMB: browserPssMB() });
  }
  await sleep(3000);
  mem.after3sIdleMB = browserPssMB();
  mem.finalizedSoFar = await s.call('finalized');
  mem.maxLiveProcessesRightAfter = (await s.call('many', { shim: true })).liveSuspendedProcesses;

  // out-of-bounds trap with default flags (expected to take the renderer down HERE, see RESULTS.md)
  log('oob (default flags)');
  R.oobDefaultFlags = await s.call('trapVariant', { mode: 'oob', variant: 'promising-suspended' }, 15000);
  if (s.crashed) { await s.page.close().catch(() => {}); s = await openPage(browser, url); }

  // ---- 6. watchdog (placement a CPU hog) - restarts the kernel worker
  log('watchdog');
  R.watchdog = await Promise.race([s.page.evaluate(() => spike.watchdogDemo(1000)).catch((e) => ({ ERROR: e.message.split('\n')[0].slice(0, 300) })), sleep(30000).then(() => ({ TIMEOUT_MS: 30000 }))]);
  await Promise.race([browser.close(), sleep(5000)]);

  // ---- 7. second browser: --expose-gc, to see whether killed/exited processes are collectable
  log('gc browser');
  browser = await chromium.launch({ args: ['--js-flags=--expose-gc'] });
  s = await openPage(browser, url);
  const g = (R.memoryWithExposeGc = { note: 'separate browser launched with --js-flags=--expose-gc; each hog = 1 Instance + 1 Memory (16 MiB touched); "finalized" = cumulative FinalizationRegistry callbacks' });
  g.engineLevelRepro = await s.call('stackLeakRepro', { n: 50 });
  g.baselineMB = browserPssMB();
  g.maxLiveProcessesAtStart = (await s.call('many', { shim: true })).liveSuspendedProcesses;
  await s.call('hogSpawn', { n: 20, mb: 16 });
  g.live20HogsMB = browserPssMB();
  await s.call('hogEof');
  g.after20NormalExits = await s.call('gc');
  g.after20NormalExitsMB = browserPssMB();
  await s.call('hogSpawn', { n: 20, mb: 16 });
  await s.call('hogKill', { mode: 'unwind' });
  g.after20KilledByUnwind = await s.call('gc');
  g.after20KilledByUnwindMB = browserPssMB();
  await s.call('hogSpawn', { n: 20, mb: 16 });
  await s.call('hogKill', { mode: 'drop' });
  g.after20KilledByDroppingPromise = await s.call('gc');
  g.after20KilledByDroppingPromiseMB = browserPssMB();
  g.maxLiveProcessesAtEnd = (await s.call('many', { shim: true })).liveSuspendedProcesses;
  await Promise.race([browser.close(), sleep(5000)]);

  // ---- 8. third browser: explicit wasm bounds checks, for the out-of-bounds trap
  log('bounds-check browser');
  browser = await chromium.launch({ args: ['--js-flags=--wasm-enforce-bounds-checks'] });
  s = await openPage(browser, url);
  R.oobWithEnforcedBoundsChecks = {
    note: 'separate browser launched with --js-flags=--wasm-enforce-bounds-checks',
    raw: await s.call('trapVariant', { mode: 'oob', variant: 'raw' }, 15000),
    promisingNoSuspend: await s.call('trapVariant', { mode: 'oob', variant: 'promising-nosuspend' }, 15000),
    promisingSuspended: await s.call('trapVariant', { mode: 'oob', variant: 'promising-suspended' }, 15000),
    many: await s.call('many', { shim: true }),
  };
  await Promise.race([browser.close(), sleep(5000)]);

  server.close();
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(R, null, 2) + '\n');
  console.log(JSON.stringify(R, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

function strip(m, keep) {
  if (m.failed) return m;
  const out = { median: m.median, samples: m.samples };
  if (keep) { out.lastRun = {}; for (const k of keep) out.lastRun[k] = m.lastRun[k]; }
  return out;
}
function pingSummary(p) {
  if (p.ERROR) return p;
  return {
    pipelineOk: p.result.ok, pipelineMs: p.result.ms, throughputMBps: p.result.throughputMBps, macrotaskYields: p.result.macrotaskYields,
    pingsSent: p.pings, pongsReceivedDuringOrAfter: p.pongsReceived, maxPongLatencyMs: p.maxPongLatencyMs,
  };
}
