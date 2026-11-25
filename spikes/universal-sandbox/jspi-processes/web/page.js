// Page side: owns the kernel worker, forwards commands, measures ping latency, and
// implements the watchdog that terminates + restarts a kernel worker that stopped answering.
let worker;
let nextId = 1;
const pending = new Map();
let pongHandler = null;

function boot() {
  const t0 = performance.now();
  return new Promise((resolve) => {
    worker = new Worker('./kernel-worker.js', { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.boot) return resolve(performance.now() - t0);
      if (data.pong !== undefined) return pongHandler && pongHandler(data.pong);
      const p = pending.get(data.id);
      pending.delete(data.id);
      if (data.ok) p.resolve(data.result);
      else p.reject(new Error(data.error));
    };
  });
}

function call(cmd, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, cmd, args });
  });
}

// Run a command while pinging the worker every `everyMs`; report how late pongs were.
async function callWithPings(cmd, args, everyMs = 5) {
  const sent = new Map();
  let maxLatency = 0;
  let pongs = 0;
  let seq = 0;
  pongHandler = (s) => {
    const l = performance.now() - sent.get(s);
    sent.delete(s);
    pongs++;
    if (l > maxLatency) maxLatency = l;
  };
  const iv = setInterval(() => {
    sent.set(++seq, performance.now());
    worker.postMessage({ ping: seq });
  }, everyMs);
  const t0 = performance.now();
  const result = await call(cmd, args);
  const ms = performance.now() - t0;
  clearInterval(iv);
  await new Promise((r) => setTimeout(r, 50));
  pongHandler = null;
  return { result, pings: seq, pongsReceived: pongs, maxPongLatencyMs: +maxLatency.toFixed(1), commandMs: +ms.toFixed(1) };
}

// Watchdog: ping every 100 ms; if no pong for `timeoutMs`, terminate the worker (the only
// way to stop a wasm loop without SharedArrayBuffer), start a fresh one and reload programs.
async function watchdogDemo(timeoutMs = 1000) {
  const t0 = performance.now();
  let lastPong = performance.now();
  let seq = 0;
  pongHandler = () => { lastPong = performance.now(); };
  const before = await call('pipeline', { lines: 2000 });
  const tBurn = performance.now();
  call('burn').catch(() => {}); // never answers
  const detectedAt = await new Promise((resolve) => {
    const iv = setInterval(() => {
      worker.postMessage({ ping: ++seq });
      if (performance.now() - lastPong > timeoutMs) { clearInterval(iv); resolve(performance.now()); }
    }, 100);
  });
  const lostCommands = pending.size;
  const tTerm = performance.now();
  worker.terminate();
  pending.clear();
  const terminateMs = performance.now() - tTerm;
  const bootMs = await boot();
  const tLoad = performance.now();
  await call('load');
  const loadMs = performance.now() - tLoad;
  const after = await call('pipeline', { lines: 2000 });
  pongHandler = null;
  return {
    pipelineBeforeOk: before.ok,
    hangDetectedAfterMs: +(detectedAt - tBurn).toFixed(0),
    lostInFlightCommands: lostCommands,
    terminateCallMs: +terminateMs.toFixed(2),
    newWorkerBootMs: +bootMs.toFixed(1),
    reloadAndCompileProgramsMs: +loadMs.toFixed(1),
    pipelineAfterRestartOk: after.ok,
    totalMs: +(performance.now() - t0).toFixed(0),
    note: 'all kernel state (pipes, files, every other process) died with the worker',
  };
}

window.spike = {
  boot, call, callWithPings, watchdogDemo,
  pageEnv: () => ({ crossOriginIsolated: self.crossOriginIsolated, typeofSharedArrayBuffer: typeof SharedArrayBuffer }),
};
window.spikeReady = boot();
