'use strict';
// Playwright driver for the spike. Starts the three servers in-process, runs every section in
// headless Chromium and prints one JSON document on stdout (progress goes to stderr).
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const { chromium } = require('playwright');
const { start } = require('./server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const note = (...a) => process.stderr.write(a.join(' ') + '\n');
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const BENCH_RUNS = Number(process.env.RUNS || 3);

function medianOf(objs) {
  // field-wise median over runs, for nested objects of numbers
  const first = objs[0];
  if (typeof first === 'number') { const s = objs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const out = {};
    for (const k of Object.keys(first)) out[k] = medianOf(objs.map((o) => (o == null ? undefined : o[k])));
    return out;
  }
  return first;
}

(async () => {
  const srv = await start();
  const { ORIGIN_A, ORIGIN_B, ORIGIN_X, DEFAULT_B_CSP } = srv;
  const R = { meta: {}, finalCsp: DEFAULT_B_CSP };
  const consoleNotes = [];
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opfs-origin-profile-'));
  let ctx;

  const watch = (page) => {
    page.on('console', (m) => { if (['warning', 'error'].includes(m.type()) && consoleNotes.length < 400) consoleNotes.push(`[${m.type()}] ${m.text().slice(0, 240)}`); });
    page.on('pageerror', (e) => consoleNotes.push(`[pageerror] ${String(e).slice(0, 240)}`));
  };
  // Playwright's default Chromium flags differ from a shipping Chrome in two ways that matter here:
  //   --disable-features=...,ThirdPartyStoragePartitioning,...   (storage partitioning OFF)
  //   --disable-popup-blocking
  // Unless PW_DEFAULT_FLAGS=1, both are undone so the browser behaves like a default Chrome.
  let pwDisableFeaturesArg = null;
  {
    const b = await chromium.launch({ args: ['--enable-automation'] }); // only so CDP will reveal the command line
    const s = await b.newBrowserCDPSession();
    const { arguments: cmd } = await s.send('Browser.getBrowserCommandLine');
    pwDisableFeaturesArg = cmd.find((a) => a.startsWith('--disable-features='));
    R.playwrightStockFlags = cmd.filter((a) => a.startsWith('--disable-features=') || a === '--disable-popup-blocking' || a === '--disable-field-trial-config');
    await b.close();
  }
  const launch = async (dir, args = [], { pwDefaults = !!process.env.PW_DEFAULT_FLAGS } = {}) => {
    const opts = { headless: true, args: [...args] };
    if (!pwDefaults) {
      const features = pwDisableFeaturesArg.slice('--disable-features='.length).split(',').filter((f) => f !== 'ThirdPartyStoragePartitioning');
      opts.ignoreDefaultArgs = [pwDisableFeaturesArg, '--disable-popup-blocking'];
      opts.args.push('--disable-features=' + features.join(','));
    }
    const c = await chromium.launchPersistentContext(dir, opts);
    c.on('page', watch);
    c.pages().forEach(watch);
    return c;
  };
  // Open the A page with the B kernel iframe; returns the page and the B frame.
  const openA = async (query = '', { expectKernel = true, context = ctx } = {}) => {
    const page = await context.newPage();
    await page.goto(`${ORIGIN_A}/index.html${query ? '?' + query : ''}`);
    await page.evaluate(() => window.A.ready);
    const frame = page.frames().find((f) => f !== page.mainFrame());
    if (expectKernel) await frame.waitForFunction(() => !!window.spike, null, { timeout: 10000 });
    return { page, frame };
  };
  const call = (frame, cmd, args = {}) => frame.evaluate(([c, a]) => window.spike.call(c, a), [cmd, args]);
  const clearLog = () => { srv.state.attackerLog.length = 0; };
  const hits = async (tag, wait = 600) => {
    await sleep(wait);
    const reached = [];
    for (const e of srv.state.attackerLog) {
      if (e.kind === 'udp') { reached.push(`udp(${e.stun ? 'stun' : 'raw'})`); continue; }
      if (e.url.includes(`/hit/${tag}/`)) reached.push(e.url.split(`/hit/${tag}/`)[1].split('?')[0] + (e.kind === 'ws-upgrade' ? '' : e.method === 'OPTIONS' ? '(preflight)' : ''));
    }
    const other = srv.state.attackerLog.filter((e) => e.kind !== 'udp' && !e.url.includes(`/hit/${tag}/`)).map((e) => e.url);
    return { reached: [...new Set(reached)], ...(other.length ? { unexpectedOther: other } : {}) };
  };
  const section = async (name, fn) => {
    if (ONLY && !ONLY.has(name)) return;
    const t = Date.now();
    note(`== ${name} ...`);
    try { R[name] = await fn(); } catch (e) { R[name] = { error: String((e && e.stack) || e).slice(0, 1500) }; note(`   FAILED: ${String(e).slice(0, 300)}`); }
    note(`   ${name} done in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  };
  const headersOf = (url) => new Promise((res) => http.get(url, (r) => { r.resume(); res(r.headers); }));

  R.meta = {
    date: new Date().toISOString(),
    chromium: null,
    node: process.version,
    host: { platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, cpuModel: os.cpus()[0] && os.cpus()[0].model, totalMemGB: +(os.totalmem() / 2 ** 30).toFixed(1), tmpdir: os.tmpdir() },
    origins: { A: ORIGIN_A, B: ORIGIN_B, attacker: ORIGIN_X },
    benchRuns: BENCH_RUNS,
    caveat: 'headless Chromium in a cloud container (not a phone); profile dir on the container tmpfs/overlay disk',
  };
  ctx = await launch(profileDir);
  R.meta.flags = process.env.PW_DEFAULT_FLAGS ? 'Playwright stock flags' : 'Playwright flags minus --disable-popup-blocking, with ThirdPartyStoragePartitioning left at its Chromium default (enabled)';
  let main = await openA();
  R.meta.userAgent = await main.page.evaluate(() => navigator.userAgent);
  if (!R.meta.chromium) R.meta.chromium = R.meta.userAgent.match(/Chrome\/([\d.]+)/)[1];

  // ------------------------------------------------------------------ 1
  await section('1_environment', async () => {
    const out = {};
    const ha = await headersOf(`${ORIGIN_A}/index.html`);
    const hb = await headersOf(`${ORIGIN_B}/kernel.html`);
    const hw = await headersOf(`${ORIGIN_B}/kernel-worker.js`);
    out.responseHeaders = {
      A: { coop: ha['cross-origin-opener-policy'] || null, coep: ha['cross-origin-embedder-policy'] || null, csp: ha['content-security-policy'] || null },
      B_document: { coop: hb['cross-origin-opener-policy'] || null, coep: hb['cross-origin-embedder-policy'] || null, corp: hb['cross-origin-resource-policy'] || null, csp: hb['content-security-policy'] },
      B_workerScript: { csp: hw['content-security-policy'] },
    };
    out.A_page = await main.page.evaluate(() => ({ crossOriginIsolated: self.crossOriginIsolated, typeofSharedArrayBuffer: typeof SharedArrayBuffer, origin: location.origin }));
    out.A_markersWritten = await main.page.evaluate(() => window.A.writeMarkers());
    out.A_reachingIntoFrame = await main.page.evaluate(() => window.A.probeFrame());
    out.B_worker = await call(main.frame, 'env');
    out.B_document = await main.frame.evaluate(() => window.spike.docEnv());
    out.B_sharedWorkerProbe = await main.frame.evaluate(() => window.spike.sharedWorkerProbe());
    out.B_embedded_afterWritingMarkers = await main.frame.evaluate(() => window.spike.writeMarkers('embedded-in-A'));
    // storage partitioning: B visited top-level must not see what B-embedded-in-A wrote, and vice versa
    const top = await ctx.newPage();
    await top.goto(`${ORIGIN_B}/toplevel.html`);
    out.B_toplevel_sees = await top.evaluate(() => window.T.list());
    out.B_toplevel_afterWritingOwnMarker = await top.evaluate(() => window.T.writeMarker());
    out.B_embedded_seesAfterToplevelWrote = await main.frame.evaluate(() => window.spike.listStorage());
    await top.close();
    // same check with Playwright's stock flags (ThirdPartyStoragePartitioning disabled), to document the trap
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opfs-origin-pwdef-'));
      const c = await launch(dir, [], { pwDefaults: true });
      const t = await openA('', { context: c });
      await t.frame.evaluate(() => window.spike.writeMarkers('embedded-in-A'));
      const tp = await c.newPage();
      await tp.goto(`${ORIGIN_B}/toplevel.html`);
      out.withPlaywrightStockFlags_toplevelB_sees = await tp.evaluate(() => window.T.list());
      await c.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const emb = out.B_embedded_afterWritingMarkers;
    out.verdict = {
      A_cannotReadFrame: Object.values(out.A_reachingIntoFrame).filter((v) => typeof v === 'object').every((v) => !v.ok) && out.A_reachingIntoFrame.contentDocument === 'null',
      B_cannotSeeA_storage: !JSON.stringify(out.B_document).includes('A-PRIVATE') && !out.B_document.ownOpfsEntries.includes('a-secret-marker.txt') && !out.B_document.ownIndexedDBDatabases.includes('a-secret-db'),
      toplevelB_doesNotSeeEmbeddedB: out.B_toplevel_sees.opfs.length === 0 && out.B_toplevel_sees.idb.length === 0 && out.B_toplevel_sees.localStorage.length === 0,
      embeddedB_doesNotSeeToplevelB: !JSON.stringify(out.B_embedded_seesAfterToplevelWrote).includes('toplevel') && emb.opfs.includes('b-marker-embedded-in-A.txt'),
    };
    // frame-ancestors: another site embedding the kernel
    clearLog();
    const evil = await ctx.newPage();
    await evil.goto(`${ORIGIN_X}/embed.html`);
    await sleep(700);
    const kf = evil.frames().find((f) => f !== evil.mainFrame());
    let kernelLoaded = false;
    try { kernelLoaded = await kf.evaluate(() => !!window.spike); } catch (e) { kernelLoaded = false; }
    out.frameAncestors = { embedderOrigin: ORIGIN_X, kernelLoadedInsideAttackerPage: kernelLoaded, frameUrl: kf ? kf.url() : null };
    await evil.close();
    return out;
  });

  // ------------------------------------------------------------------ 2
  await section('2_opfs_sync_access_handle', async () => {
    const runs = [];
    for (let i = 0; i < BENCH_RUNS; i++) runs.push(await call(main.frame, 'opfsBench', { sizeMB: 64 }));
    return { median: medianOf(runs), runs, note: 'reads follow writes of the same file, so they are served from the OS page cache; flush() is the only durability point' };
  });

  // ------------------------------------------------------------------ 3
  await section('3_sqlite', async () => {
    const out = {};
    const size = (f) => { const b = fs.readFileSync(path.join(srv.SQLITE_DIST, f)); return { rawBytes: b.length, gzipBytes: zlib.gzipSync(b, { level: 9 }).length, brotliBytes: zlib.brotliCompressSync(b).length }; };
    out.package = JSON.parse(fs.readFileSync(path.join(srv.SQLITE_DIST, '..', 'package.json'))).version;
    out.downloadSize = { 'sqlite3.wasm': size('sqlite3.wasm'), 'index.mjs': size('index.mjs'), note: 'this spike serves the files uncompressed; gzip/brotli sizes computed with node zlib' };
    out.initCold = await call(main.frame, 'sqliteInit');
    const tm = [];
    for (let i = 0; i < BENCH_RUNS; i++) tm.push(await call(main.frame, 'txModes'));
    out.oneTransactionPerFile = medianOf(tm);
    const runs = [];
    for (let i = 0; i < BENCH_RUNS; i++) { runs.push(await call(main.frame, 'sqliteBench', { tag: 'r' + i })); note(`   sqlite run ${i} ok`); }
    out.median = medianOf(runs);
    out.runs = runs;
    const wal = [];
    for (let i = 0; i < BENCH_RUNS; i++) wal.push(await call(main.frame, 'sqliteBench', { tag: 'w' + i, journal: 'wal' }));
    out.variant_walExclusive_median = medianOf(wal);
    out.variant_withoutRowidChunkTable_singleRun = await call(main.frame, 'sqliteBench', { tag: 'wr', chunkTable: 'without-rowid' });
    await sleep(1500);
    out.afterUnlinkingAllBenchDbs = { poolFiles: (await call(main.frame, 'persistRead')).poolFiles, storageEstimate: await main.frame.evaluate(() => navigator.storage.estimate()) };
    return out;
  });

  // ------------------------------------------------------------------ 8
  await section('8_bridge', async () => {
    await main.page.evaluate(() => window.A.connectBridge());
    const runs = [];
    for (let i = 0; i < BENCH_RUNS; i++) runs.push(await main.page.evaluate(() => window.A.benchBridge()));
    return { median: medianOf(runs), runs, note: 'A page -> MessagePort (transferred through the B frame into the B worker) -> echo -> A page. performance.now() resolution is 0.1 ms here, so sub-0.1 ms medians read as 0 or 0.1; use mean.' };
  });

  // ------------------------------------------------------------------ 6
  await section('6_service_worker_preview', async () => {
    const out = {};
    const f = main.frame;
    out.registerAndFirstLoad = await f.evaluate(() => window.spike.registerSWRacy());
    out.connect = await f.evaluate(() => window.spike.connectPreview());
    out.messageChannel_run1 = await f.evaluate(() => window.spike.openPreview('mc-1'));
    out.messageChannel_run2 = await f.evaluate(() => window.spike.openPreview('mc-2'));
    out.broadcastChannel_run1 = await f.evaluate(() => window.spike.openPreview('bc-1'));
    out.broadcastChannel_run2 = await f.evaluate(() => window.spike.openPreview('bc-2'));
    out.baseline_networkFetchToStaticServerMs = await f.evaluate(() => window.spike.baselineFetch());
    // sandboxed (opaque-origin) preview frame: does the SW still serve it?
    const before = await f.evaluate(() => window.spike.swCall({ type: 'stats' }));
    const sb = await f.evaluate(() => window.spike.openPreview('mc-sbx', 'index.html', { sandbox: 'allow-scripts', timeout: 4000 }));
    const after = await f.evaluate(() => window.spike.swCall({ type: 'stats' }));
    out.sandboxedOpaqueOriginPreview = { result: sb, swRequestsHandledDuring: after.handled - before.handled };
    // kill the SW (as the browser does after ~30 s idle) and load a preview again
    const cdp = await ctx.newCDPSession(main.page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await sleep(500);
    const pr0 = await f.evaluate(() => window.spike.portRequests);
    const r = await f.evaluate(() => window.spike.openPreview('mc-3'));
    const st = await f.evaluate(() => window.spike.swCall({ type: 'stats' }));
    out.afterServiceWorkerStopped = { swInstanceBefore: before.inst, swInstanceAfter: st.inst, restarted: st.inst !== before.inst, portReRequestsFromSW: (await f.evaluate(() => window.spike.portRequests)) - pr0, preview: r };
    await cdp.detach();
    return out;
  });

  // ------------------------------------------------------------------ 7 (in-context attempts)
  await section('7_egress', async () => {
    const out = {};
    const f = main.frame;
    const run = async (label, tag, fn) => {
      clearLog();
      const tcp0 = srv.state.tcpConnections;
      let r;
      try { r = await fn(); } catch (e) { r = { error: String(e).slice(0, 300) }; }
      const h = await hits(tag);
      const attempts = (r && r.out) || (r && r.r && r.r.out) || r;
      out[label] = { reachedAttacker: h.reached, ...(h.unexpectedOther ? { unexpectedOther: h.unexpectedOther } : {}), tcpConnectionsToAttacker: srv.state.tcpConnections - tcp0, clientSideOutcome: attempts };
      note(`   ${label}: reached=[${h.reached.join(', ')}]`);
    };
    await run('worker_scriptServedWithCsp', 'worker-csp', () => f.evaluate(() => window.spike.workerEgress('/egress-worker.js', 'worker-csp')));
    await run('worker_scriptServedWithoutCsp', 'worker-nocsp', () => f.evaluate(() => window.spike.workerEgress('/nocsp/egress-worker.js', 'worker-nocsp')));
    await run('worker_blobUrl', 'worker-blob', () => f.evaluate(() => window.spike.blobWorkerEgress('worker-blob')));
    await run('serviceWorker', 'sw', () => f.evaluate(() => window.spike.swCall({ type: 'egress', tag: 'sw' })));
    await run('kernelDocument', 'kernel-doc', () => f.evaluate(() => window.spike.docEgress('kernel-doc')));
    await run('kernelDocument_preconnect', 'kernel-doc-preconnect', () => f.evaluate(() => runPreconnect()));
    await run('previewPage_swAddsCsp', 'preview-mc-csp-eg', () => f.evaluate(() => window.spike.openPreview('mc-csp-eg', 'egress.html', { kind: 'egress', timeout: 60000 })));
    await run('previewPage_swOmitsCsp', 'preview-mc-nocsp-eg', () => f.evaluate(() => window.spike.openPreview('mc-nocsp-eg', 'egress.html', { kind: 'egress', timeout: 60000 })));
    // Harness validation: the same attempts from a B document served WITHOUT any CSP must reach the attacker.
    const base = await openA('path=/nocsp/kernel.html');
    await run('BASELINE_documentWithoutCsp', 'baseline-doc', () => base.frame.evaluate(() => window.spike.docEgress('baseline-doc')));
    await run('BASELINE_preconnect', 'baseline-preconnect', () => base.frame.evaluate(() => runPreconnect()));
    await run('worker_cspScript_startedByNoCspDocument', 'worker-csp-nocspdoc', () => base.frame.evaluate(() => window.spike.workerEgress('/egress-worker.js', 'worker-csp-nocspdoc')));
    await base.page.close();
    return out;
  });

  // ------------------------------------------------------------------ 4
  await section('4_persistence', async () => {
    const out = {};
    out.persistInIframe = await main.frame.evaluate(() => window.spike.persist());
    out.written = await call(main.frame, 'persistWrite', { token: 'ctx1' });
    out.estimateBeforeReload = await main.frame.evaluate(() => navigator.storage.estimate());
    // (a) page reload
    await main.page.reload();
    await main.page.evaluate(() => window.A.ready);
    main.frame = main.page.frames().find((fr) => fr !== main.page.mainFrame());
    await main.frame.waitForFunction(() => !!window.spike);
    out.initAfterReload_warmHttpCache = await call(main.frame, 'sqliteInit');
    out.afterReload = await call(main.frame, 'persistRead');
    await call(main.frame, 'persistWrite', { token: 'after-reload' });
    // (b) whole browser closed, new browser process + context on the same user-data dir
    await ctx.close();
    ctx = await launch(profileDir);
    main = await openA();
    out.initAfterBrowserRestart = await call(main.frame, 'sqliteInit');
    out.afterBrowserRestart = await call(main.frame, 'persistRead');
    out.afterBrowserRestart_storage = await main.frame.evaluate(() => window.spike.listStorage());
    out.afterBrowserRestart_swRegistration = await main.frame.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration('/preview/'); return r ? { scope: r.scope, active: !!r.active } : null; });
    out.afterBrowserRestart_persisted = await main.frame.evaluate(() => navigator.storage.persisted());
    out.verdict = {
      survivesReload: out.afterReload.kv.includes('token-ctx1') && out.afterReload.files.some((x) => x.includes('hello ctx1')) && out.afterReload.rawOpfs.includes('raw-persist-ctx1.txt'),
      survivesBrowserRestart: out.afterBrowserRestart.kv.includes('token-ctx1') && out.afterBrowserRestart.kv.includes('token-after-reload') && out.afterBrowserRestart.rawOpfs.length === 2,
    };
    return out;
  });

  // ------------------------------------------------------------------ 5
  await section('5_single_writer', async () => {
    const out = {};
    const tab1 = main;
    if (!(await tab1.frame.evaluate(() => !!window.spike))) throw new Error('no tab1');
    try { await call(tab1.frame, 'sqliteInit'); } catch (e) { /* already installed */ }
    out.tab1_elect = await tab1.frame.evaluate(() => window.spike.elect());
    await tab1.frame.evaluate(() => window.spike.bcServe());
    out.tab1_holdRawHandle = await call(tab1.frame, 'holdHandle');
    out.tab1_poolFiles = (await call(tab1.frame, 'persistRead')).poolFiles;

    const top = await ctx.newPage();
    await top.goto(`${ORIGIN_B}/toplevel.html`);
    await top.evaluate(() => window.T.bcListen());

    const tab2 = await openA();
    out.tab2_elect = await tab2.frame.evaluate(() => window.spike.elect());
    out.tab2_locksQuery = await tab2.frame.evaluate(() => window.spike.locksQuery());
    out.tab2_secondOpenOfSahPool = await call(tab2.frame, 'sqliteInit');
    out.tab2_secondRawSyncHandle = await call(tab2.frame, 'holdHandle');
    out.tab2_broadcastChannelToTab1 = await tab2.frame.evaluate(() => window.spike.bcPing());
    out.toplevelB_sawBroadcasts = await top.evaluate(() => window.T.bcSeen.length);
    out.toplevelB_canTakeSameLockName = await top.evaluate(() => window.T.tryLock());
    await top.close();
    // failover: tab2 queues for the lock, tab1 closes
    await tab2.frame.evaluate(() => window.spike.follow());
    await sleep(300);
    out.tab2_whileWaiting = await tab2.frame.evaluate(() => ({ followState: window.spike.followState }));
    const t0 = Date.now();
    await tab1.page.close();
    let st;
    for (let i = 0; i < 100; i++) { st = await tab2.frame.evaluate(() => window.spike.followState); if (!st.waiting) break; await sleep(20); }
    out.failover = { lockAcquiredByTab2: !st.waiting, msAfterTab1Closed: st.at ? st.at - t0 : null };
    let attempts = 0; let init;
    for (; attempts < 30; attempts++) { init = await call(tab2.frame, 'sqliteInit', { force: true }); if (!init.poolError) break; await sleep(100); }
    out.failover.sahPoolReopenAttempts = attempts + 1;
    out.failover.sahPoolReopen = init.poolError ? init : { installSahPoolMs: init.installSahPoolMs, poolFiles: init.poolFiles };
    out.failover.msUntilPoolUsable = Date.now() - t0;
    if (!init.poolError) out.failover.dataVisibleInTab2 = (await call(tab2.frame, 'persistRead')).kv;
    main = tab2;
    return out;
  });

  // ------------------------------------------------------------------ 7b navigation-style egress + mitigations
  await section('7b_navigation_egress', async () => {
    const out = {};
    await main.page.close(); // release the SAH pool
    const SBX = 'allow-scripts allow-same-origin';
    const variants = {
      plain: { query: '', csp: null },
      A_iframeSandboxAttr: { query: 'sandbox=' + encodeURIComponent(SBX), csp: null },
      A_cspFrameSrc: { query: 'acsp=1', csp: null },
      B_cspSandboxDirective: { query: '', csp: DEFAULT_B_CSP + `; sandbox ${SBX}` },
      A_sandboxAttr_plus_A_cspFrameSrc: { query: 'acsp=1&sandbox=' + encodeURIComponent(SBX), csp: null },
    };
    const kinds = [['self-nav', false], ['top-nav', false], ['top-nav', true], ['window-open', false], ['window-open', true], ['anchor-blank', true]];
    for (const [vname, v] of Object.entries(variants)) {
      srv.setBCsp(v.csp);
      const o = (out[vname] = {});
      // does the kernel still function under this variant?
      try {
        const fn = await openA(v.query);
        const init = await call(fn.frame, 'sqliteInit', { poolName: 'fn-check' });
        const env = await call(fn.frame, 'env');
        let sw; try { sw = await fn.frame.evaluate(() => window.spike.registerSW()); } catch (e) { sw = { error: String(e).slice(0, 200) }; }
        let prev = null;
        if (!sw.error) { await fn.frame.evaluate(() => window.spike.connectPreview({ useSqlite: false })); prev = await fn.frame.evaluate(() => window.spike.openPreview('mc-fn', 'index.html', { timeout: 8000 })); }
        o.kernelStillWorks = { opfsSahPool: !init.poolError, poolError: init.poolError, syncAccessHandle: env.hasCreateSyncAccessHandle, serviceWorker: sw, previewServedBySw: !!(prev && prev.first), previewMedianMs: prev && prev.latencyMs && prev.latencyMs.median, origin: await fn.frame.evaluate(() => self.origin) };
        await fn.page.close();
      } catch (e) { o.kernelStillWorks = { error: String(e).slice(0, 300) }; }
      for (const [kind, activated] of kinds) {
        const label = kind + (activated ? ' (user click)' : ' (no user activation)');
        const tag = `nav-${vname}-${kind}${activated ? '-act' : ''}`;
        clearLog();
        const t = await openA(v.query);
        const pagesBefore = new Set(ctx.pages());
        let client;
        try {
          if (activated) { await t.frame.evaluate(([k, tg]) => window.spike.arm(k, tg), [kind, tag]); await t.frame.click('#act'); await sleep(100); try { client = await t.frame.evaluate(() => window.spike.armedResult); } catch (e) { client = 'frame gone'; } }
          else client = await t.frame.evaluate(([k, tg]) => window.spike.navAction(k, tg), [kind, tag]);
        } catch (e) { client = 'evaluate failed: ' + String(e).slice(0, 120); }
        const h = await hits(tag, 800);
        const popups = ctx.pages().filter((p) => !pagesBefore.has(p));
        let frameUrl = null; try { frameUrl = t.page.frames().find((fr) => fr !== t.page.mainFrame()).url(); } catch (e) { /* */ }
        o[label] = { reachedAttacker: h.reached.length > 0, clientSideOutcome: client, topPageUrlAfter: t.page.url(), kernelFrameUrlAfter: frameUrl, popupsOpened: popups.length };
        for (const p of popups) await p.close().catch(() => {});
        await t.page.close().catch(() => {});
      }
      note(`   ${vname}: ` + Object.entries(o).filter(([k]) => k !== 'kernelStillWorks').map(([k, x]) => `${k}=${x.reachedAttacker ? 'REACHED' : 'blocked'}`).join('; '));
    }
    srv.setBCsp(null);

    // the nested preview frame (served by the SW) navigating itself / top / opening a window
    const pv = (out.previewFrame = {});
    for (const [vname, query] of [['plain', ''], ['A_iframeSandboxAttr', 'sandbox=' + encodeURIComponent(SBX)]]) {
      for (const idBase of ['mc-nav', 'mc-nocsp-nav', 'mc-cspsandbox-nav']) {
        for (const kind of ['self-nav', 'top-nav', 'window-open']) {
          const id = `${idBase}-${vname === 'plain' ? 'p' : 's'}-${kind}`;
          clearLog();
          const t = await openA(query);
          const pagesBefore = new Set(ctx.pages());
          let client;
          try {
            await t.frame.evaluate(() => window.spike.registerSW());
            await t.frame.evaluate(() => window.spike.connectPreview({ useSqlite: false }));
            client = (await t.frame.evaluate(([i, k]) => window.spike.openPreview(i, 'nav.html?kind=' + k, { kind: 'nav', keep: true, timeout: 5000 }), [id, kind])).r;
          } catch (e) { client = 'failed: ' + String(e).slice(0, 160); }
          const h = await hits('preview-' + id, 800);
          const popups = ctx.pages().filter((p) => !pagesBefore.has(p));
          pv[`${vname} / preview ${idBase.replace('mc-', '').replace('-nav', '').replace('nav', 'sw-adds-csp')} / ${kind}`] = { reachedAttacker: h.reached.length > 0, clientSideOutcome: client, topPageUrlAfter: t.page.url(), popupsOpened: popups.length };
          for (const p of popups) await p.close().catch(() => {});
          await t.page.close().catch(() => {});
        }
      }
    }
    return out;
  });

  // ------------------------------------------------------------------ CSP relaxations
  await section('csp_relaxations', async () => {
    const out = { policy: DEFAULT_B_CSP, probes: {} };
    const variants = {
      'full policy': DEFAULT_B_CSP,
      "minus 'wasm-unsafe-eval' (keeps 'unsafe-eval')": DEFAULT_B_CSP.replace(" 'wasm-unsafe-eval'", ''),
      "minus 'unsafe-eval' (keeps 'wasm-unsafe-eval')": DEFAULT_B_CSP.replace(" 'unsafe-eval'", ''),
      "minus both eval tokens": DEFAULT_B_CSP.replace(" 'wasm-unsafe-eval'", '').replace(" 'unsafe-eval'", ''),
      'minus blob: in script-src': DEFAULT_B_CSP.replace("'unsafe-eval' blob:", "'unsafe-eval'"),
      'minus blob: in worker-src': DEFAULT_B_CSP.replace("worker-src 'self' blob:", "worker-src 'self'"),
      'without worker-src (falls back to script-src)': DEFAULT_B_CSP.replace("worker-src 'self' blob:; ", ''),
      "minus 'unsafe-inline' in style-src": DEFAULT_B_CSP.replace("style-src 'self' 'unsafe-inline'", "style-src 'self'"),
      'minus data: blob: in img-src': DEFAULT_B_CSP.replace("img-src 'self' data: blob:", "img-src 'self'"),
      'without connect-src': DEFAULT_B_CSP.replace("connect-src 'self'; ", ''),
      'minus blob: in frame-src': DEFAULT_B_CSP.replace("frame-src 'self' blob:", "frame-src 'self'"),
    };
    let base = null;
    for (const [name, csp] of Object.entries(variants)) {
      if (csp === DEFAULT_B_CSP && name !== 'full policy') throw new Error('variant did not change policy: ' + name);
      srv.setBCsp(csp);
      const t = await openA('path=/probe.html', { expectKernel: false });
      await t.frame.waitForFunction(() => !!window.probe);
      const r = await t.frame.evaluate(() => window.probe());
      await t.page.close();
      if (!base) { base = r; out.probes[name] = r; } else {
        const diff = {};
        for (const k of Object.keys(r)) if (String(r[k]).startsWith('blocked') !== String(base[k]).startsWith('blocked')) diff[k] = r[k];
        out.probes[name] = { changedVersusFullPolicy: diff };
      }
    }
    // what does THIS spike's kernel (sqlite-wasm + SW preview) actually need?
    const functional = async (csp) => {
      srv.setBCsp(csp);
      const t = await openA();
      const o = {};
      try {
        const init = await call(t.frame, 'sqliteInit', { poolName: 'fn-check' });
        o.sqliteInit = init.poolError || (init.sqliteVersion ? 'ok' : JSON.stringify(init).slice(0, 200));
      } catch (e) { o.sqliteInit = 'FAILED: ' + String(e.message).split('\n')[0].slice(0, 200); }
      try {
        await t.frame.evaluate(() => window.spike.registerSW());
        await t.frame.evaluate(() => window.spike.connectPreview({ useSqlite: false }));
        const p = await t.frame.evaluate(() => window.spike.openPreview('mc-min', 'index.html', { timeout: 8000 }));
        o.swPreview = p.first ? 'ok' : JSON.stringify(p).slice(0, 200);
      } catch (e) { o.swPreview = 'FAILED: ' + String(e.message).split('\n')[0].slice(0, 200); }
      await t.page.close();
      return o;
    };
    const minimal = [
      "default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self'", "style-src 'self'", "img-src 'self'",
      "connect-src 'self'", "frame-src 'self'", `frame-ancestors ${ORIGIN_A}`, "form-action 'none'", "base-uri 'none'",
    ].join('; ');
    out.minimalPolicyForThisSpike = { policy: minimal, result: await functional(minimal) };
    out.minimalMinusWasmUnsafeEval = { result: await functional(minimal.replace(" 'wasm-unsafe-eval'", '')) };
    out.minimalMinusConnectSrc = { result: await functional(minimal.replace("connect-src 'self'; ", '')) };
    out.minimalMinusWorkerSrc = { note: "worker-src removed: workers fall back to script-src 'self'", result: await functional(minimal.replace("worker-src 'self'; ", '')) };
    srv.setBCsp(null);
    return out;
  });

  await ctx.close();

  // ------------------------------------------------------------------ extra: user blocks third-party cookies
  await section('extra_thirdPartyCookiesBlocked', async () => {
    const out = {};
    const probe = async (label, prefs, args) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opfs-origin-3pc-'));
      if (prefs) { fs.mkdirSync(path.join(dir, 'Default'), { recursive: true }); fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify(prefs)); }
      const c = await launch(dir, args || []);
      const o = (out[label] = {});
      try {
        const t = await openA('', { context: c });
        o.thirdPartyCookieWritable = await t.frame.evaluate(() => { document.cookie = 'probe=1; SameSite=None; Secure; Path=/'; return document.cookie.includes('probe=1'); });
        const d = await t.frame.evaluate(() => window.spike.docEnv());
        o.docEnv = { cookieEnabled: d.cookieEnabled, hasStorageAccess: d.hasStorageAccess, ownOpfsEntries: d.ownOpfsEntries, ownIndexedDBDatabases: d.ownIndexedDBDatabases, ownLocalStorageKeys: d.ownLocalStorageKeys, storageEstimate: d.storageEstimate };
        try { const init = await call(t.frame, 'sqliteInit'); o.sqliteSahPool = init.poolError || 'ok'; } catch (e) { o.sqliteSahPool = 'FAILED: ' + String(e.message).split('\n')[0]; }
        try { o.rawSyncAccessHandle = await call(t.frame, 'holdHandle'); } catch (e) { o.rawSyncAccessHandle = 'FAILED: ' + String(e.message).split('\n')[0]; }
        try { o.serviceWorker = await t.frame.evaluate(() => window.spike.registerSW()); } catch (e) { o.serviceWorker = 'FAILED: ' + String(e.message).split('\n')[0].slice(0, 200); }
        try { o.webLocks = await t.frame.evaluate(() => window.spike.elect()); } catch (e) { o.webLocks = 'FAILED: ' + String(e.message).split('\n')[0].slice(0, 200); }
        try { o.broadcastChannel = await t.frame.evaluate(() => { new BroadcastChannel('x').close(); return 'constructible'; }); } catch (e) { o.broadcastChannel = 'FAILED: ' + String(e.message).split('\n')[0].slice(0, 200); }
      } catch (e) { o.error = String(e).slice(0, 400); }
      await c.close();
      fs.rmSync(dir, { recursive: true, force: true });
    };
    await probe('defaultProfile', null);
    await probe('prefBlockThirdPartyCookies', { profile: { cookie_controls_mode: 1, block_third_party_cookies: true } });
    await probe('flagTestThirdPartyCookiePhaseout', null, ['--test-third-party-cookie-phaseout']);
    return out;
  });

  R.consoleNotes = [...new Set(consoleNotes)].slice(0, 120);
  await srv.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(R, null, 2));
  process.stdout.write(JSON.stringify(R, null, 2) + '\n');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
