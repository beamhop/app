// Boots one "Node process" inside the current worker: VFS + emulated built-ins + module loader.
import { VFS } from './vfs.js';
import { createFs } from './fs.js';
import { createProcess, ProcessExit } from './process.js';
import { createLoader } from './loader.js';
import { createNet } from './net.js';
import { createChildProcess } from './child_process.js';
import { holder as processHolder } from './process-shim.js';
import { makeBuffer, makeEvents, makeStream, makeUtil, makePath, makeOs, makeTty, makeReadline, makeCrypto, makeZlib, makeAsyncHooks, makeMisc, assertPkg, TrackedReadableStream } from './builtins.js';

export { VFS, ProcessExit };

// config: { vfs, esmCache, argv, env, cwd, net, evaluate(code, file), guestGlobal, onStdout, onStderr, onExit }
export function boot(config) {
  const g = globalThis;
  // Native browser facilities captured before any guest-visible global is replaced.
  const host = {
    setTimeout: g.setTimeout.bind(g), clearTimeout: g.clearTimeout.bind(g), setInterval: g.setInterval.bind(g), clearInterval: g.clearInterval.bind(g),
    fetch: g.fetch.bind(g), WebSocket: g.WebSocket, console: g.console, performance: g.performance, crypto: g.crypto, navigator: g.navigator,
    MessageChannel: g.MessageChannel, MessagePort: g.MessagePort, BroadcastChannel: g.BroadcastChannel, PerformanceObserver: g.PerformanceObserver, PerformanceEntry: g.PerformanceEntry,
  };
  const usage = Object.create(null); // every "interesting" API touch: name -> { count, samples }
  const track = (name, detail) => { const u = (usage[name] ||= { count: 0, samples: [] }); u.count++; if (detail != null && u.samples.length < 5 && !u.samples.includes(detail)) u.samples.push(detail); };

  const { vfs, esmCache } = config;
  const bufferMod = makeBuffer();
  const { Buffer } = bufferMod;
  const EventEmitter = makeEvents();
  const stream = makeStream(Buffer);
  const path = makePath();

  const process = createProcess({ EventEmitter, stream, argv: config.argv, env: config.env, cwd: config.cwd, onStdout: config.onStdout, onStderr: config.onStderr, onExit: config.onExit, track, host });
  processHolder.process = process;
  process.__debugLive = !!config.debugLive;
  const timers = process.__timers;
  const util = makeUtil({ Buffer, process });
  const fs = createFs({ vfs, process, stream, EventEmitter, track });
  const trace = [];
  if (config.trace) {
    const wrap = (obj, label) => { for (const k of Object.keys(obj)) { const f = obj[k]; if (typeof f !== 'function' || /^[A-Z]/.test(k)) continue; obj[k] = function (...a) { if (trace.length > 400) trace.splice(0, 200); trace.push(label + k + ' ' + (typeof a[0] === 'string' || typeof a[0] === 'number' ? a[0] : '')); return f.apply(this, a); }; Object.assign(obj[k], f); } };
    wrap(fs, 'fs.'); wrap(fs.promises, 'fsp.');
  }
  const netMods = createNet({ EventEmitter, stream, process, track, host, config });
  const cp = createChildProcess({ vfs, fs, EventEmitter, stream, process, track, host, path, util });
  const evaluate = config.evaluate;
  const misc = makeMisc({ Buffer, EventEmitter, stream, util, process, track, host, evaluate, timers });
  const assert = assertPkg;
  assert.strict ??= assert;

  const builtins = {
    assert, 'assert/strict': assert.strict || assert, async_hooks: makeAsyncHooks({ track }), buffer: bufferMod, child_process: cp.module, constants: { ...fs.constants, ...makeOs({ process, host }).constants.signals },
    crypto: makeCrypto({ Buffer, stream, track, host }), events: EventEmitter, fs, 'fs/promises': fs.promises, http: netMods.http, https: netMods.https, net: netMods.net, os: makeOs({ process, host }),
    path, 'path/posix': path, 'path/win32': path, process, readline: null, 'readline/promises': null, stream, 'stream/promises': stream.promises, tls: netMods.tls, tty: makeTty({ stream }),
    util, 'util/types': util.types, sys: util, zlib: makeZlib({ Buffer, stream, track }), module: null,
    ...misc,
  };
  builtins.readline = makeReadline({ EventEmitter, process, util });
  builtins['readline/promises'] = builtins.readline.promises;
  stream.promises ??= builtins['stream/promises'];

  if (config.trace) {
    const wrap = (obj, label) => { for (const k of Object.keys(obj)) { let f; try { f = obj[k]; } catch { continue; } if (typeof f !== 'function' || /^[A-Z]/.test(k)) continue; try { obj[k] = function (...a) { if (trace.length > 400) trace.splice(0, 200); trace.push(label + k + ' ' + (typeof a[0] === 'string' || typeof a[0] === 'number' ? String(a[0]).slice(0, 100) : '')); return f.apply(this, a); }; Object.assign(obj[k], f); } catch {} } };
    for (const name of ['os', 'child_process', 'readline', 'tty', 'dns', 'net', 'tls', 'http', 'https', 'crypto', 'zlib', 'worker_threads', 'v8', 'vm', 'async_hooks', 'perf_hooks', 'timers']) if (builtins[name]) wrap(builtins[name], name + '.');
    for (const ev of ['on', 'once', 'resume', 'pause', 'read', 'setEncoding']) { const f = process.stdin[ev]; process.stdin[ev] = function (...a) { trace.push('stdin.' + ev + ' ' + (typeof a[0] === 'string' ? a[0] : '')); return f.apply(this, a); }; }
    const pon = process.on; process.on = function (...a) { trace.push('process.on ' + String(a[0])); return pon.apply(this, a); };
  }
  const loader = createLoader({ vfs, esmCache, builtins, process, evaluate, globalsForModules: {}, track, path, debugPatches: config.debugPatches });
  builtins.module = loader.moduleBuiltin;
  process.__getBuiltin = (id) => loader.getBuiltin(id);
  process.mainModule = undefined;

  // ---- guest-visible globals (worker global in plain mode, Compartment global under SES) ----
  const guest = config.guestGlobal;
  const navigator = { userAgent: 'Node.js/22', language: 'en-US', languages: ['en-US'], platform: 'linux', hardwareConcurrency: host.navigator.hardwareConcurrency || 4 };
  const guestGlobals = {
    process, Buffer, global: guest, console: misc.console, ReadableStream: TrackedReadableStream, fetch: netMods.fetch, navigator,
    setTimeout: timers.setTimeout, setInterval: timers.setInterval, setImmediate: timers.setImmediate, clearTimeout: timers.clearTimeout, clearInterval: timers.clearInterval, clearImmediate: timers.clearImmediate,
  };
  const installFailures = [];
  for (const [k, v] of Object.entries(guestGlobals)) {
    try { Object.defineProperty(guest, k, { value: v, writable: true, configurable: true, enumerable: k !== 'global' }); } catch (e) { installFailures.push(k + ': ' + e.message); }
  }

  const t = { boot: host.performance.now() };
  return {
    process, fs, vfs, loader, usage, host, installFailures,
    netLog: netMods.log, cpLog: cp.log, trace,
    run(entry) {
      t.runStart = host.performance.now();
      let p;
      try { p = loader.runMain(entry); } catch (e) { process.__uncaught(e); p = Promise.resolve(); }
      t.mainSyncDone = host.performance.now();
      p.then(() => { t.mainSettled = host.performance.now(); }, (e) => process.__uncaught(e)).finally(() => process.__mainStarted());
      return p;
    },
    timings: t,
  };
}
