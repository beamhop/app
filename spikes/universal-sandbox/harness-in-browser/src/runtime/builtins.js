// Node built-in modules that are small enough to implement directly. Bigger ones live in their own files.
import { Buffer as FerossBuffer, kMaxLength, INSPECT_MAX_BYTES, SlowBuffer } from 'buffer';
import EventEmitterPkg from 'events';
import streamPkg from 'readable-stream';
import utilPkg from 'util';
import pathPkg from 'path-browserify';
import assertPkg from 'assert';
import { StringDecoder } from 'string_decoder';
import urlPkg from 'url';
import querystringPkg from 'querystring-es3';
import punycodePkg from 'punycode/';
import * as fflate from 'fflate';
import { sha1, md5, ripemd160 } from '@noble/hashes/legacy.js';
import { sha256, sha224, sha512, sha384 } from '@noble/hashes/sha2.js';
import { sha3_256, sha3_512 } from '@noble/hashes/sha3.js';
import { hmac } from '@noble/hashes/hmac.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';

const lazy = (fn) => { let v; const f = () => (v ??= fn()); f.__lazyBuiltin = true; return f; };
const notImplemented = (track, name) => (...args) => { track('not-implemented', name); const e = new Error(`${name} is not implemented in the browser Node emulation layer`); e.code = 'ERR_NOT_IMPLEMENTED_IN_EMULATION'; throw e; };

// ---------------- buffer ----------------
export function makeBuffer() {
  const Buffer = FerossBuffer;
  if (!Buffer.__patched) {
    Buffer.__patched = true;
    const b64uToB64 = (s) => s.replace(/-/g, '+').replace(/_/g, '/');
    const b64ToB64u = (s) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const isB64u = (e) => typeof e === 'string' && e.toLowerCase() === 'base64url';
    const origFrom = Buffer.from, origToString = Buffer.prototype.toString, origWrite = Buffer.prototype.write, origIsEncoding = Buffer.isEncoding, origByteLength = Buffer.byteLength;
    Buffer.from = function (value, enc, len) { if (typeof value === 'string' && isB64u(enc)) return origFrom.call(Buffer, b64uToB64(value), 'base64'); return origFrom.call(Buffer, value, enc, len); };
    Buffer.prototype.toString = function (enc, start, end) { if (isB64u(enc)) return b64ToB64u(origToString.call(this, 'base64', start, end)); return origToString.call(this, enc, start, end); };
    Buffer.prototype.write = function (string, offset, length, enc) {
      const e = typeof offset === 'string' ? offset : typeof length === 'string' ? length : enc;
      if (isB64u(e)) { const b = Buffer.from(string, 'base64url'); const off = typeof offset === 'number' ? offset : 0; b.copy(this, off); return b.length; }
      return origWrite.call(this, string, offset, length, enc);
    };
    Buffer.isEncoding = (e) => isB64u(e) || origIsEncoding(e);
    Buffer.byteLength = (s, e) => (isB64u(e) ? Buffer.from(s, e).length : origByteLength(s, e));
    for (const [name, enc] of [['utf8Slice', 'utf8'], ['latin1Slice', 'latin1'], ['asciiSlice', 'ascii'], ['hexSlice', 'hex'], ['base64Slice', 'base64'], ['ucs2Slice', 'ucs2']]) Buffer.prototype[name] ??= function (s, e) { return this.toString(enc, s, e); };
    for (const [name, enc] of [['utf8Write', 'utf8'], ['latin1Write', 'latin1'], ['asciiWrite', 'ascii'], ['hexWrite', 'hex'], ['base64Write', 'base64'], ['ucs2Write', 'ucs2']]) Buffer.prototype[name] ??= function (str, o, l) { return this.write(str, o, l, enc); };
    Buffer.poolSize ??= 8192;
  }
  const isUtf8 = (b) => { try { new TextDecoder('utf-8', { fatal: true }).decode(b); return true; } catch { return false; } };
  const isAscii = (b) => { const u = b instanceof Uint8Array ? b : new Uint8Array(b); for (let i = 0; i < u.length; i++) if (u[i] > 127) return false; return true; };
  return {
    Buffer, SlowBuffer, kMaxLength, INSPECT_MAX_BYTES, kStringMaxLength: 536870888, constants: { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: 536870888 },
    Blob: globalThis.Blob, File: globalThis.File, atob: globalThis.atob.bind(globalThis), btoa: globalThis.btoa.bind(globalThis), isUtf8, isAscii,
    transcode: (buf, from, to) => Buffer.from(Buffer.from(buf).toString(from), to),
    resolveObjectURL: () => undefined,
  };
}

// ---------------- events ----------------
export function makeEvents() {
  const EventEmitter = EventEmitterPkg;
  if (!EventEmitter.__patched) {
    EventEmitter.__patched = true;
    EventEmitter.errorMonitor ??= Symbol('events.errorMonitor');
    EventEmitter.captureRejectionSymbol ??= Symbol.for('nodejs.rejection');
    EventEmitter.setMaxListeners = (n, ...targets) => { for (const t of targets) if (t && typeof t.setMaxListeners === 'function') t.setMaxListeners(n); };
    EventEmitter.getMaxListeners = (t) => (t && typeof t.getMaxListeners === 'function' ? t.getMaxListeners() : 10);
    EventEmitter.getEventListeners = (t, name) => (t && typeof t.listeners === 'function' ? t.listeners(name) : []);
    EventEmitter.addAbortListener = (signal, listener) => { signal.addEventListener('abort', listener, { once: true }); return { [Symbol.dispose]() { signal.removeEventListener('abort', listener); } }; };
    EventEmitter.on = function on(emitter, event, opts = {}) {
      const queue = [], waiters = [];
      let error = null, done = false;
      const handler = (...args) => { const w = waiters.shift(); if (w) w.resolve({ value: args, done: false }); else queue.push(args); };
      const onError = (e) => { const w = waiters.shift(); if (w) w.reject(e); else error = e; };
      const add = (n, h) => (emitter.addEventListener ? emitter.addEventListener(n, h) : emitter.on(n, h));
      const remove = (n, h) => (emitter.removeEventListener ? emitter.removeEventListener(n, h) : emitter.removeListener(n, h));
      add(event, handler); if (event !== 'error' && emitter.on) emitter.on('error', onError);
      const finish = () => { done = true; remove(event, handler); if (emitter.on) emitter.removeListener('error', onError); for (const w of waiters.splice(0)) w.resolve({ value: undefined, done: true }); };
      if (opts.signal) opts.signal.addEventListener('abort', () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; e.code = 'ABORT_ERR'; onError(e); finish(); }, { once: true });
      return {
        next() { if (queue.length) return Promise.resolve({ value: queue.shift(), done: false }); if (error) { const e = error; error = null; return Promise.reject(e); } if (done) return Promise.resolve({ value: undefined, done: true }); return new Promise((resolve, reject) => waiters.push({ resolve, reject })); },
        return() { finish(); return Promise.resolve({ value: undefined, done: true }); },
        throw(e) { finish(); return Promise.reject(e); },
        [Symbol.asyncIterator]() { return this; },
      };
    };
    const origOnce = EventEmitter.once;
    EventEmitter.once = (emitter, name, opts) => {
      if (emitter && typeof emitter.addEventListener === 'function' && typeof emitter.on !== 'function') {
        return new Promise((resolve, reject) => { emitter.addEventListener(name, (...a) => resolve(a), { once: true }); if (opts && opts.signal) opts.signal.addEventListener('abort', () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; reject(e); }, { once: true }); });
      }
      const p = origOnce(emitter, name);
      if (opts && opts.signal) return Promise.race([p, new Promise((_, reject) => opts.signal.addEventListener('abort', () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; e.code = 'ABORT_ERR'; reject(e); }, { once: true }))]);
      return p;
    };
    EventEmitter.EventEmitterAsyncResource = class EventEmitterAsyncResource extends EventEmitter { get asyncResource() { return { runInAsyncScope: (fn, thisArg, ...args) => fn.apply(thisArg, args) }; } emitDestroy() {} };
    EventEmitter.usingDomains = false;
    EventEmitter.EventEmitter = EventEmitter;
  }
  return EventEmitter;
}

// ---------------- stream ----------------
// Node's stream.finished()/isErrored()/isDisturbed() accept web streams by peeking at internal state. A browser
// gives no synchronous access to that state, so guest code gets a ReadableStream subclass that records it.
const webState = new WeakMap();
export const TrackedReadableStream = class ReadableStream extends globalThis.ReadableStream {
  constructor(source = {}, strategy) {
    const st = { state: 'readable', error: undefined, waiters: [] };
    const settle = (state, error) => { if (st.state !== 'readable') return; st.state = state; st.error = error; for (const w of st.waiters.splice(0)) queueMicrotask(() => w(state === 'errored' ? error : undefined)); };
    const wrapController = (c) => new Proxy(c, { get(t, k) { if (k === 'close') return () => { t.close(); settle('closed'); }; if (k === 'error') return (e) => { t.error(e); settle('errored', e); }; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
    const wrapped = {};
    if (source.type !== undefined) wrapped.type = source.type;
    if (source.autoAllocateChunkSize !== undefined) wrapped.autoAllocateChunkSize = source.autoAllocateChunkSize;
    let wc;
    const ctl = (c) => (wc ??= wrapController(c));
    if (source.start) wrapped.start = (c) => source.start(ctl(c));
    if (source.pull) wrapped.pull = (c) => source.pull(ctl(c));
    wrapped.cancel = (reason) => { settle('closed'); return source.cancel ? source.cancel(reason) : undefined; };
    super(wrapped, strategy);
    webState.set(this, st);
  }
};
export function makeStream(Buffer) {
  const stream = streamPkg;
  if (!Object.prototype.hasOwnProperty.call(stream, '__patched')) {
    stream.__patched = true;
    const { Readable, Writable, Duplex } = stream;
    Readable.fromWeb = (rs, options = {}) => {
      const reader = rs.getReader();
      let closed = false;
      const r = new Readable({
        ...options,
        read() { reader.read().then(({ done, value }) => { if (done) { closed = true; r.push(null); } else r.push(options.objectMode ? value : Buffer.from(value.buffer ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value)); }, (e) => r.destroy(e)); },
        destroy(err, cb) { if (!closed) reader.cancel(err).catch(() => {}); cb(err); },
      });
      return r;
    };
    Readable.toWeb = (readable) => {
      let cancelled = false;
      return new ReadableStream({
        start(controller) {
          readable.on('data', (chunk) => { controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)); if (controller.desiredSize <= 0) readable.pause(); });
          readable.on('end', () => { if (!cancelled) controller.close(); });
          readable.on('error', (e) => { if (!cancelled) controller.error(e); });
          readable.pause();
        },
        pull() { readable.resume(); },
        cancel(reason) { cancelled = true; readable.destroy(reason); },
      });
    };
    Writable.fromWeb = (ws, options = {}) => {
      const writer = ws.getWriter();
      return new Writable({ ...options, write(chunk, enc, cb) { writer.write(chunk).then(() => cb(), cb); }, final(cb) { writer.close().then(() => cb(), cb); }, destroy(err, cb) { if (err) writer.abort(err).catch(() => {}); cb(err); } });
    };
    Writable.toWeb = (writable) => new WritableStream({
      write(chunk) { return new Promise((resolve, reject) => writable.write(chunk, (e) => (e ? reject(e) : resolve()))); },
      close() { return new Promise((resolve) => writable.end(resolve)); },
      abort(reason) { writable.destroy(reason); },
    });
    Duplex.fromWeb = (pair, options) => { const r = Readable.fromWeb(pair.readable, options), w = Writable.fromWeb(pair.writable, options); return Duplex.from({ readable: r, writable: w }); };
    Duplex.toWeb = (duplex) => ({ readable: Readable.toWeb(duplex), writable: Writable.toWeb(duplex) });
    const origFinished = stream.finished, origIsErrored = stream.isErrored, origIsDisturbed = stream.isDisturbed;
    const isWeb = (s) => s instanceof globalThis.ReadableStream || s instanceof globalThis.WritableStream;
    stream.finished = function finished(s, opts, cb) {
      if (!isWeb(s)) return origFinished.call(this, s, opts, cb);
      if (typeof opts === 'function') cb = opts;
      const st = webState.get(s);
      if (!st) return () => {}; // a native stream we cannot observe: the callback never fires
      if (st.state !== 'readable') queueMicrotask(() => cb(st.state === 'errored' ? st.error : undefined)); else st.waiters.push(cb);
      return () => { const i = st.waiters.indexOf(cb); if (i !== -1) st.waiters.splice(i, 1); };
    };
    stream.isErrored = (s) => (isWeb(s) ? (webState.get(s) || {}).state === 'errored' : origIsErrored ? origIsErrored(s) : !!(s && s.errored));
    stream.isDisturbed = (s) => (isWeb(s) ? !!(s.locked) : origIsDisturbed ? origIsDisturbed(s) : !!(s && s.readableDidRead));
    if (stream.promises) { const pf = stream.promises.finished; stream.promises.finished = (s, o) => (isWeb(s) ? new Promise((res, rej) => stream.finished(s, (e) => (e ? rej(e) : res()))) : pf(s, o)); }
    if (!Object.prototype.hasOwnProperty.call(stream, 'isReadable')) stream.isReadable = (s) => !!s && s.readable !== false && !s.destroyed && !s.readableEnded;
    if (!Object.prototype.hasOwnProperty.call(stream, 'isWritable')) stream.isWritable = (s) => !!s && s.writable !== false && !s.destroyed && !s.writableEnded;
    stream.isErrored ??= (s) => !!(s && (s.errored || (s._readableState && s._readableState.errored) || (s._writableState && s._writableState.errored)));
    stream.isDisturbed ??= (s) => !!(s && (s.readableDidRead || s.readableAborted || (typeof ReadableStream !== 'undefined' && s instanceof ReadableStream && s.locked)));
    if (!Object.prototype.hasOwnProperty.call(stream, 'getDefaultHighWaterMark')) stream.getDefaultHighWaterMark = (objectMode) => (objectMode ? 16 : 16384);
    if (!Object.prototype.hasOwnProperty.call(stream, 'setDefaultHighWaterMark')) stream.setDefaultHighWaterMark = () => {};
    if (!Object.prototype.hasOwnProperty.call(stream, 'duplexPair')) stream.duplexPair = () => {
      let a, b;
      a = new Duplex({ read() {}, write(c, e, cb) { b.push(c); cb(); }, final(cb) { b.push(null); cb(); } });
      b = new Duplex({ read() {}, write(c, e, cb) { a.push(c); cb(); }, final(cb) { a.push(null); cb(); } });
      return [a, b];
    };
  }
  return stream;
}

// ---------------- util ----------------
export function makeUtil({ Buffer, process }) {
  const util = { ...utilPkg };
  const ansi = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
  util.stripVTControlCharacters = (s) => String(s).replace(ansi, '');
  util.TextEncoder = TextEncoder; util.TextDecoder = TextDecoder;
  util.toUSVString = (s) => String(s).toWellFormed();
  util.styleText = (fmt, text) => { const codes = util.inspect.colors; let out = String(text); for (const f of [].concat(fmt)) { const c = codes[f]; if (c) out = `\u001b[${c[0]}m${out}\u001b[${c[1]}m`; } return out; };
  util.isDeepStrictEqual = (a, b) => { try { assertPkg.deepStrictEqual(a, b); return true; } catch { return false; } };
  util.parseEnv = (text) => Object.fromEntries(String(text).split('\n').map((l) => l.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/)).filter(Boolean).map((m) => [m[1], (m[2] || '').replace(/^(['"])(.*)\1$/, '$2')]));
  util.getSystemErrorName = (n) => ({ '-2': 'ENOENT', '-13': 'EACCES', '-17': 'EEXIST', '-111': 'ECONNREFUSED', '-104': 'ECONNRESET' }[n] || 'UNKNOWN');
  util.getSystemErrorMap = () => new Map();
  util.aborted = (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  util.MIMEType = class MIMEType { constructor(s) { const [essence, ...params] = String(s).split(';'); [this.type, this.subtype] = essence.trim().split('/'); this.essence = essence.trim(); this.params = new Map(params.map((p) => p.trim().split('='))); } toString() { return this.essence; } };
  util.debuglog = util.debuglog || (() => Object.assign(() => {}, { enabled: false }));
  util.debug = util.debuglog;
  util.getCallSites = () => [];
  util.transferableAbortController = () => new AbortController();
  util.transferableAbortSignal = (s) => s;
  util.parseArgs = (config = {}) => {
    const args = config.args || process.argv.slice(2), options = config.options || {}, values = {}, positionals = [];
    const byShort = Object.fromEntries(Object.entries(options).filter(([, o]) => o.short).map(([k, o]) => [o.short, k]));
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { positionals.push(...args.slice(i + 1)); break; }
      let name, val;
      if (a.startsWith('--')) { [name, val] = a.slice(2).split(/=(.*)/s); } else if (a.startsWith('-') && a.length > 1) { name = byShort[a[1]] || a[1]; val = a.length > 2 ? a.slice(2) : undefined; } else { if (config.allowPositionals === false || (config.strict !== false && !config.allowPositionals)) { const e = new TypeError(`Unexpected argument '${a}'`); e.code = 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL'; throw e; } positionals.push(a); continue; }
      const opt = options[name];
      if (!opt && config.strict !== false) { const e = new TypeError(`Unknown option '${a}'`); e.code = 'ERR_PARSE_ARGS_UNKNOWN_OPTION'; throw e; }
      const v = opt && opt.type === 'string' ? (val ?? args[++i]) : val ?? true;
      if (opt && opt.multiple) (values[name] ||= []).push(v); else values[name] = v;
    }
    for (const [k, o] of Object.entries(options)) if (!(k in values) && o.default !== undefined) values[k] = o.default;
    return { values, positionals };
  };
  const t = { ...(utilPkg.types || {}) };
  t.isUint8Array ??= (v) => v instanceof Uint8Array;
  t.isAnyArrayBuffer ??= (v) => v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer);
  t.isArrayBufferView ??= ArrayBuffer.isView;
  t.isProxy ??= () => false; t.isExternal ??= () => false; t.isModuleNamespaceObject ??= (v) => !!v && v[Symbol.toStringTag] === 'Module';
  t.isKeyObject ??= () => false; t.isCryptoKey ??= (v) => typeof CryptoKey !== 'undefined' && v instanceof CryptoKey;
  t.isNativeError ??= (v) => v instanceof Error; t.isBoxedPrimitive ??= (v) => v instanceof Number || v instanceof String || v instanceof Boolean;
  util.types = t;
  util.promisify = Object.assign((fn) => {
    if (fn && fn[utilPkg.promisify.custom]) return fn[utilPkg.promisify.custom];
    return utilPkg.promisify(fn);
  }, { custom: utilPkg.promisify.custom });
  return util;
}

// ---------------- path / os / tty / misc ----------------
export function makePath() {
  const p = { ...pathPkg };
  p.posix = p; p.win32 = p;
  p.toNamespacedPath = (x) => x;
  p.matchesGlob = (file, pattern) => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]') + '$').test(file);
  return p;
}

export function makeOs({ process, host }) {
  const signals = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGWINCH: 28 };
  const n = (host.navigator && host.navigator.hardwareConcurrency) || 4;
  return {
    EOL: '\n', devNull: '/dev/null',
    platform: () => 'linux', type: () => 'Linux', arch: () => 'x64', machine: () => 'x86_64', release: () => '6.8.0-browser', version: () => '#1 SMP universal-sandbox', endianness: () => 'LE',
    homedir: () => process.env.HOME || '/home/user', tmpdir: () => process.env.TMPDIR || '/tmp', hostname: () => 'sandbox',
    cpus: () => Array.from({ length: n }, () => ({ model: 'Browser vCPU', speed: 2000, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })),
    availableParallelism: () => n, totalmem: () => 4 * 2 ** 30, freemem: () => 2 * 2 ** 30, uptime: () => Math.floor(host.performance.now() / 1000), loadavg: () => [0, 0, 0],
    userInfo: () => ({ username: process.env.USER || 'user', uid: 1000, gid: 1000, shell: '/bin/bash', homedir: process.env.HOME || '/home/user' }),
    networkInterfaces: () => ({}), getPriority: () => 0, setPriority: () => {},
    constants: { signals, errno: { ENOENT: 2, EACCES: 13, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, EPIPE: 32, ECONNRESET: 104, ECONNREFUSED: 111, ETIMEDOUT: 110 }, priority: { PRIORITY_LOW: 19, PRIORITY_NORMAL: 0, PRIORITY_HIGH: -7 }, UV_UDP_REUSEADDR: 4, dlopen: {} },
  };
}

export function makeTty({ stream }) {
  class ReadStream extends stream.Readable { constructor(fd) { super({ read() {} }); this.fd = fd; this.isTTY = false; this.isRaw = false; } setRawMode() { return this; } }
  class WriteStream extends stream.Writable { constructor(fd) { super({ write(c, e, cb) { cb(); } }); this.fd = fd; this.isTTY = false; this.columns = 80; this.rows = 24; } getColorDepth() { return 1; } hasColors() { return false; } getWindowSize() { return [80, 24]; } }
  return { isatty: () => false, ReadStream, WriteStream };
}

export function makeReadline({ EventEmitter, process, util }) {
  class Interface extends EventEmitter {
    constructor(opts = {}, output) {
      super();
      if (opts && typeof opts.on === 'function') opts = { input: opts, output };
      this.input = opts.input; this.output = opts.output; this.terminal = false; this.line = ''; this.cursor = 0; this.closed = false; this._prompt = opts.prompt ?? '> '; this._buf = ''; this._questions = [];
      this._decoder = new TextDecoder();
      if (this.input) {
        this._onData = (chunk) => {
          this._buf += typeof chunk === 'string' ? chunk : this._decoder.decode(chunk, { stream: true });
          let idx;
          while ((idx = this._buf.search(/\r?\n/)) !== -1) { const line = this._buf.slice(0, idx); this._buf = this._buf.slice(idx + (this._buf[idx] === '\r' ? 2 : 1)); this._line(line); }
        };
        this._onEnd = () => { if (this._buf) { const l = this._buf; this._buf = ''; this._line(l); } this.close(); };
        this.input.on('data', this._onData); this.input.on('end', this._onEnd);
      }
    }
    _line(line) { const q = this._questions.shift(); if (q) q(line); else this.emit('line', line); }
    setPrompt(p) { this._prompt = p; } getPrompt() { return this._prompt; }
    prompt() { if (this.output) this.output.write(this._prompt); }
    question(query, opts, cb) { if (typeof opts === 'function') cb = opts; if (this.output) this.output.write(query); this._questions.push(cb); }
    write(data) { if (typeof data === 'string') this._onData && this._onData(data); }
    pause() { this.input && this.input.pause(); this.emit('pause'); return this; }
    resume() { this.input && this.input.resume(); this.emit('resume'); return this; }
    close() { if (this.closed) return; this.closed = true; if (this.input) { this.input.removeListener('data', this._onData); this.input.removeListener('end', this._onEnd); } this.emit('close'); }
    getCursorPos() { return { rows: 0, cols: 0 }; }
    [Symbol.asyncIterator]() { const it = EventEmitter.on(this, 'line'); const self = this; this.once('close', () => it.return()); return { next: () => it.next().then((r) => (r.done ? r : { value: r.value[0], done: false })), return: () => { self.close(); return it.return(); }, [Symbol.asyncIterator]() { return this; } }; }
    [Symbol.dispose]() { this.close(); }
  }
  const cb = (f) => (typeof f === 'function' ? f() : undefined);
  const readline = {
    Interface, createInterface: (opts, output) => new Interface(opts, output),
    clearLine: (s, d, f) => (cb(f ?? d), true), clearScreenDown: (s, f) => (cb(f), true), cursorTo: (s, x, y, f) => (cb(typeof y === 'function' ? y : f), true), moveCursor: (s, x, y, f) => (cb(f), true),
    emitKeypressEvents: () => {},
  };
  readline.promises = { Interface, createInterface: (opts) => { const rl = new Interface(opts); const q = rl.question.bind(rl); rl.question = (query, o) => new Promise((resolve) => q(query, resolve)); return rl; } };
  return readline;
}

// ---------------- crypto ----------------
export function makeCrypto({ Buffer, stream, track, host }) {
  const algos = { sha1, md5, sha256, sha224, sha512, sha384, ripemd160, 'sha3-256': sha3_256, 'sha3-512': sha3_512, rmd160: ripemd160 };
  const getAlgo = (name) => { const a = algos[String(name).toLowerCase().replace(/^rsa-/, '')]; if (!a) { track('crypto-unsupported-hash', name); const e = new Error('Digest method not supported: ' + name); e.code = 'ERR_CRYPTO_INVALID_DIGEST'; throw e; } return a; };
  const toU8 = (d, enc) => (typeof d === 'string' ? new Uint8Array(Buffer.from(d, enc || 'utf8')) : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
  const out = (bytes, enc) => { const b = Buffer.from(bytes); return enc && enc !== 'buffer' ? b.toString(enc) : b; };
  class Hash extends stream.Transform {
    constructor(h) { super(); this._h = h; }
    update(d, enc) { this._h.update(toU8(d, enc)); return this; }
    digest(enc) { return out(this._h.digest(), enc); }
    copy() { return new Hash(this._h.clone()); }
    _transform(c, e, cb) { this.update(c, e); cb(); }
    _flush(cb) { this.push(this.digest()); cb(); }
  }
  const webcrypto = host.crypto;
  const randomBytes = (n, cb) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i += 65536) webcrypto.getRandomValues(new Uint8Array(b.buffer, b.byteOffset + i, Math.min(65536, n - i))); if (cb) { queueMicrotask(() => cb(null, b)); return; } return b; };
  const ni = (name) => notImplemented(track, 'crypto.' + name);
  const c = {
    webcrypto, subtle: webcrypto.subtle,
    getRandomValues: (a) => webcrypto.getRandomValues(a),
    randomUUID: () => webcrypto.randomUUID(),
    randomBytes, pseudoRandomBytes: randomBytes,
    randomFillSync: (buf, offset = 0, size) => { const u = new Uint8Array(buf.buffer, buf.byteOffset + offset, size ?? buf.byteLength - offset); for (let i = 0; i < u.length; i += 65536) webcrypto.getRandomValues(u.subarray(i, i + 65536)); return buf; },
    randomFill: (buf, ...rest) => { const cb = rest.pop(); c.randomFillSync(buf, ...rest); queueMicrotask(() => cb(null, buf)); },
    randomInt: (min, max, cb) => { if (typeof max !== 'number') { cb = max; max = min; min = 0; } const v = min + (webcrypto.getRandomValues(new Uint32Array(1))[0] % (max - min)); if (cb) { queueMicrotask(() => cb(null, v)); return; } return v; },
    createHash: (name) => new Hash(getAlgo(name).create()),
    createHmac: (name, key) => new Hash(hmac.create(getAlgo(name), toU8(key))),
    hash: (name, data, enc = 'hex') => out(getAlgo(name)(toU8(data)), enc),
    getHashes: () => Object.keys(algos),
    getCiphers: () => [], getCurves: () => [],
    timingSafeEqual: (a, b) => { if (a.byteLength !== b.byteLength) { const e = new RangeError('Input buffers must have the same byte length'); e.code = 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH'; throw e; } let d = 0; const x = toU8(a), y = toU8(b); for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0; },
    pbkdf2Sync: (pw, salt, iterations, keylen, digest = 'sha1') => Buffer.from(pbkdf2(getAlgo(digest), toU8(pw), toU8(salt), { c: iterations, dkLen: keylen })),
    pbkdf2: (pw, salt, iterations, keylen, digest, cb) => { let r, e = null; try { r = c.pbkdf2Sync(pw, salt, iterations, keylen, digest); } catch (x) { e = x; } queueMicrotask(() => cb(e, r)); },
    createCipheriv: ni('createCipheriv'), createDecipheriv: ni('createDecipheriv'), createSign: ni('createSign'), createVerify: ni('createVerify'), sign: ni('sign'), verify: ni('verify'),
    createPublicKey: ni('createPublicKey'), createPrivateKey: ni('createPrivateKey'), createSecretKey: ni('createSecretKey'), generateKeyPairSync: ni('generateKeyPairSync'), generateKeyPair: ni('generateKeyPair'),
    publicEncrypt: ni('publicEncrypt'), privateDecrypt: ni('privateDecrypt'), scryptSync: ni('scryptSync'), scrypt: ni('scrypt'), createECDH: ni('createECDH'), createDiffieHellman: ni('createDiffieHellman'), hkdfSync: ni('hkdfSync'),
    X509Certificate: class X509Certificate { constructor() { ni('X509Certificate')(); } },
    KeyObject: class KeyObject {}, Hash, Hmac: Hash,
    constants: { RSA_PKCS1_PADDING: 1, RSA_PKCS1_OAEP_PADDING: 4, RSA_PKCS1_PSS_PADDING: 6, SSL_OP_NO_TLSv1: 67108864, SSL_OP_NO_TLSv1_1: 268435456, SSL_OP_ALL: 2147485776 },
    getFips: () => 0, setFips: () => {}, secureHeapUsed: () => ({ total: 0, used: 0, min: 0, utilization: 0 }),
  };
  return c;
}

// ---------------- zlib (fflate; no brotli, no zstd) ----------------
export function makeZlib({ Buffer, stream, track }) {
  const u8 = (d) => (typeof d === 'string' ? new Uint8Array(Buffer.from(d)) : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
  const syncFns = { gzipSync: fflate.gzipSync, gunzipSync: fflate.gunzipSync, deflateSync: fflate.zlibSync, inflateSync: fflate.unzlibSync, deflateRawSync: fflate.deflateSync, inflateRawSync: fflate.inflateSync, unzipSync: fflate.decompressSync };
  const z = { constants: { Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5, Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6, Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1, Z_DEFAULT_STRATEGY: 0, Z_DEFAULT_WINDOWBITS: 15, Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15, Z_DEFAULT_CHUNK: 16384,
    BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2, BROTLI_PARAM_MODE: 0, BROTLI_MODE_GENERIC: 0, BROTLI_MODE_TEXT: 1, BROTLI_PARAM_QUALITY: 1, BROTLI_MIN_QUALITY: 0, BROTLI_MAX_QUALITY: 11, BROTLI_DEFAULT_QUALITY: 11, BROTLI_PARAM_LGWIN: 2, BROTLI_PARAM_SIZE_HINT: 5, BROTLI_DECODE: 8, BROTLI_ENCODE: 9,
    ZSTD_e_continue: 0, ZSTD_e_flush: 1, ZSTD_e_end: 2, ZSTD_c_compressionLevel: 100 } };
  Object.assign(z, z.constants);
  for (const [name, fn] of Object.entries(syncFns)) {
    z[name] = (d) => Buffer.from(fn(u8(d)));
    z[name.replace(/Sync$/, '')] = (d, o, cb) => { cb = typeof o === 'function' ? o : cb; let r, e = null; try { r = z[name](d); } catch (x) { e = x; } queueMicrotask(() => cb(e, r)); };
  }
  const streamCls = (Cls, label) => function create() {
    let impl, tr;
    tr = new stream.Transform({
      transform(chunk, enc, cb) { try { impl.push(u8(chunk), false); cb(); } catch (e) { cb(e); } },
      flush(cb) { try { impl.push(new Uint8Array(0), true); cb(); } catch (e) { cb(e); } },
    });
    impl = new Cls((data) => { if (data.length) tr.push(Buffer.from(data)); });
    tr.close = (cb) => { tr.destroy(); cb && cb(); }; tr.flush = (k, cb) => { const f = typeof k === 'function' ? k : cb; f && queueMicrotask(f); }; tr.bytesWritten = 0;
    return tr;
  };
  z.createGzip = streamCls(fflate.Gzip); z.createGunzip = streamCls(fflate.Gunzip); z.createDeflate = streamCls(fflate.Zlib); z.createInflate = streamCls(fflate.Unzlib);
  z.createDeflateRaw = streamCls(fflate.Deflate); z.createInflateRaw = streamCls(fflate.Inflate); z.createUnzip = streamCls(fflate.Decompress);
  for (const n of ['brotliCompressSync', 'brotliDecompressSync', 'brotliCompress', 'brotliDecompress', 'createBrotliCompress', 'createBrotliDecompress', 'zstdCompressSync', 'zstdDecompressSync', 'createZstdCompress', 'createZstdDecompress']) z[n] = notImplemented(track, 'zlib.' + n);
  z.crc32 = (data, value = 0) => { let c = ~value >>> 0; for (const b of u8(data)) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  return z;
}

// ---------------- async_hooks ----------------
// There is no way to follow native async/await continuations in a browser (no AsyncContext, no promise hooks).
// This AsyncLocalStorage is exact for synchronous code and "sticky" across awaits: the store set by run() stays
// current until the promise returned by the callback settles. Concurrent run() calls can therefore observe each
// other's store. That is a known fidelity gap of this approach.
export function makeAsyncHooks({ track }) {
  let alsUsed = 0;
  class AsyncLocalStorage {
    constructor(opts) { this._store = opts && opts.defaultValue; this._enabled = true; alsUsed++; track('AsyncLocalStorage.new'); }
    run(store, fn, ...args) {
      const prev = this._store; this._store = store;
      let result;
      try { result = fn(...args); } catch (e) { this._store = prev; throw e; }
      if (result && typeof result.then === 'function') { track('AsyncLocalStorage.run(async)'); const restore = () => { if (this._store === store) this._store = prev; }; result.then(restore, restore); }
      else this._store = prev;
      return result;
    }
    exit(fn, ...args) { return this.run(undefined, fn, ...args); }
    getStore() { return this._store; }
    enterWith(store) { track('AsyncLocalStorage.enterWith'); this._store = store; }
    disable() { this._store = undefined; }
    static bind(fn) { return fn; }
    static snapshot() { return (fn, ...args) => fn(...args); }
  }
  class AsyncResource {
    constructor(type) { this.type = type; }
    runInAsyncScope(fn, thisArg, ...args) { return fn.apply(thisArg, args); }
    emitDestroy() { return this; } asyncId() { return 1; } triggerAsyncId() { return 0; }
    bind(fn, thisArg) { return fn.bind(thisArg); }
    static bind(fn, type, thisArg) { return thisArg ? fn.bind(thisArg) : fn; }
  }
  return { AsyncLocalStorage, AsyncResource, executionAsyncId: () => 1, triggerAsyncId: () => 0, executionAsyncResource: () => ({}), createHook: () => { track('async_hooks.createHook'); return { enable() { return this; }, disable() { return this; } }; }, asyncWrapProviders: {} };
}

// ---------------- the rest ----------------
export function makeMisc({ Buffer, EventEmitter, stream, util, process, track, host, evaluate, timers }) {
  const ni = (name) => notImplemented(track, name);
  const url = {
    ...urlPkg, URL, URLSearchParams,
    fileURLToPath: (u) => { const x = typeof u === 'string' ? new URL(u) : u; if (x.protocol !== 'file:') { const e = new TypeError('The URL must be of scheme file'); e.code = 'ERR_INVALID_URL_SCHEME'; throw e; } return decodeURIComponent(x.pathname); },
    pathToFileURL: (p) => new URL('file://' + encodeURI(p.startsWith('/') ? p : process.cwd() + '/' + p).replace(/[?#]/g, encodeURIComponent)),
    urlToHttpOptions: (u) => ({ protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), hash: u.hash, search: u.search, pathname: u.pathname, path: u.pathname + u.search, href: u.href, port: u.port ? Number(u.port) : undefined, auth: u.username ? decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password) : undefined }),
    domainToASCII: (d) => { try { return new URL('http://' + d).hostname; } catch { return ''; } }, domainToUnicode: (d) => d,
  };
  const timersPromises = {
    setTimeout: (ms, value, opts = {}) => new Promise((resolve, reject) => {
      if (opts.signal && opts.signal.aborted) { const e = new Error('The operation was aborted'); e.name = 'AbortError'; e.code = 'ABORT_ERR'; return reject(e); }
      const t = timers.setTimeout(() => resolve(value), ms); if (opts.ref === false) t.unref();
      if (opts.signal) opts.signal.addEventListener('abort', () => { timers.clearTimeout(t); const e = new Error('The operation was aborted'); e.name = 'AbortError'; e.code = 'ABORT_ERR'; reject(e); }, { once: true });
    }),
    setImmediate: (value) => new Promise((resolve) => timers.setImmediate(() => resolve(value))),
    setInterval: async function* (ms, value) { for (;;) { await timersPromises.setTimeout(ms); yield value; } },
    scheduler: { wait: (ms, o) => timersPromises.setTimeout(ms, undefined, o), yield: () => timersPromises.setImmediate() },
  };
  const channel = (name) => ({ name, hasSubscribers: false, publish() {}, subscribe() {}, unsubscribe() { return false; }, bindStore() {}, unbindStore() {}, runStores(ctx, fn, thisArg, ...args) { return fn.apply(thisArg, args); } });
  const tracing = (name) => { const tc = { start: channel(), end: channel(), asyncStart: channel(), asyncEnd: channel(), error: channel(), hasSubscribers: false, subscribe() {}, unsubscribe() {}, traceSync: (fn, ctx, thisArg, ...args) => fn.apply(thisArg, args), tracePromise: (fn, ctx, thisArg, ...args) => fn.apply(thisArg, args), traceCallback: (fn, pos, ctx, thisArg, ...args) => fn.apply(thisArg, args) }; return tc; };
  for (const [k, v] of Object.entries({ markResourceTiming: () => {}, eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }), timerify: (f) => f, nodeTiming: { name: 'node', entryType: 'node', startTime: 0, duration: 0, nodeStart: 0, v8Start: 0, bootstrapComplete: 0, environment: 0, loopStart: 0, loopExit: -1, idleTime: 0 } })) { try { if (!(k in host.performance)) host.performance[k] = v; } catch {} }
  const mem = () => host.performance.memory || { usedJSHeapSize: 0, totalJSHeapSize: 0, jsHeapSizeLimit: 2 ** 31 };
  class Console {
    constructor(stdout, stderr) { if (stdout && !stdout.write && stdout.stdout) ({ stdout, stderr } = stdout); this._stdout = stdout; this._stderr = stderr || stdout; this._counts = {}; this._timers = {}; this._indent = '';
      for (const k of ['log', 'info', 'debug', 'error', 'warn', 'trace', 'dir', 'table', 'group', 'groupEnd', 'groupCollapsed', 'time', 'timeEnd', 'timeLog', 'count', 'countReset', 'assert', 'clear', 'dirxml']) this[k] = this[k].bind(this); }
    _w(s, text) { s.write(this._indent + text.replace(/\n/g, '\n' + this._indent) + '\n'); }
    log(...a) { this._w(this._stdout, util.format(...a)); } info(...a) { this.log(...a); } debug(...a) { this.log(...a); } dirxml(...a) { this.log(...a); }
    error(...a) { this._w(this._stderr, util.format(...a)); } warn(...a) { this.error(...a); }
    trace(...a) { this.error('Trace: ' + util.format(...a) + '\n' + (new Error().stack || '').split('\n').slice(2).join('\n')); }
    dir(o, opts) { this._w(this._stdout, util.inspect(o, opts)); }
    table(d) { this.log(util.inspect(d)); }
    group(...a) { if (a.length) this.log(...a); this._indent += '  '; } groupCollapsed(...a) { this.group(...a); } groupEnd() { this._indent = this._indent.slice(2); }
    time(l = 'default') { this._timers[l] = host.performance.now(); } timeEnd(l = 'default') { this.timeLog(l); delete this._timers[l]; } timeLog(l = 'default', ...a) { this.log(`${l}: ${(host.performance.now() - (this._timers[l] ?? host.performance.now())).toFixed(3)}ms`, ...a); }
    count(l = 'default') { this.log(`${l}: ${(this._counts[l] = (this._counts[l] || 0) + 1)}`); } countReset(l = 'default') { delete this._counts[l]; }
    assert(c, ...a) { if (!c) this.error('Assertion failed' + (a.length ? ': ' + util.format(...a) : '')); }
    clear() {}
  }
  const nodeConsole = new Console(process.stdout, process.stderr);
  nodeConsole.Console = Console;
  class Script { constructor(code, opts) { this.code = code; this.filename = (opts && opts.filename) || 'evalmachine.<anonymous>'; } runInThisContext() { track('vm.Script.runInThisContext'); return evaluate(this.code, this.filename); } runInContext(ctx) { return vm.runInContext(this.code, ctx); } runInNewContext(ctx) { return vm.runInContext(this.code, ctx || {}); } createCachedData() { return Buffer.alloc(0); } }
  const vm = {
    Script, isContext: (o) => !!(o && o.__vmContext), createContext: (o = {}) => { Object.defineProperty(o, '__vmContext', { value: true, enumerable: false }); return o; },
    runInThisContext: (code, opts) => { track('vm.runInThisContext'); return evaluate(String(code), (opts && opts.filename) || 'vm'); },
    runInContext: (code, ctx) => { track('vm.runInContext'); return evaluate(`(function (__ctx) { with (__ctx) { return eval(${JSON.stringify(String(code))}); } })`, 'vm.runInContext')(ctx); },
    runInNewContext: (code, ctx) => vm.runInContext(code, ctx || {}),
    compileFunction: (code, params = []) => { track('vm.compileFunction'); return evaluate(`(function (${params.join(',')}) {${code}\n})`, 'vm.compileFunction'); },
    constants: { USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol('USE_MAIN_CONTEXT_DEFAULT_LOADER'), DONT_CONTEXTIFY: Symbol('DONT_CONTEXTIFY') },
    SourceTextModule: class { constructor() { ni('vm.SourceTextModule')(); } }, SyntheticModule: class { constructor() { ni('vm.SyntheticModule')(); } },
  };
  class Worker extends EventEmitter { constructor(file) { super(); track('worker_threads.Worker', String(file)); ni('worker_threads.Worker')(); } }
  const dnsLookup = (host_, opts, cb) => { if (typeof opts === 'function') { cb = opts; opts = {}; } track('dns.lookup', host_); const ip = /^[\d.]+$/.test(host_) ? host_ : host_ === 'localhost' ? '127.0.0.1' : '203.0.113.1'; queueMicrotask(() => (opts && opts.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4))); };
  const dns = { lookup: dnsLookup, resolve: (h, t, cb) => { cb = typeof t === 'function' ? t : cb; queueMicrotask(() => cb(Object.assign(new Error('queryA ENOTFOUND ' + h), { code: 'ENOTFOUND' }))); }, resolve4: (h, cb) => dns.resolve(h, cb), resolve6: (h, cb) => dns.resolve(h, cb),
    setDefaultResultOrder() {}, getDefaultResultOrder: () => 'verbatim', setServers() {}, getServers: () => [], ADDRCONFIG: 1024, V4MAPPED: 2048, ALL: 256,
    promises: { lookup: (h, o) => new Promise((res, rej) => dnsLookup(h, o || {}, (e, a, f) => (e ? rej(e) : res(o && o.all ? a : { address: a, family: f })))), resolve: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); }, Resolver: class {} }, Resolver: class {} };
  return {
    url, querystring: querystringPkg, punycode: punycodePkg, string_decoder: { StringDecoder },
    timers: { ...timers, promises: timersPromises }, 'timers/promises': timersPromises,
    console: nodeConsole,
    diagnostics_channel: { channel, hasSubscribers: () => false, subscribe() {}, unsubscribe() { return false; }, tracingChannel: tracing, Channel: class Channel {} },
    perf_hooks: { performance: host.performance, PerformanceObserver: host.PerformanceObserver || class { observe() {} disconnect() {} }, PerformanceEntry: host.PerformanceEntry, monitorEventLoopDelay: () => ({ enable() {}, disable() {}, reset() {}, min: 0, max: 0, mean: 0, stddev: 0, percentile: () => 0, percentiles: new Map() }), constants: {}, createHistogram: () => ({ record() {}, percentile: () => 0, min: 0, max: 0, mean: 0 }) },
    v8: { getHeapStatistics: () => ({ total_heap_size: mem().totalJSHeapSize, used_heap_size: mem().usedJSHeapSize, heap_size_limit: mem().jsHeapSizeLimit, total_available_size: mem().jsHeapSizeLimit - mem().usedJSHeapSize, total_physical_size: mem().totalJSHeapSize, malloced_memory: 0, external_memory: 0, number_of_native_contexts: 1, number_of_detached_contexts: 0 }), getHeapSpaceStatistics: () => [], getHeapSnapshot: ni('v8.getHeapSnapshot'), writeHeapSnapshot: ni('v8.writeHeapSnapshot'), setFlagsFromString: () => {}, cachedDataVersionTag: () => 0, serialize: ni('v8.serialize'), deserialize: ni('v8.deserialize'), isStringOneByteRepresentation: (s) => !/[^\u0000-ÿ]/.test(s), startupSnapshot: { isBuildingSnapshot: () => false }, setHeapSnapshotNearHeapLimit: () => {}, getCppHeapStatistics: () => ({}) },
    vm,
    worker_threads: { isMainThread: true, parentPort: null, workerData: null, threadId: 0, resourceLimits: {}, Worker, MessageChannel: host.MessageChannel, MessagePort: host.MessagePort, BroadcastChannel: host.BroadcastChannel, markAsUncloneable: () => {}, markAsUntransferable: () => {}, isMarkedAsUntransferable: () => false, receiveMessageOnPort: () => undefined, setEnvironmentData: () => {}, getEnvironmentData: () => undefined, SHARE_ENV: Symbol('SHARE_ENV') },
    dns, 'dns/promises': dns.promises,
    inspector: { url: () => undefined, open: () => {}, close: () => {}, waitForDebugger: () => {}, console: host.console, Session: class Session extends EventEmitter { connect() {} disconnect() {} post(m, p, cb) { const f = typeof p === 'function' ? p : cb; f && queueMicrotask(() => f(new Error('inspector not available'))); } } },
    http2: { constants: { HTTP2_HEADER_STATUS: ':status', HTTP2_HEADER_METHOD: ':method', HTTP2_HEADER_PATH: ':path', HTTP2_HEADER_AUTHORITY: ':authority', HTTP2_HEADER_SCHEME: ':scheme', HTTP2_HEADER_CONTENT_LENGTH: 'content-length', HTTP2_HEADER_CONTENT_TYPE: 'content-type', HTTP2_HEADER_EXPECT: 'expect', NGHTTP2_CANCEL: 8, NGHTTP2_NO_ERROR: 0 }, connect: ni('http2.connect'), createServer: ni('http2.createServer'), createSecureServer: ni('http2.createSecureServer'), getDefaultSettings: () => ({}), sensitiveHeaders: Symbol('nodejs.http2.sensitiveHeaders') },
    cluster: { isPrimary: true, isMaster: true, isWorker: false, workers: {}, fork: ni('cluster.fork'), on() {} },
    dgram: { createSocket: ni('dgram.createSocket') },
    domain: { create: () => { track('domain.create'); const d = new EventEmitter(); d.run = (fn) => fn(); d.add = () => {}; d.remove = () => {}; d.bind = (f) => f; d.intercept = (f) => f; d.enter = () => {}; d.exit = () => {}; return d; } },
    repl: { start: ni('repl.start') },
    trace_events: { createTracing: () => ({ enable() {}, disable() {}, enabled: false }), getEnabledCategories: () => undefined },
    wasi: { WASI: class WASI { constructor() { ni('wasi.WASI')(); } } },
    'stream/consumers': (() => {
      const collect = async (s) => { const chunks = []; for await (const c of s) chunks.push(typeof c === 'string' ? Buffer.from(c) : Buffer.from(c.buffer ? new Uint8Array(c.buffer, c.byteOffset, c.byteLength) : c)); return Buffer.concat(chunks); };
      return { buffer: collect, text: async (s) => (await collect(s)).toString('utf8'), json: async (s) => JSON.parse((await collect(s)).toString('utf8')), arrayBuffer: async (s) => { const b = await collect(s); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }, blob: async (s) => new Blob([await collect(s)]) };
    })(),
    'stream/web': { ReadableStream: TrackedReadableStream, WritableStream, TransformStream, ReadableStreamDefaultReader, WritableStreamDefaultWriter, ByteLengthQueuingStrategy, CountQueuingStrategy, TextEncoderStream, TextDecoderStream, CompressionStream, DecompressionStream, ReadableByteStreamController: globalThis.ReadableByteStreamController, ReadableStreamBYOBReader: globalThis.ReadableStreamBYOBReader, ReadableStreamDefaultController: globalThis.ReadableStreamDefaultController },
  };
}

export { lazy, notImplemented, assertPkg };
