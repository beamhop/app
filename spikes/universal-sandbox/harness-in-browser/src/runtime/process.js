// process object, Node-style timers, and a liveness tracker that stands in for libuv's "is the loop still alive".
import { Buffer } from 'buffer';

export class ProcessExit extends Error {
  constructor(code) { super('process.exit(' + code + ')'); this.code = code; this.name = 'ProcessExit'; }
}

export function createProcess({ EventEmitter, stream, argv, env, cwd, onStdout, onStderr, onExit, track, host }) {
  const nativeSetTimeout = host.setTimeout, nativeClearTimeout = host.clearTimeout, nativeSetInterval = host.setInterval, nativeClearInterval = host.clearInterval;
  const process = new EventEmitter();
  process.setMaxListeners(100);
  let exited = false;

  // ---- liveness: ref-counted handles (timers, sockets, children, pending requests) ----
  const live = { handles: 0, idleChecks: 0, timer: null, startedMain: false };
  const scheduleIdleCheck = () => {
    if (exited || live.timer || !live.startedMain) return;
    live.timer = nativeSetTimeout(() => {
      live.timer = null;
      if (exited) return;
      if (live.handles > 0) { live.idleChecks = 0; return; }
      if (++live.idleChecks < 3) return scheduleIdleCheck();
      try { process.emit('beforeExit', process.exitCode ?? 0); } catch (e) { host.console.error(e); }
      if (live.handles > 0) { live.idleChecks = 0; return; }
      doExit(process.exitCode ?? 0, 'loop-empty');
    }, 15);
  };
  const dbg = [];
  process.__liveLog = dbg;
  const st = () => (new Error().stack || '').split('\n').slice(3, 7).map((l) => l.trim().slice(0, 90)).join(' | ');
  const ref = () => { live.handles++; live.idleChecks = 0; { if (dbg.length > 600) dbg.splice(0, 300); } dbg.push('+' + live.handles + ' ' + st()); };
  const unref = () => { { if (dbg.length > 600) dbg.splice(0, 300); } dbg.push('-' + (live.handles - 1) + ' ' + st()); live.handles = Math.max(0, live.handles - 1); if (live.handles === 0) scheduleIdleCheck(); };
  process.__ref = ref; process.__unref = unref;
  process.__mainStarted = () => { live.startedMain = true; scheduleIdleCheck(); };
  process.__liveHandles = () => live.handles;

  function doExit(code, reason) {
    if (exited) return;
    process.exitCode = code;
    try { process.emit('exit', code); } catch (e) { host.console.error(e); }
    exited = true;
    process.__exited = true;
    onExit(Number(process.exitCode ?? code) || 0, reason);
  }

  // ---- timers ----
  class Timeout {
    constructor(fn, ms, args, repeat) {
      this._fn = fn; this._ms = ms; this._args = args; this._repeat = repeat; this._refed = true; this._active = false; this._id = null;
      this._start();
    }
    _start() {
      this._active = true;
      if (this._refed) ref();
      const run = () => {
        if (exited) return;
        if (!this._repeat) { this._active = false; if (this._refed) unref(); }
        try { this._fn(...this._args); } catch (e) { process.__uncaught(e); }
      };
      this._id = this._repeat ? nativeSetInterval(run, this._ms) : nativeSetTimeout(run, this._ms);
    }
    _stop() {
      if (!this._active) return;
      this._active = false;
      (this._repeat ? nativeClearInterval : nativeClearTimeout)(this._id);
      if (this._refed) unref();
    }
    ref() { if (!this._refed) { this._refed = true; if (this._active) ref(); } return this; }
    unref() { if (this._refed) { this._refed = false; if (this._active) unref(); } return this; }
    hasRef() { return this._refed; }
    refresh() { if (this._active) { (this._repeat ? nativeClearInterval : nativeClearTimeout)(this._id); if (this._refed) unref(); } this._start(); return this; }
    close() { this._stop(); return this; }
    [Symbol.toPrimitive]() { return this._id; }
    [Symbol.dispose]() { this._stop(); }
  }
  const timers = {
    setTimeout: (fn, ms = 1, ...args) => new Timeout(fn, Math.min(Math.max(1, Number(ms) || 1), 2147483647), args, false),
    setInterval: (fn, ms = 1, ...args) => new Timeout(fn, Math.min(Math.max(1, Number(ms) || 1), 2147483647), args, true),
    clearTimeout: (t) => { if (t instanceof Timeout) t._stop(); else if (t != null) nativeClearTimeout(t); },
    setImmediate: (fn, ...args) => { const t = new Timeout(fn, 0, args, false); return t; },
  };
  timers.clearInterval = timers.clearTimeout; timers.clearImmediate = timers.clearTimeout;
  // setImmediate must not be clamped to >=1ms by the browser; use a MessageChannel hop.
  const immediateChannel = new host.MessageChannel();
  const immediateQueue = [];
  immediateChannel.port1.onmessage = () => {
    const batch = immediateQueue.splice(0);
    for (const im of batch) { if (im._active) { im._active = false; if (im._refed) unref(); if (!exited) { try { im._fn(...im._args); } catch (e) { process.__uncaught(e); } } } }
  };
  class Immediate {
    constructor(fn, args) { this._fn = fn; this._args = args; this._active = true; this._refed = true; ref(); immediateQueue.push(this); immediateChannel.port2.postMessage(0); }
    _stop() { if (this._active) { this._active = false; if (this._refed) unref(); } }
    ref() { if (!this._refed) { this._refed = true; if (this._active) ref(); } return this; }
    unref() { if (this._refed) { this._refed = false; if (this._active) unref(); } return this; }
    hasRef() { return this._refed; }
    [Symbol.dispose]() { this._stop(); }
  }
  timers.setImmediate = (fn, ...args) => new Immediate(fn, args);
  timers.clearImmediate = (t) => { if (t && t._stop) t._stop(); };
  timers.clearTimeout = (t) => { if (t && t._stop) t._stop(); else if (t != null) nativeClearTimeout(t); };
  timers.clearInterval = timers.clearTimeout;
  process.__timers = timers;

  // ---- stdio ----
  const mkOut = (fd, sink) => {
    const w = new stream.Writable({ decodeStrings: false, write(chunk, enc, cb) { if (exited) { track('output written after process.exit (dropped)'); return cb(); } sink(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')); cb(); } });
    w.fd = fd; w.isTTY = false; w._isStdio = true; w.writable = true;
    w.destroySoon = w.destroy; w._destroy = (err, cb) => cb(err);
    w.getColorDepth = () => 1; w.hasColors = () => false; w.getWindowSize = () => [80, 24];
    w.ref = () => w; w.unref = () => w;
    return w;
  };
  process.stdout = mkOut(1, onStdout);
  process.stderr = mkOut(2, onStderr);
  const stdinChunks = [];
  const stdin = new stream.Readable({ read() {} });
  stdin.fd = 0; stdin.isTTY = false; stdin.setRawMode = () => stdin; stdin.ref = () => stdin; stdin.unref = () => stdin;
  process.stdin = stdin;
  process.__pushStdin = (data) => { if (data == null) stdin.push(null); else { stdinChunks.push(Buffer.from(data)); stdin.push(Buffer.from(data)); } };
  process.__readStdinSync = () => 0;

  const startTime = host.performance.now();
  Object.assign(process, {
    title: 'node', pid: 4242, ppid: 1, platform: 'linux', arch: 'x64', version: 'v22.12.0',
    versions: { node: '22.12.0', v8: '12.4.254.21-node.21', uv: '1.49.2', modules: '127', openssl: '3.0.15', zlib: '1.3.0.1-motley', undici: '6.21.0', ares: '1.34.3', napi: '9' },
    release: { name: 'node', lts: 'Jod' }, argv, argv0: 'node', execArgv: [], execPath: '/usr/local/bin/node', env, exitCode: undefined,
    config: { variables: {}, target_defaults: {} }, features: { inspector: false, ipv6: true, tls: true, typescript: false, require_module: true }, allowedNodeEnvironmentFlags: new Set(),
    browser: false, // readable-stream and others check this
    cwd: () => cwd,
    chdir: (d) => { cwd = d.startsWith('/') ? d : cwd + '/' + d; },
    umask: () => 0o22,
    uptime: () => (host.performance.now() - startTime) / 1000,
    hrtime: Object.assign((prev) => { const t = host.performance.now(); let s = Math.floor(t / 1000), n = Math.floor((t % 1000) * 1e6); if (prev) { s -= prev[0]; n -= prev[1]; if (n < 0) { s--; n += 1e9; } } return [s, n]; }, { bigint: () => BigInt(Math.floor(host.performance.now() * 1e6)) }),
    nextTick: (fn, ...args) => queueMicrotask(() => { if (exited) return; try { fn(...args); } catch (e) { process.__uncaught(e); } }),
    memoryUsage: Object.assign(() => { const m = host.performance.memory || {}; return { rss: m.totalJSHeapSize || 0, heapTotal: m.totalJSHeapSize || 0, heapUsed: m.usedJSHeapSize || 0, external: 0, arrayBuffers: 0 }; }, { rss: () => (host.performance.memory || {}).totalJSHeapSize || 0 }),
    cpuUsage: () => ({ user: Math.floor(host.performance.now() * 1000), system: 0 }),
    resourceUsage: () => ({ userCPUTime: 0, systemCPUTime: 0, maxRSS: 0 }),
    constrainedMemory: () => 0, availableMemory: () => 2 ** 31,
    getuid: () => 1000, geteuid: () => 1000, getgid: () => 1000, getegid: () => 1000, getgroups: () => [1000],
    kill: (pid, sig) => { track('process.kill', String(pid) + ' ' + sig); if (pid === process.pid && sig !== 0) process.emit(typeof sig === 'string' ? sig : 'SIGTERM'); return true; },
    exit: (code) => { doExit(code ?? process.exitCode ?? 0, 'process.exit'); throw new ProcessExit(code ?? 0); },
    reallyExit: (code) => { doExit(code ?? 0, 'process.reallyExit'); throw new ProcessExit(code ?? 0); },
    abort: () => { doExit(134, 'process.abort'); throw new ProcessExit(134); },
    emitWarning: (w) => { track('process.emitWarning', String(w && w.message || w).slice(0, 200)); },
    binding: (name) => { track('process.binding', name); throw new Error('process.binding is not supported in the emulation layer: ' + name); },
    dlopen: () => { track('process.dlopen'); throw new Error('process.dlopen is not supported in the emulation layer'); },
    setUncaughtExceptionCaptureCallback: () => {}, hasUncaughtExceptionCaptureCallback: () => false,
    setSourceMapsEnabled: () => {}, sourceMapsEnabled: false,
    getActiveResourcesInfo: () => [], _getActiveHandles: () => [], _getActiveRequests: () => [],
    report: { getReport: () => ({ header: { glibcVersionRuntime: '2.39' }, sharedObjects: [] }), writeReport: () => '' },
    stdin, channel: undefined, connected: false, noDeprecation: true,
    getBuiltinModule: (id) => process.__getBuiltin(id),
    loadEnvFile: () => {},
  });
  process.__uncaught = (e) => {
    if (e instanceof ProcessExit || exited) return;
    if (process.listenerCount('uncaughtException') > 0) { try { process.emit('uncaughtException', e, 'uncaughtException'); } catch (e2) { if (!(e2 instanceof ProcessExit)) host.console.error(e2); } return; }
    onStderr('Uncaught ' + (e && e.stack || e) + '\n');
    doExit(1, 'uncaughtException');
  };
  process.__unhandledRejection = (reason, promise) => {
    if (reason instanceof ProcessExit || exited) return;
    if (process.listenerCount('unhandledRejection') > 0) { try { process.emit('unhandledRejection', reason, promise); } catch (e2) { if (!(e2 instanceof ProcessExit)) host.console.error(e2); } return; }
    process.__uncaught(reason);
  };
  process.__doExit = doExit;
  return process;
}
