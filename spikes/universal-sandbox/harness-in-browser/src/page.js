// Page side: owns the worker, relays stdio, returns one result object per run.
window.pageInfo = () => ({ crossOriginIsolated: self.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer, userAgent: navigator.userAgent });
window.runHarness = (config) => new Promise((resolve) => {
  const t0 = performance.now();
  const worker = new Worker('worker.js');
  const out = { stdout: '', stderr: '', exit: null, timedOut: false, firstStdoutMs: null, firstStderrMs: null, events: [] };
  let timer = setTimeout(() => { out.timedOut = true; worker.postMessage({ type: 'report' }); setTimeout(() => finish(), 1500); }, config.timeoutMs || 60000);
  const finish = () => { clearTimeout(timer); out.totalMs = performance.now() - t0; worker.terminate(); resolve(out); };
  worker.onerror = (e) => { out.workerError = String(e.message || e); finish(); };
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'stdout') { out.firstStdoutMs ??= performance.now() - t0; out.stdout += m.data; }
    else if (m.type === 'stderr') { out.firstStderrMs ??= performance.now() - t0; out.stderr += m.data; }
    else if (m.type === 'report') { out.report = m.report; if (out.timedOut || m.final) finish(); }
    else if (m.type === 'fatal') { out.fatal = m.error; finish(); }
  };
  worker.postMessage({ type: 'run', config, t0: performance.timeOrigin + t0 });
});
