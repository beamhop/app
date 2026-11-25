// buffer, events, stream, util, path, os, tty, readline: thin layers over the polyfill packages, patched where
// harnesses depend on behaviour the packages lack. The list of patches is the list of things that broke.
import { assertPkg, BufferPkg, EventEmitterPkg, INSPECT_MAX_BYTES, kMaxLength, pathPkg, SlowBufferPkg as SlowBuffer, streamPkg, utilPkg } from '../vendor.js'
import type { Dyn, Track } from '../types.js'

/** A stub for an API the layer does not provide: throws a recognisable error and records the attempt. */
export const notImplemented =
  (track: Track, name: string) =>
  (): never => {
    track('not-implemented', name)
    throw Object.assign(new Error(`${name} is not implemented in the machine's Node layer`), { code: 'ERR_NOT_IMPLEMENTED_IN_EMULATION' })
  }
// ---------------- buffer ----------------
export function makeBuffer() {
  const Buffer = BufferPkg
  if (!Buffer.__patched) {
    Buffer.__patched = true
    const b64uToB64 = (s?: Dyn) => s.replace(/-/g, '+').replace(/_/g, '/')
    const b64ToB64u = (s?: Dyn) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const isB64u = (e?: Dyn) => typeof e === 'string' && e.toLowerCase() === 'base64url'
    const origFrom = Buffer.from,
      origToString = Buffer.prototype.toString,
      origWrite = Buffer.prototype.write,
      origIsEncoding = Buffer.isEncoding,
      origByteLength = Buffer.byteLength
    Buffer.from = function (value?: Dyn, enc?: Dyn, len?: Dyn) {
      if (typeof value === 'string' && isB64u(enc)) return origFrom.call(Buffer, b64uToB64(value), 'base64')
      return origFrom.call(Buffer, value, enc, len)
    }
    Buffer.prototype.toString = function (enc?: Dyn, start?: Dyn, end?: Dyn) {
      if (isB64u(enc)) return b64ToB64u(origToString.call(this, 'base64', start, end))
      return origToString.call(this, enc, start, end)
    }
    Buffer.prototype.write = function (string?: Dyn, offset?: Dyn, length?: Dyn, enc?: Dyn) {
      const e = typeof offset === 'string' ? offset : typeof length === 'string' ? length : enc
      if (isB64u(e)) {
        const b = Buffer.from(string, 'base64url')
        const off = typeof offset === 'number' ? offset : 0
        b.copy(this, off)
        return b.length
      }
      return origWrite.call(this, string, offset, length, enc)
    }
    Buffer.isEncoding = (e?: Dyn) => isB64u(e) || origIsEncoding(e)
    Buffer.byteLength = (s?: Dyn, e?: Dyn) => (isB64u(e) ? Buffer.from(s, e).length : origByteLength(s, e))
    for (const [name, enc] of [
      ['utf8Slice', 'utf8'],
      ['latin1Slice', 'latin1'],
      ['asciiSlice', 'ascii'],
      ['hexSlice', 'hex'],
      ['base64Slice', 'base64'],
      ['ucs2Slice', 'ucs2'],
    ])
      Buffer.prototype[name] ??= function (s?: Dyn, e?: Dyn) {
        return this.toString(enc, s, e)
      }
    for (const [name, enc] of [
      ['utf8Write', 'utf8'],
      ['latin1Write', 'latin1'],
      ['asciiWrite', 'ascii'],
      ['hexWrite', 'hex'],
      ['base64Write', 'base64'],
      ['ucs2Write', 'ucs2'],
    ])
      Buffer.prototype[name] ??= function (str?: Dyn, o?: Dyn, l?: Dyn) {
        return this.write(str, o, l, enc)
      }
    Buffer.poolSize ??= 8192
  }
  const isUtf8 = (b?: Dyn) => {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(b)
      return true
    } catch {
      return false
    }
  }
  const isAscii = (b?: Dyn) => {
    const u = b instanceof Uint8Array ? b : new Uint8Array(b)
    for (let i = 0; i < u.length; i++) if (u[i] > 127) return false
    return true
  }
  return {
    Buffer,
    SlowBuffer,
    kMaxLength,
    INSPECT_MAX_BYTES,
    kStringMaxLength: 536870888,
    constants: { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: 536870888 },
    Blob: globalThis.Blob,
    File: globalThis.File,
    atob: globalThis.atob.bind(globalThis),
    btoa: globalThis.btoa.bind(globalThis),
    isUtf8,
    isAscii,
    transcode: (buf?: Dyn, from?: Dyn, to?: Dyn) => Buffer.from(Buffer.from(buf).toString(from), to),
    resolveObjectURL: () => undefined,
  }
}

// ---------------- events ----------------
export function makeEvents() {
  const EventEmitter = EventEmitterPkg
  if (!EventEmitter.__patched) {
    EventEmitter.__patched = true
    EventEmitter.errorMonitor ??= Symbol('events.errorMonitor')
    EventEmitter.captureRejectionSymbol ??= Symbol.for('nodejs.rejection')
    EventEmitter.setMaxListeners = (n?: Dyn, ...targets: Dyn[]) => {
      for (const t of targets) if (t && typeof t.setMaxListeners === 'function') t.setMaxListeners(n)
    }
    EventEmitter.getMaxListeners = (t?: Dyn) => (t && typeof t.getMaxListeners === 'function' ? t.getMaxListeners() : 10)
    EventEmitter.getEventListeners = (t?: Dyn, name?: Dyn) => (t && typeof t.listeners === 'function' ? t.listeners(name) : [])
    EventEmitter.addAbortListener = (signal?: Dyn, listener?: Dyn) => {
      signal.addEventListener('abort', listener, { once: true })
      return {
        [Symbol.dispose]() {
          signal.removeEventListener('abort', listener)
        },
      }
    }
    EventEmitter.on = function on(emitter?: Dyn, event?: Dyn, opts: Dyn = {}) {
      const queue: Dyn[] = []
      const waiters: Dyn[] = []
      let error: Dyn = null
      let done = false
      const handler = (...args: Dyn[]) => {
        const w = waiters.shift()
        if (w) w.resolve({ value: args, done: false })
        else queue.push(args)
      }
      const onError = (e?: Dyn) => {
        const w = waiters.shift()
        if (w) w.reject(e)
        else error = e
      }
      const add = (n?: Dyn, h?: Dyn) => (emitter.addEventListener ? emitter.addEventListener(n, h) : emitter.on(n, h))
      const remove = (n?: Dyn, h?: Dyn) => (emitter.removeEventListener ? emitter.removeEventListener(n, h) : emitter.removeListener(n, h))
      add(event, handler)
      if (event !== 'error' && emitter.on) emitter.on('error', onError)
      const finish = () => {
        done = true
        remove(event, handler)
        if (emitter.on) emitter.removeListener('error', onError)
        for (const w of waiters.splice(0)) w.resolve({ value: undefined, done: true })
      }
      if (opts.signal)
        opts.signal.addEventListener(
          'abort',
          () => {
            const e: Dyn = new Error('The operation was aborted')
            e.name = 'AbortError'
            e.code = 'ABORT_ERR'
            onError(e)
            finish()
          },
          { once: true },
        )
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
          if (error) {
            const e = error
            error = null
            return Promise.reject(e)
          }
          if (done) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve?: Dyn, reject?: Dyn) => waiters.push({ resolve, reject }))
        },
        return() {
          finish()
          return Promise.resolve({ value: undefined, done: true })
        },
        throw(e?: Dyn) {
          finish()
          return Promise.reject(e)
        },
        [Symbol.asyncIterator]() {
          return this
        },
      }
    }
    const origOnce = EventEmitter.once
    EventEmitter.once = (emitter?: Dyn, name?: Dyn, opts?: Dyn) => {
      if (emitter && typeof emitter.addEventListener === 'function' && typeof emitter.on !== 'function') {
        return new Promise((resolve?: Dyn, reject?: Dyn) => {
          emitter.addEventListener(name, (...a: Dyn[]) => resolve(a), { once: true })
          if (opts && opts.signal)
            opts.signal.addEventListener(
              'abort',
              () => {
                const e: Dyn = new Error('The operation was aborted')
                e.name = 'AbortError'
                reject(e)
              },
              { once: true },
            )
        })
      }
      const p = origOnce(emitter, name)
      if (opts && opts.signal)
        return Promise.race([
          p,
          new Promise((_?: Dyn, reject?: Dyn) =>
            opts.signal.addEventListener(
              'abort',
              () => {
                const e: Dyn = new Error('The operation was aborted')
                e.name = 'AbortError'
                e.code = 'ABORT_ERR'
                reject(e)
              },
              { once: true },
            ),
          ),
        ])
      return p
    }
    EventEmitter.EventEmitterAsyncResource = class EventEmitterAsyncResource extends EventEmitter {
      get asyncResource() {
        return { runInAsyncScope: (fn?: Dyn, thisArg?: Dyn, ...args: Dyn[]) => fn.apply(thisArg, args) }
      }
      emitDestroy() {}
    }
    EventEmitter.usingDomains = false
    EventEmitter.EventEmitter = EventEmitter
  }
  return EventEmitter
}

// ---------------- stream ----------------
// Node's stream.finished()/isErrored()/isDisturbed() accept web streams by peeking at internal state. A browser
// gives no synchronous access to that state, so guest code gets a ReadableStream subclass that records it.
interface WebStreamState {
  state: 'readable' | 'closed' | 'errored'
  error: unknown
  waiters: ((error?: unknown) => void)[]
}
const webState = new WeakMap<object, WebStreamState>()
// The base is typed loosely because lib.dom declares ReadableStream with overloaded constructors, which a subclass cannot extend.
export const TrackedReadableStream = class ReadableStream extends (globalThis.ReadableStream as Dyn) {
  constructor(source: Dyn = {}, strategy?: Dyn) {
    const st: WebStreamState = { state: 'readable', error: undefined, waiters: [] }
    const settle = (state: 'closed' | 'errored', error?: unknown) => {
      if (st.state !== 'readable') return
      st.state = state
      st.error = error
      for (const w of st.waiters.splice(0)) queueMicrotask(() => w(state === 'errored' ? error : undefined))
    }
    const wrapController = (c?: Dyn) =>
      new Proxy(c, {
        get(t?: Dyn, k?: Dyn) {
          if (k === 'close')
            return () => {
              t.close()
              settle('closed')
            }
          if (k === 'error')
            return (e?: Dyn) => {
              t.error(e)
              settle('errored', e)
            }
          const v = t[k]
          return typeof v === 'function' ? v.bind(t) : v
        },
      })
    const wrapped: Dyn = {}
    if (source.type !== undefined) wrapped.type = source.type
    if (source.autoAllocateChunkSize !== undefined) wrapped.autoAllocateChunkSize = source.autoAllocateChunkSize
    let wc: Dyn
    const ctl = (c?: Dyn) => (wc ??= wrapController(c))
    if (source.start) wrapped.start = (c?: Dyn) => source.start(ctl(c))
    if (source.pull) wrapped.pull = (c?: Dyn) => source.pull(ctl(c))
    wrapped.cancel = (reason?: Dyn) => {
      settle('closed')
      return source.cancel ? source.cancel(reason) : undefined
    }
    super(wrapped, strategy)
    webState.set(this, st)
  }
}
export function makeStream(Buffer?: Dyn) {
  const stream = streamPkg
  if (!Object.prototype.hasOwnProperty.call(stream, '__patched')) {
    stream.__patched = true
    const { Readable, Writable, Duplex } = stream
    Readable.fromWeb = (rs?: Dyn, options: Dyn = {}) => {
      const reader = rs.getReader()
      let closed = false
      const r = new Readable({
        ...options,
        read() {
          reader.read().then(
            ({ done, value }: Dyn) => {
              if (done) {
                closed = true
                r.push(null)
              } else
                r.push(
                  options.objectMode ? value : Buffer.from(value.buffer ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value),
                )
            },
            (e?: Dyn) => r.destroy(e),
          )
        },
        destroy(err?: Dyn, cb?: Dyn) {
          if (!closed) reader.cancel(err).catch(() => {})
          cb(err)
        },
      })
      return r
    }
    Readable.toWeb = (readable?: Dyn) => {
      let cancelled = false
      return new ReadableStream({
        start(controller?: Dyn) {
          readable.on('data', (chunk?: Dyn) => {
            controller.enqueue(
              typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
            )
            if (controller.desiredSize <= 0) readable.pause()
          })
          readable.on('end', () => {
            if (!cancelled) controller.close()
          })
          readable.on('error', (e?: Dyn) => {
            if (!cancelled) controller.error(e)
          })
          readable.pause()
        },
        pull() {
          readable.resume()
        },
        cancel(reason?: Dyn) {
          cancelled = true
          readable.destroy(reason)
        },
      })
    }
    Writable.fromWeb = (ws?: Dyn, options: Dyn = {}) => {
      const writer = ws.getWriter()
      return new Writable({
        ...options,
        write(chunk?: Dyn, enc?: Dyn, cb?: Dyn) {
          writer.write(chunk).then(() => cb(), cb)
        },
        final(cb?: Dyn) {
          writer.close().then(() => cb(), cb)
        },
        destroy(err?: Dyn, cb?: Dyn) {
          if (err) writer.abort(err).catch(() => {})
          cb(err)
        },
      })
    }
    Writable.toWeb = (writable?: Dyn) =>
      new WritableStream({
        write(chunk?: Dyn) {
          return new Promise((resolve?: Dyn, reject?: Dyn) => writable.write(chunk, (e?: Dyn) => (e ? reject(e) : resolve())))
        },
        close() {
          return new Promise((resolve?: Dyn) => writable.end(resolve))
        },
        abort(reason?: Dyn) {
          writable.destroy(reason)
        },
      })
    Duplex.fromWeb = (pair?: Dyn, options?: Dyn) => {
      const r = Readable.fromWeb(pair.readable, options),
        w = Writable.fromWeb(pair.writable, options)
      return Duplex.from({ readable: r, writable: w })
    }
    Duplex.toWeb = (duplex?: Dyn) => ({ readable: Readable.toWeb(duplex), writable: Writable.toWeb(duplex) })
    const origFinished = stream.finished,
      origIsErrored = stream.isErrored,
      origIsDisturbed = stream.isDisturbed
    const isWeb = (s?: Dyn) => s instanceof globalThis.ReadableStream || s instanceof globalThis.WritableStream
    stream.finished = function finished(s?: Dyn, opts?: Dyn, cb?: Dyn) {
      if (!isWeb(s)) return origFinished.call(this, s, opts, cb)
      if (typeof opts === 'function') cb = opts
      const st = webState.get(s)
      if (!st) return () => {} // a native stream we cannot observe: the callback never fires
      if (st.state !== 'readable') queueMicrotask(() => cb(st.state === 'errored' ? st.error : undefined))
      else st.waiters.push(cb)
      return () => {
        const i = st.waiters.indexOf(cb)
        if (i !== -1) st.waiters.splice(i, 1)
      }
    }
    stream.isErrored = (s?: Dyn) => (isWeb(s) ? (webState.get(s) || {}).state === 'errored' : origIsErrored ? origIsErrored(s) : !!(s && s.errored))
    stream.isDisturbed = (s?: Dyn) => (isWeb(s) ? !!s.locked : origIsDisturbed ? origIsDisturbed(s) : !!(s && s.readableDidRead))
    if (stream.promises) {
      const pf = stream.promises.finished
      stream.promises.finished = (s?: Dyn, o?: Dyn) =>
        isWeb(s) ? new Promise((res?: Dyn, rej?: Dyn) => stream.finished(s, (e?: Dyn) => (e ? rej(e) : res()))) : pf(s, o)
    }
    if (!Object.prototype.hasOwnProperty.call(stream, 'isReadable'))
      stream.isReadable = (s?: Dyn) => !!s && s.readable !== false && !s.destroyed && !s.readableEnded
    if (!Object.prototype.hasOwnProperty.call(stream, 'isWritable'))
      stream.isWritable = (s?: Dyn) => !!s && s.writable !== false && !s.destroyed && !s.writableEnded
    stream.isErrored ??= (s?: Dyn) =>
      !!(s && (s.errored || (s._readableState && s._readableState.errored) || (s._writableState && s._writableState.errored)))
    stream.isDisturbed ??= (s?: Dyn) =>
      !!(s && (s.readableDidRead || s.readableAborted || (typeof ReadableStream !== 'undefined' && s instanceof ReadableStream && s.locked)))
    if (!Object.prototype.hasOwnProperty.call(stream, 'getDefaultHighWaterMark'))
      stream.getDefaultHighWaterMark = (objectMode?: Dyn) => (objectMode ? 16 : 16384)
    if (!Object.prototype.hasOwnProperty.call(stream, 'setDefaultHighWaterMark')) stream.setDefaultHighWaterMark = () => {}
    if (!Object.prototype.hasOwnProperty.call(stream, 'duplexPair'))
      stream.duplexPair = () => {
        let a, b
        a = new Duplex({
          read() {},
          write(c?: Dyn, e?: Dyn, cb?: Dyn) {
            b.push(c)
            cb()
          },
          final(cb?: Dyn) {
            b.push(null)
            cb()
          },
        })
        b = new Duplex({
          read() {},
          write(c?: Dyn, e?: Dyn, cb?: Dyn) {
            a.push(c)
            cb()
          },
          final(cb?: Dyn) {
            a.push(null)
            cb()
          },
        })
        return [a, b]
      }
  }
  return stream
}

// ---------------- util ----------------
export function makeUtil({ Buffer, process }: Dyn) {
  const util = { ...utilPkg }
  const ansi =
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g
  // The package's format() quotes strings when the first argument is not a string (`console.log(1, 'a')` prints
  // 1 'a'). Node only inspects non-strings. This is Node's algorithm.
  util.formatWithOptions = (inspectOptions: Dyn, ...args: Dyn[]): string => {
    const show = (v: Dyn): string => (typeof v === 'string' ? v : util.inspect(v, inspectOptions))
    if (typeof args[0] !== 'string') return args.map(show).join(' ')
    let i = 1
    let out = String(args[0]).replace(/%[sdifjoOc%]/g, (m: string) => {
      if (m === '%%') return '%'
      if (i >= args.length) return m
      const v = args[i++]
      switch (m) {
        case '%s':
          return typeof v === 'string' ? v : typeof v === 'bigint' ? `${v}n` : typeof v === 'object' && v !== null ? util.inspect(v, { ...inspectOptions, depth: 0, colors: false }) : String(v)
        case '%d':
          return typeof v === 'bigint' ? `${v}n` : typeof v === 'symbol' ? 'NaN' : String(Number(v))
        case '%i':
          return typeof v === 'bigint' ? `${v}n` : typeof v === 'symbol' ? 'NaN' : String(parseInt(v, 10))
        case '%f':
          return typeof v === 'symbol' ? 'NaN' : String(parseFloat(v))
        case '%j':
          try {
            return JSON.stringify(v)
          } catch {
            return '[Circular]'
          }
        case '%c':
          return ''
        default:
          return util.inspect(v, { ...inspectOptions, showHidden: m === '%o', depth: m === '%o' ? 4 : undefined })
      }
    })
    for (; i < args.length; i++) out += ' ' + show(args[i])
    return out
  }
  util.format = (...args: Dyn[]): string => util.formatWithOptions({}, ...args)
  util.stripVTControlCharacters = (s?: Dyn) => String(s).replace(ansi, '')
  util.TextEncoder = TextEncoder
  util.TextDecoder = TextDecoder
  util.toUSVString = (s?: Dyn) => (String(s) as string & { toWellFormed(): string }).toWellFormed()
  util.styleText = (fmt?: Dyn, text?: Dyn) => {
    const codes = util.inspect.colors
    let out = String(text)
    for (const f of [].concat(fmt)) {
      const c = codes[f]
      if (c) out = `\u001b[${c[0]}m${out}\u001b[${c[1]}m`
    }
    return out
  }
  util.isDeepStrictEqual = (a?: Dyn, b?: Dyn) => {
    try {
      assertPkg.deepStrictEqual(a, b)
      return true
    } catch {
      return false
    }
  }
  util.parseEnv = (text?: Dyn) =>
    Object.fromEntries(
      String(text)
        .split('\n')
        .map((l?: Dyn) => l.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/))
        .filter(Boolean)
        .map((m?: Dyn) => [m[1], (m[2] || '').replace(/^(['"])(.*)\1$/, '$2')]),
    )
  util.getSystemErrorName = (n?: Dyn) =>
    ({ '-2': 'ENOENT', '-13': 'EACCES', '-17': 'EEXIST', '-111': 'ECONNREFUSED', '-104': 'ECONNRESET' } as Record<string, string>)[String(n)] || 'UNKNOWN'
  util.getSystemErrorMap = () => new Map()
  util.aborted = (signal?: Dyn) => new Promise((resolve?: Dyn) => signal.addEventListener('abort', () => resolve(), { once: true }))
  util.MIMEType = class MIMEType {
    [field: string]: Dyn // type, subtype, essence, params
    constructor(s?: Dyn) {
      const [essence, ...params] = String(s).split(';')
      ;[this.type, this.subtype] = essence.trim().split('/')
      this.essence = essence.trim()
      this.params = new Map(params.map((p?: Dyn) => p.trim().split('=')))
    }
    toString() {
      return this.essence
    }
  }
  util.debuglog = util.debuglog || (() => Object.assign(() => {}, { enabled: false }))
  util.debug = util.debuglog
  util.getCallSites = () => []
  util.transferableAbortController = () => new AbortController()
  util.transferableAbortSignal = (s?: Dyn) => s
  util.parseArgs = (config: Dyn = {}) => {
    const args = config.args || process.argv.slice(2),
      options: Record<string, Dyn> = config.options || {},
      values: Record<string, Dyn> = {},
      positionals: string[] = []
    const byShort = Object.fromEntries(
      Object.entries(options)
        .filter(([, o]: Dyn) => o.short)
        .map(([k, o]: Dyn) => [o.short, k]),
    )
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a === '--') {
        positionals.push(...args.slice(i + 1))
        break
      }
      let name, val
      if (a.startsWith('--')) {
        ;[name, val] = a.slice(2).split(/=(.*)/s)
      } else if (a.startsWith('-') && a.length > 1) {
        name = byShort[a[1]] || a[1]
        val = a.length > 2 ? a.slice(2) : undefined
      } else {
        if (config.allowPositionals === false || (config.strict !== false && !config.allowPositionals)) {
          const e: Dyn = new TypeError(`Unexpected argument '${a}'`)
          e.code = 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL'
          throw e
        }
        positionals.push(a)
        continue
      }
      const opt = options[name]
      if (!opt && config.strict !== false) {
        const e: Dyn = new TypeError(`Unknown option '${a}'`)
        e.code = 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
        throw e
      }
      const v = opt && opt.type === 'string' ? (val ?? args[++i]) : (val ?? true)
      if (opt && opt.multiple) (values[name] ||= []).push(v)
      else values[name] = v
    }
    for (const [k, o] of Object.entries(options)) if (!(k in values) && o.default !== undefined) values[k] = o.default
    return { values, positionals }
  }
  const t = { ...(utilPkg.types || {}) }
  t.isUint8Array ??= (v?: Dyn) => v instanceof Uint8Array
  t.isAnyArrayBuffer ??= (v?: Dyn) => v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer)
  t.isArrayBufferView ??= ArrayBuffer.isView
  t.isProxy ??= () => false
  t.isExternal ??= () => false
  t.isModuleNamespaceObject ??= (v?: Dyn) => !!v && v[Symbol.toStringTag] === 'Module'
  t.isKeyObject ??= () => false
  t.isCryptoKey ??= (v?: Dyn) => typeof CryptoKey !== 'undefined' && v instanceof CryptoKey
  t.isNativeError ??= (v?: Dyn) => v instanceof Error
  t.isBoxedPrimitive ??= (v?: Dyn) => v instanceof Number || v instanceof String || v instanceof Boolean
  util.types = t
  util.promisify = Object.assign(
    (fn?: Dyn) => {
      if (fn && fn[utilPkg.promisify.custom]) return fn[utilPkg.promisify.custom]
      return utilPkg.promisify(fn)
    },
    { custom: utilPkg.promisify.custom },
  )
  return util
}

// ---------------- path / os / tty / misc ----------------
export function makePath() {
  const p = { ...pathPkg }
  p.posix = p
  p.win32 = p
  p.toNamespacedPath = (x?: Dyn) => x
  p.matchesGlob = (file?: Dyn, pattern?: Dyn) =>
    new RegExp(
      '^' +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*\/?/g, '\u0000')
          .replace(/\*/g, '[^/]*')
          .replace(/\u0000/g, '.*')
          .replace(/\?/g, '[^/]') +
        '$',
    ).test(file)
  return p
}

export function makeOs({ process, host }: Dyn) {
  const signals = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGILL: 4,
    SIGTRAP: 5,
    SIGABRT: 6,
    SIGBUS: 7,
    SIGFPE: 8,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGSEGV: 11,
    SIGUSR2: 12,
    SIGPIPE: 13,
    SIGALRM: 14,
    SIGTERM: 15,
    SIGCHLD: 17,
    SIGCONT: 18,
    SIGSTOP: 19,
    SIGTSTP: 20,
    SIGTTIN: 21,
    SIGTTOU: 22,
    SIGWINCH: 28,
  }
  const n = (host.navigator && host.navigator.hardwareConcurrency) || 4
  return {
    EOL: '\n',
    devNull: '/dev/null',
    platform: () => 'linux',
    type: () => 'Linux',
    arch: () => 'x64',
    machine: () => 'x86_64',
    release: () => '6.8.0-browser',
    version: () => '#1 SMP universal-sandbox',
    endianness: () => 'LE',
    homedir: () => process.env.HOME || '/home/user',
    tmpdir: () => process.env.TMPDIR || '/tmp',
    hostname: () => 'sandbox',
    cpus: () => Array.from({ length: n }, () => ({ model: 'Browser vCPU', speed: 2000, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } })),
    availableParallelism: () => n,
    totalmem: () => 4 * 2 ** 30,
    freemem: () => 2 * 2 ** 30,
    uptime: () => Math.floor(host.performance.now() / 1000),
    loadavg: () => [0, 0, 0],
    userInfo: () => ({ username: process.env.USER || 'user', uid: 1000, gid: 1000, shell: '/bin/bash', homedir: process.env.HOME || '/home/user' }),
    networkInterfaces: () => ({}),
    getPriority: () => 0,
    setPriority: () => {},
    constants: {
      signals,
      errno: {
        ENOENT: 2,
        EACCES: 13,
        EEXIST: 17,
        ENOTDIR: 20,
        EISDIR: 21,
        EINVAL: 22,
        EPIPE: 32,
        ECONNRESET: 104,
        ECONNREFUSED: 111,
        ETIMEDOUT: 110,
      },
      priority: { PRIORITY_LOW: 19, PRIORITY_NORMAL: 0, PRIORITY_HIGH: -7 },
      UV_UDP_REUSEADDR: 4,
      dlopen: {},
    },
  }
}

export function makeTty({ stream }: Dyn) {
  class ReadStream extends stream.Readable {
    constructor(fd?: Dyn) {
      super({ read() {} })
      this.fd = fd
      this.isTTY = false
      this.isRaw = false
    }
    setRawMode() {
      return this
    }
  }
  class WriteStream extends stream.Writable {
    constructor(fd?: Dyn) {
      super({
        write(c?: Dyn, e?: Dyn, cb?: Dyn) {
          cb()
        },
      })
      this.fd = fd
      this.isTTY = false
      this.columns = 80
      this.rows = 24
    }
    getColorDepth() {
      return 1
    }
    hasColors() {
      return false
    }
    getWindowSize() {
      return [80, 24]
    }
  }
  return { isatty: () => false, ReadStream, WriteStream }
}

export function makeReadline({ EventEmitter, process, util }: Dyn) {
  class Interface extends EventEmitter {
    constructor(opts: Dyn = {}, output?: Dyn) {
      super()
      if (opts && typeof opts.on === 'function') opts = { input: opts, output }
      this.input = opts.input
      this.output = opts.output
      this.terminal = false
      this.line = ''
      this.cursor = 0
      this.closed = false
      this._prompt = opts.prompt ?? '> '
      this._buf = ''
      this._questions = []
      this._decoder = new TextDecoder()
      if (this.input) {
        this._onData = (chunk?: Dyn) => {
          this._buf += typeof chunk === 'string' ? chunk : this._decoder.decode(chunk, { stream: true })
          let idx
          while ((idx = this._buf.search(/\r?\n/)) !== -1) {
            const line = this._buf.slice(0, idx)
            this._buf = this._buf.slice(idx + (this._buf[idx] === '\r' ? 2 : 1))
            this._line(line)
          }
        }
        this._onEnd = () => {
          if (this._buf) {
            const l = this._buf
            this._buf = ''
            this._line(l)
          }
          this.close()
        }
        this.input.on('data', this._onData)
        this.input.on('end', this._onEnd)
      }
    }
    _line(line?: Dyn) {
      const q = this._questions.shift()
      if (q) q(line)
      else this.emit('line', line)
    }
    setPrompt(p?: Dyn) {
      this._prompt = p
    }
    getPrompt() {
      return this._prompt
    }
    prompt() {
      if (this.output) this.output.write(this._prompt)
    }
    question(query?: Dyn, opts?: Dyn, cb?: Dyn) {
      if (typeof opts === 'function') cb = opts
      if (this.output) this.output.write(query)
      this._questions.push(cb)
    }
    write(data?: Dyn) {
      if (typeof data === 'string') this._onData && this._onData(data)
    }
    pause() {
      this.input && this.input.pause()
      this.emit('pause')
      return this
    }
    resume() {
      this.input && this.input.resume()
      this.emit('resume')
      return this
    }
    close() {
      if (this.closed) return
      this.closed = true
      if (this.input) {
        this.input.removeListener('data', this._onData)
        this.input.removeListener('end', this._onEnd)
      }
      this.emit('close')
    }
    getCursorPos() {
      return { rows: 0, cols: 0 }
    }
    [Symbol.asyncIterator]() {
      const it = EventEmitter.on(this, 'line')
      const self = this
      this.once('close', () => it.return())
      return {
        next: () => it.next().then((r?: Dyn) => (r.done ? r : { value: r.value[0], done: false })),
        return: () => {
          self.close()
          return it.return()
        },
        [Symbol.asyncIterator]() {
          return this
        },
      }
    }
    [Symbol.dispose]() {
      this.close()
    }
  }
  const cb = (f?: Dyn) => (typeof f === 'function' ? f() : undefined)
  const readline: Dyn = {
    Interface,
    createInterface: (opts?: Dyn, output?: Dyn) => new Interface(opts, output),
    clearLine: (s?: Dyn, d?: Dyn, f?: Dyn) => (cb(f ?? d), true),
    clearScreenDown: (s?: Dyn, f?: Dyn) => (cb(f), true),
    cursorTo: (s?: Dyn, x?: Dyn, y?: Dyn, f?: Dyn) => (cb(typeof y === 'function' ? y : f), true),
    moveCursor: (s?: Dyn, x?: Dyn, y?: Dyn, f?: Dyn) => (cb(f), true),
    emitKeypressEvents: () => {},
  }
  readline.promises = {
    Interface,
    createInterface: (opts?: Dyn) => {
      const rl = new Interface(opts)
      const q = rl.question.bind(rl)
      rl.question = (query?: Dyn, o?: Dyn) => new Promise((resolve?: Dyn) => q(query, resolve))
      return rl
    },
  }
  return readline
}

