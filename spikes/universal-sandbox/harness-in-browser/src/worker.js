// The single dedicated worker: kernel (VFS, process, child processes via just-bash) + Node emulation + the harness.
import { boot, VFS } from './runtime/index.js';

const hostConsole = self.console;
const native = { setTimeout: self.setTimeout.bind(self), fetch: self.fetch.bind(self), eval: self.eval };
const tWorker = performance.now();

function sesSetup(cfg) {
  importScripts(cfg.sesBuild === 'stock' ? 'ses.umd.js' : 'ses.patched.umd.js');
  const opts = { errorTaming: 'unsafe', overrideTaming: 'severe', consoleTaming: 'unsafe', stackFiltering: 'verbose', errorTrapping: 'none', unhandledRejectionTrapping: 'none', evalTaming: 'safe-eval', ...(cfg.lockdownOptions || {}) };
  let lockdownError = null;
  try { lockdown(opts); } catch (e) { lockdownError = String(e && e.stack || e); }
  return Object.assign(opts, { lockdownError, sesBuild: cfg.sesBuild === 'stock' ? 'stock ses@2.3.0' : 'ses@2.3.0 + 2 extra severe enablements' });
}

// Web platform globals a Node 22 process also has; these are the only non-emulated endowments.
const WEB_GLOBALS = ['URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'TextEncoderStream', 'TextDecoderStream', 'AbortController', 'AbortSignal', 'Event', 'EventTarget', 'CustomEvent', 'DOMException', 'MessageChannel', 'MessagePort', 'MessageEvent',
  'BroadcastChannel', 'Blob', 'File', 'FormData', 'Headers', 'Request', 'Response', 'ReadableStream', 'WritableStream', 'TransformStream', 'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader', 'ReadableByteStreamController', 'ReadableStreamDefaultController', 'WritableStreamDefaultWriter', 'ByteLengthQueuingStrategy',
  'CountQueuingStrategy', 'CompressionStream', 'DecompressionStream', 'WebAssembly', 'crypto', 'Crypto', 'CryptoKey', 'SubtleCrypto', 'performance', 'Performance', 'PerformanceObserver', 'PerformanceEntry', 'PerformanceMark', 'PerformanceMeasure', 'structuredClone', 'queueMicrotask', 'atob', 'btoa', 'WebSocket', 'Intl', 'FinalizationRegistry', 'WeakRef', 'reportError', 'Iterator'];

async function run(cfg, pageT0) {
  const m = { variant: cfg.variant, crossOriginIsolated: self.crossOriginIsolated, typeofSharedArrayBuffer: typeof SharedArrayBuffer, typeofAtomicsWait: typeof Atomics === 'object' ? typeof Atomics.wait : 'undefined', measureUserAgentSpecificMemory: typeof performance.measureUserAgentSpecificMemory };
  const now = () => performance.timeOrigin + performance.now() - pageT0; // ms since the page asked for the run
  m.tWorkerScriptEvaluated = performance.timeOrigin + tWorker - pageT0;
  const heap = () => (performance.memory ? performance.memory.usedJSHeapSize : null);
  m.heapAtStart = heap();

  let evaluate, guestGlobal, sesInfo = null;
  if (cfg.variant === 'ses') {
    const t = performance.now();
    const options = sesSetup(cfg);
    const globals = {};
    for (const k of WEB_GLOBALS) if (k in self) globals[k] = ['structuredClone', 'queueMicrotask', 'atob', 'btoa', 'reportError'].includes(k) ? self[k].bind(self) : self[k]; // WebIDL operations need the real global as receiver
    // Date and Math in a Compartment are tamed (no clock, no randomness); a Node program needs the real ones.
    globals.Date = Date; globals.Math = Math;
    // Standard globals SES 2.3 does not put on a Compartment global (float typed arrays are start-compartment only; the rest are newer than its permit list).
    const missing = [];
    for (const k of cfg.sesExtraGlobals || ['Float64Array', 'Float32Array', 'Float16Array', 'DisposableStack', 'AsyncDisposableStack', 'SuppressedError']) if (k in self) { globals[k] = self[k]; missing.push(k); }
    const compartment = new Compartment({ globals, __options__: true });
    guestGlobal = compartment.globalThis;
    const censor = { htmlComment: 0, importExpr: 0, directEval: 0 };
    const evalOptions = { __evadeHtmlCommentTest__: true, __evadeImportExpressionTest__: true, __rejectSomeDirectEvalExpressions__: false, ...(cfg.sesEvaluateOptions || {}) };
    evaluate = (code, file) => {
      if (/<!--|-->/.test(code)) censor.htmlComment++;
      if (/\bimport\s*\(/.test(code)) censor.importExpr++;
      if (/\beval\s*\(/.test(code)) censor.directEval++;
      return compartment.evaluate(code + '\n//# sourceURL=file://' + file, evalOptions);
    };
    sesInfo = { extraGlobalsEndowed: missing, lockdownOptions: options, lockdownMs: performance.now() - t, filesThatWouldHitCensor: censor, evalOptions };
  } else {
    guestGlobal = self;
    const indirectEval = native.eval;
    evaluate = (code, file) => indirectEval(code + '\n//# sourceURL=file://' + file);
  }
  m.tEvaluatorReady = now();

  // ---- file system: fetch and mount images ----
  const vfs = new VFS();
  const esmCache = new Map();
  m.images = [];
  for (const img of cfg.images || []) {
    const t = performance.now();
    const res = await native.fetch(img.url);
    if (!res.ok) throw new Error('image fetch failed: ' + img.url + ' ' + res.status);
    const buf = await res.arrayBuffer();
    const tFetched = performance.now();
    const { esm } = vfs.loadImage(buf, img.mount || '');
    for (const [k, v] of esm) esmCache.set(k, v);
    m.images.push({ url: img.url, bytes: buf.byteLength, fetchMs: tFetched - t, mountMs: performance.now() - tFetched });
  }
  for (const d of ['/tmp', '/bin', '/usr/bin', '/usr/local/bin', '/etc', '/dev', cfg.cwd, cfg.env.HOME].filter(Boolean)) vfs.mkdir(d, { recursive: true });
  const enc = new TextEncoder();
  for (const exe of ['/bin/bash', '/bin/sh', '/usr/bin/bash', '/usr/bin/env', '/usr/local/bin/node']) vfs.writeFile(exe, enc.encode('#!virtual\n'), { mode: 0o755 });
  vfs.writeFile('/dev/null', new Uint8Array(0));
  vfs.writeFile('/etc/passwd', enc.encode('user:x:1000:1000::/home/user:/bin/bash\n'));
  for (const [p, content] of Object.entries(cfg.files || {})) { vfs.mkdir(p.slice(0, p.lastIndexOf('/')) || '/', { recursive: true }); vfs.writeFile(p, enc.encode(content)); }
  m.tImagesMounted = now();
  m.heapAfterImages = heap();
  m.vfsAtStart = vfs.count();

  let outBuf = '', errBuf = '', flushTimer = null, finalSent = false;
  const flush = () => { flushTimer = null; if (outBuf) { self.postMessage({ type: 'stdout', data: outBuf }); outBuf = ''; } if (errBuf) { self.postMessage({ type: 'stderr', data: errBuf }); errBuf = ''; } };
  const schedule = () => { if (!flushTimer) flushTimer = native.setTimeout(flush, 0); };
  let rt;
  const report = (final) => {
    flush();
    const r = {
      metrics: m, final, exit: m.exit ?? null, liveHandles: rt ? rt.process.__liveHandles() : null,
      loader: rt && { ...rt.loader.stats, evalMs: +rt.loader.stats.evalMs.toFixed(1) }, usage: rt && rt.usage, net: rt && rt.netLog, childProcess: rt && rt.cpLog, installFailures: rt && rt.installFailures, ses: sesInfo,
      vfsAtEnd: vfs.count(), fsChecks: {}, trace: rt && cfg.trace ? rt.trace.slice(-cfg.trace) : undefined, liveLog: cfg.debugLive && rt ? rt.process.__liveLog : undefined,
    };
    for (const p of cfg.readBack || []) { const n = vfs.tryLookup(p); r.fsChecks[p] = n && n.kind === 'file' ? new TextDecoder().decode(n.data.subarray(0, 4096)) : n ? '<' + n.kind + '>' : null; }
    if (cfg.listDirs) { r.dirs = {}; for (const d of cfg.listDirs) { try { r.dirs[d] = vfs.readdir(d).map(([n]) => n); } catch { r.dirs[d] = null; } } }
    self.postMessage({ type: 'report', report: r, final });
  };
  self.__report = report;

  rt = boot({
    vfs, esmCache, evaluate, guestGlobal, trace: cfg.trace, debugLive: cfg.debugLive, debugPatches: cfg.debugPatches, argv: ['node', cfg.entry, ...(cfg.args || [])], env: { ...cfg.env }, cwd: cfg.cwd, net: cfg.net,
    onStdout: (s) => { if (m.tFirstStdout == null) { m.tFirstStdout = now(); m.heapAtFirstOutput = heap(); } outBuf += s; schedule(); },
    onStderr: (s) => { if (m.tFirstStderr == null) m.tFirstStderr = now(); errBuf += s; schedule(); },
    onExit: (code, reason) => {
      if (finalSent) return; finalSent = true;
      m.exit = { code, reason }; m.tExit = now(); m.heapAtExit = heap();
      native.setTimeout(() => report(true), 0);
    },
  });
  self.addEventListener('unhandledrejection', (e) => { e.preventDefault(); rt.process.__unhandledRejection(e.reason, e.promise); });
  self.addEventListener('error', (e) => { e.preventDefault(); rt.process.__uncaught(e.error || new Error(e.message)); });
  if (cfg.keepAlive) rt.process.__ref();
  m.tBooted = now();
  m.heapAfterBoot = heap();
  if (cfg.stdin != null) rt.process.__pushStdin(cfg.stdin);
  rt.process.__pushStdin(null);
  rt.run(cfg.entry).then(() => { m.tMainSettled = now(); m.heapAfterLoad = heap(); });
  m.tMainSyncDone = now();
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'run') run(msg.config, msg.t0).catch((e) => self.postMessage({ type: 'fatal', error: String((e && e.stack) || e) }));
  else if (msg.type === 'report' && self.__report) self.__report(false);
};
