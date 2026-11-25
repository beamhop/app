// Page-side harness: spawns workers, RPC, heartbeat/watchdog, memory helpers.
'use strict';
(function () {
  const H = { workers: new Map(), next: 1 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const r2 = (x) => Math.round(x * 100) / 100;

  H.spawn = (query, readyTimeout = 30000) => new Promise((resolve, reject) => {
    const t0 = performance.now();
    const w = new Worker('/src/worker.js?' + (query || ''));
    const h = { w, pending: new Map(), seq: 0 };
    const id = H.next++;
    H.workers.set(id, h);
    const timer = setTimeout(() => reject(new Error('worker did not become ready in ' + readyTimeout + ' ms')), readyTimeout);
    w.onerror = (e) => { clearTimeout(timer); reject(new Error('worker error: ' + e.message)); };
    w.onmessage = (ev) => {
      const d = ev.data;
      if (d.type === 'ready') { clearTimeout(timer); resolve({ id, boot: d.boot, spawnToReadyMs: r2(performance.now() - t0) }); return; }
      const p = h.pending.get(d.id);
      if (!p) return;
      h.pending.delete(d.id);
      if (d.ok) p.resolve(d.result); else p.reject(new Error(d.error.name + ': ' + d.error.message + (d.error.stack ? '\n' + d.error.stack : '')));
    };
  });
  H.call = (id, cmd, args, timeout = 300000) => new Promise((resolve, reject) => {
    const h = H.workers.get(id);
    const mid = ++h.seq;
    const timer = setTimeout(() => { h.pending.delete(mid); reject(new Error('rpc timeout: ' + cmd)); }, timeout);
    h.pending.set(mid, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    h.w.postMessage({ id: mid, cmd, args });
  });
  H.kill = (id) => { const h = H.workers.get(id); if (h) { h.w.terminate(); H.workers.delete(id); } };

  // Cold start: new Worker -> kernel + ses + lockdown -> fetch/parse image -> first guest module.
  H.coldStart = async (query, image) => {
    const t0 = performance.now();
    const s = await H.spawn(query);
    const t1 = performance.now();
    const img = await H.call(s.id, 'loadImage', { url: image });
    const t2 = performance.now();
    const smoke = await H.call(s.id, 'compat', { test: 'lodash' });
    const t3 = performance.now();
    return { id: s.id, spawnToReadyMs: r2(t1 - t0), sesScriptMs: r2(s.boot.sesScriptMs || 0), lockdownMs: r2(s.boot.lockdownMs || 0), imageMs: r2(t2 - t1), image: img, firstModuleMs: r2(t3 - t2), firstModuleOk: smoke.ok, totalMs: r2(t3 - t0) };
  };

  H.liveness = async (query, image, watchdogMs) => {
    const first = await H.coldStart(query, image);
    const id = first.id;
    let lastPong = performance.now(); let pongs = 0;
    const hb = setInterval(() => { H.call(id, 'ping', {}, 1e9).then(() => { lastPong = performance.now(); pongs++; }, () => {}); }, 50);
    await sleep(400);
    const pongsBeforeLoop = pongs;
    const tLoop = performance.now();
    H.call(id, 'evalGuest', { code: 'while (true) {}' }, 1e9).catch(() => {});
    await new Promise((r) => { const wd = setInterval(() => { if (performance.now() - lastPong > watchdogMs) { clearInterval(wd); r(); } }, 10); });
    const detectedAfterMs = performance.now() - tLoop;
    const pongsDuringLoop = pongs - pongsBeforeLoop;
    clearInterval(hb);
    const tKill = performance.now();
    H.kill(id);
    const restart = await H.coldStart(query, image);
    const killToUsableMs = performance.now() - tKill;
    H.kill(restart.id);
    return { heartbeatIntervalMs: 50, watchdogMs, pongsBeforeLoop, pongsDuringLoop, detectedAfterMs: r2(detectedAfterMs), killToUsableMs: r2(killToUsableMs), restart };
  };

  H.coldStartStats = async (query, image, runs) => {
    const all = [];
    for (let i = 0; i < runs; i++) { const c = await H.coldStart(query, image); H.kill(c.id); all.push(c); }
    const med = (k) => r2(median(all.map((c) => c[k])));
    return { runs, median: { spawnToReadyMs: med('spawnToReadyMs'), sesScriptMs: med('sesScriptMs'), lockdownMs: med('lockdownMs'), imageMs: med('imageMs'), firstModuleMs: med('firstModuleMs'), totalMs: med('totalMs') }, imageDetail: all[all.length - 1].image, totals: all.map((c) => c.totalMs) };
  };

  H.pageMemory = async (timeoutMs) => {
    const out = { crossOriginIsolated: self.crossOriginIsolated, hasApi: typeof performance.measureUserAgentSpecificMemory === 'function' };
    if (!out.hasApi) return out;
    try {
      const t0 = performance.now();
      const r = await Promise.race([performance.measureUserAgentSpecificMemory(), sleep(timeoutMs).then(() => { throw new Error('timed out after ' + timeoutMs + ' ms'); })]);
      out.ms = r2(performance.now() - t0);
      out.bytes = r.bytes;
      out.breakdown = r.breakdown.filter((b) => b.bytes > 0).map((b) => ({ bytes: b.bytes, types: b.types, scopes: b.attribution.map((a) => a.scope) }));
    } catch (e) { out.error = e.name + ': ' + e.message; }
    return out;
  };

  self.H = H;
})();
