// The remaining built-ins: url, timers, console, vm, v8, perf_hooks, worker_threads, dns, and stubs.
import { punycodePkg, querystringPkg, StringDecoderPkg as StringDecoder, urlPkg } from '../vendor.js'
import type { Dyn, Track } from '../types.js'
import { notImplemented, TrackedReadableStream } from './core.js'

export function makeMisc({ Buffer, EventEmitter, stream, util, process, track, host, evaluate, timers }: Dyn) {
  const ni = (name?: Dyn) => notImplemented(track, name)
  const url = {
    ...urlPkg,
    URL,
    URLSearchParams,
    fileURLToPath: (u?: Dyn) => {
      const x = typeof u === 'string' ? new URL(u) : u
      if (x.protocol !== 'file:') {
        const e: Dyn = new TypeError('The URL must be of scheme file')
        e.code = 'ERR_INVALID_URL_SCHEME'
        throw e
      }
      return decodeURIComponent(x.pathname)
    },
    pathToFileURL: (p?: Dyn) => new URL('file://' + encodeURI(p.startsWith('/') ? p : process.cwd() + '/' + p).replace(/[?#]/g, encodeURIComponent)),
    urlToHttpOptions: (u?: Dyn) => ({
      protocol: u.protocol,
      hostname: u.hostname.replace(/^\[|\]$/g, ''),
      hash: u.hash,
      search: u.search,
      pathname: u.pathname,
      path: u.pathname + u.search,
      href: u.href,
      port: u.port ? Number(u.port) : undefined,
      auth: u.username ? decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password) : undefined,
    }),
    domainToASCII: (d?: Dyn) => {
      try {
        return new URL('http://' + d).hostname
      } catch {
        return ''
      }
    },
    domainToUnicode: (d?: Dyn) => d,
  }
  const timersPromises = {
    setTimeout: (ms?: Dyn, value?: Dyn, opts: Dyn = {}) =>
      new Promise((resolve?: Dyn, reject?: Dyn) => {
        if (opts.signal && opts.signal.aborted) {
          const e: Dyn = new Error('The operation was aborted')
          e.name = 'AbortError'
          e.code = 'ABORT_ERR'
          return reject(e)
        }
        const t = timers.setTimeout(() => resolve(value), ms)
        if (opts.ref === false) t.unref()
        if (opts.signal)
          opts.signal.addEventListener(
            'abort',
            () => {
              timers.clearTimeout(t)
              const e: Dyn = new Error('The operation was aborted')
              e.name = 'AbortError'
              e.code = 'ABORT_ERR'
              reject(e)
            },
            { once: true },
          )
      }),
    setImmediate: (value?: Dyn) => new Promise((resolve?: Dyn) => timers.setImmediate(() => resolve(value))),
    setInterval: async function* (ms?: Dyn, value?: Dyn) {
      for (;;) {
        await timersPromises.setTimeout(ms)
        yield value
      }
    },
    scheduler: { wait: (ms?: Dyn, o?: Dyn) => timersPromises.setTimeout(ms, undefined, o), yield: () => timersPromises.setImmediate() },
  }
  const channel = (name?: Dyn) => ({
    name,
    hasSubscribers: false,
    publish() {},
    subscribe() {},
    unsubscribe() {
      return false
    },
    bindStore() {},
    unbindStore() {},
    runStores(ctx?: Dyn, fn?: Dyn, thisArg?: Dyn, ...args: Dyn[]) {
      return fn.apply(thisArg, args)
    },
  })
  const tracing = (name?: Dyn) => {
    const tc = {
      start: channel(),
      end: channel(),
      asyncStart: channel(),
      asyncEnd: channel(),
      error: channel(),
      hasSubscribers: false,
      subscribe() {},
      unsubscribe() {},
      traceSync: (fn?: Dyn, ctx?: Dyn, thisArg?: Dyn, ...args: Dyn[]) => fn.apply(thisArg, args),
      tracePromise: (fn?: Dyn, ctx?: Dyn, thisArg?: Dyn, ...args: Dyn[]) => fn.apply(thisArg, args),
      traceCallback: (fn?: Dyn, pos?: Dyn, ctx?: Dyn, thisArg?: Dyn, ...args: Dyn[]) => fn.apply(thisArg, args),
    }
    return tc
  }
  for (const [k, v] of Object.entries({
    markResourceTiming: () => {},
    eventLoopUtilization: () => ({ idle: 0, active: 0, utilization: 0 }),
    timerify: (f?: Dyn) => f,
    nodeTiming: {
      name: 'node',
      entryType: 'node',
      startTime: 0,
      duration: 0,
      nodeStart: 0,
      v8Start: 0,
      bootstrapComplete: 0,
      environment: 0,
      loopStart: 0,
      loopExit: -1,
      idleTime: 0,
    },
  })) {
    try {
      if (!(k in host.performance)) host.performance[k] = v
    } catch {}
  }
  const mem = () => host.performance.memory || { usedJSHeapSize: 0, totalJSHeapSize: 0, jsHeapSizeLimit: 2 ** 31 }
  class Console {
    [field: string]: Dyn // shaped like Node's class of the same name; fields are assigned in the constructor
    constructor(stdout?: Dyn, stderr?: Dyn) {
      if (stdout && !stdout.write && stdout.stdout) ({ stdout, stderr } = stdout)
      this._stdout = stdout
      this._stderr = stderr || stdout
      this._counts = {}
      this._timers = {}
      this._indent = ''
      for (const k of [
        'log',
        'info',
        'debug',
        'error',
        'warn',
        'trace',
        'dir',
        'table',
        'group',
        'groupEnd',
        'groupCollapsed',
        'time',
        'timeEnd',
        'timeLog',
        'count',
        'countReset',
        'assert',
        'clear',
        'dirxml',
      ])
        this[k] = this[k].bind(this)
    }
    _w(s?: Dyn, text?: Dyn) {
      s.write(this._indent + text.replace(/\n/g, '\n' + this._indent) + '\n')
    }
    log(...a: Dyn[]) {
      this._w(this._stdout, util.format(...a))
    }
    info(...a: Dyn[]) {
      this.log(...a)
    }
    debug(...a: Dyn[]) {
      this.log(...a)
    }
    dirxml(...a: Dyn[]) {
      this.log(...a)
    }
    error(...a: Dyn[]) {
      this._w(this._stderr, util.format(...a))
    }
    warn(...a: Dyn[]) {
      this.error(...a)
    }
    trace(...a: Dyn[]) {
      this.error('Trace: ' + util.format(...a) + '\n' + (new Error().stack || '').split('\n').slice(2).join('\n'))
    }
    dir(o?: Dyn, opts?: Dyn) {
      this._w(this._stdout, util.inspect(o, opts))
    }
    table(d?: Dyn) {
      this.log(util.inspect(d))
    }
    group(...a: Dyn[]) {
      if (a.length) this.log(...a)
      this._indent += '  '
    }
    groupCollapsed(...a: Dyn[]) {
      this.group(...a)
    }
    groupEnd() {
      this._indent = this._indent.slice(2)
    }
    time(l: Dyn = 'default') {
      this._timers[l] = host.performance.now()
    }
    timeEnd(l: Dyn = 'default') {
      this.timeLog(l)
      delete this._timers[l]
    }
    timeLog(l: Dyn = 'default', ...a: Dyn[]) {
      this.log(`${l}: ${(host.performance.now() - (this._timers[l] ?? host.performance.now())).toFixed(3)}ms`, ...a)
    }
    count(l: Dyn = 'default') {
      this.log(`${l}: ${(this._counts[l] = (this._counts[l] || 0) + 1)}`)
    }
    countReset(l: Dyn = 'default') {
      delete this._counts[l]
    }
    assert(c?: Dyn, ...a: Dyn[]) {
      if (!c) this.error('Assertion failed' + (a.length ? ': ' + util.format(...a) : ''))
    }
    clear() {}
  }
  const nodeConsole = new Console(process.stdout, process.stderr)
  nodeConsole.Console = Console
  class Script {
    [field: string]: Dyn // shaped like Node's class of the same name; fields are assigned in the constructor
    constructor(code?: Dyn, opts?: Dyn) {
      this.code = code
      this.filename = (opts && opts.filename) || 'evalmachine.<anonymous>'
    }
    runInThisContext() {
      track('vm.Script.runInThisContext')
      return evaluate(this.code, this.filename)
    }
    runInContext(ctx?: Dyn) {
      return vm.runInContext(this.code, ctx)
    }
    runInNewContext(ctx?: Dyn) {
      return vm.runInContext(this.code, ctx || {})
    }
    createCachedData() {
      return Buffer.alloc(0)
    }
  }
  const vm = {
    Script,
    isContext: (o?: Dyn) => !!(o && o.__vmContext),
    createContext: (o: Dyn = {}) => {
      Object.defineProperty(o, '__vmContext', { value: true, enumerable: false })
      return o
    },
    runInThisContext: (code?: Dyn, opts?: Dyn) => {
      track('vm.runInThisContext')
      return evaluate(String(code), (opts && opts.filename) || 'vm')
    },
    runInContext: (code?: Dyn, ctx?: Dyn) => {
      track('vm.runInContext')
      return evaluate(`(function (__ctx) { with (__ctx) { return eval(${JSON.stringify(String(code))}); } })`, 'vm.runInContext')(ctx)
    },
    runInNewContext: (code?: Dyn, ctx?: Dyn) => vm.runInContext(code, ctx || {}),
    compileFunction: (code?: Dyn, params: Dyn = []) => {
      track('vm.compileFunction')
      return evaluate(`(function (${params.join(',')}) {${code}\n})`, 'vm.compileFunction')
    },
    constants: { USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol('USE_MAIN_CONTEXT_DEFAULT_LOADER'), DONT_CONTEXTIFY: Symbol('DONT_CONTEXTIFY') },
    SourceTextModule: class {
      constructor() {
        ni('vm.SourceTextModule')()
      }
    },
    SyntheticModule: class {
      constructor() {
        ni('vm.SyntheticModule')()
      }
    },
  }
  class Worker extends EventEmitter {
    constructor(file?: Dyn) {
      super()
      track('worker_threads.Worker', String(file))
      ni('worker_threads.Worker')()
    }
  }
  const dnsLookup = (host_?: Dyn, opts?: Dyn, cb?: Dyn) => {
    if (typeof opts === 'function') {
      cb = opts
      opts = {}
    }
    track('dns.lookup', host_)
    const ip = /^[\d.]+$/.test(host_) ? host_ : host_ === 'localhost' ? '127.0.0.1' : '203.0.113.1'
    queueMicrotask(() => (opts && opts.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)))
  }
  const dns = {
    lookup: dnsLookup,
    resolve: (h?: Dyn, t?: Dyn, cb?: Dyn) => {
      cb = typeof t === 'function' ? t : cb
      queueMicrotask(() => cb(Object.assign(new Error('queryA ENOTFOUND ' + h), { code: 'ENOTFOUND' })))
    },
    resolve4: (h?: Dyn, cb?: Dyn) => dns.resolve(h, cb),
    resolve6: (h?: Dyn, cb?: Dyn) => dns.resolve(h, cb),
    setDefaultResultOrder() {},
    getDefaultResultOrder: () => 'verbatim',
    setServers() {},
    getServers: () => [],
    ADDRCONFIG: 1024,
    V4MAPPED: 2048,
    ALL: 256,
    promises: {
      lookup: (h?: Dyn, o?: Dyn) =>
        new Promise((res?: Dyn, rej?: Dyn) =>
          dnsLookup(h, o || {}, (e?: Dyn, a?: Dyn, f?: Dyn) => (e ? rej(e) : res(o && o.all ? a : { address: a, family: f }))),
        ),
      resolve: async () => {
        throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
      },
      Resolver: class {},
    },
    Resolver: class {},
  }
  return {
    url,
    querystring: querystringPkg,
    punycode: punycodePkg,
    string_decoder: { StringDecoder },
    timers: { ...timers, promises: timersPromises },
    'timers/promises': timersPromises,
    console: nodeConsole,
    diagnostics_channel: {
      channel,
      hasSubscribers: () => false,
      subscribe() {},
      unsubscribe() {
        return false
      },
      tracingChannel: tracing,
      Channel: class Channel {},
    },
    perf_hooks: {
      performance: host.performance,
      PerformanceObserver:
        host.PerformanceObserver ||
        class {
          observe() {}
          disconnect() {}
        },
      PerformanceEntry: host.PerformanceEntry,
      monitorEventLoopDelay: () => ({
        enable() {},
        disable() {},
        reset() {},
        min: 0,
        max: 0,
        mean: 0,
        stddev: 0,
        percentile: () => 0,
        percentiles: new Map(),
      }),
      constants: {},
      createHistogram: () => ({ record() {}, percentile: () => 0, min: 0, max: 0, mean: 0 }),
    },
    v8: {
      getHeapStatistics: () => ({
        total_heap_size: mem().totalJSHeapSize,
        used_heap_size: mem().usedJSHeapSize,
        heap_size_limit: mem().jsHeapSizeLimit,
        total_available_size: mem().jsHeapSizeLimit - mem().usedJSHeapSize,
        total_physical_size: mem().totalJSHeapSize,
        malloced_memory: 0,
        external_memory: 0,
        number_of_native_contexts: 1,
        number_of_detached_contexts: 0,
      }),
      getHeapSpaceStatistics: () => [],
      getHeapSnapshot: ni('v8.getHeapSnapshot'),
      writeHeapSnapshot: ni('v8.writeHeapSnapshot'),
      setFlagsFromString: () => {},
      cachedDataVersionTag: () => 0,
      serialize: ni('v8.serialize'),
      deserialize: ni('v8.deserialize'),
      isStringOneByteRepresentation: (s?: Dyn) => !/[^\u0000-ÿ]/.test(s),
      startupSnapshot: { isBuildingSnapshot: () => false },
      setHeapSnapshotNearHeapLimit: () => {},
      getCppHeapStatistics: () => ({}),
    },
    vm,
    worker_threads: {
      isMainThread: true,
      parentPort: null,
      workerData: null,
      threadId: 0,
      resourceLimits: {},
      Worker,
      MessageChannel: host.MessageChannel,
      MessagePort: host.MessagePort,
      BroadcastChannel: host.BroadcastChannel,
      markAsUncloneable: () => {},
      markAsUntransferable: () => {},
      isMarkedAsUntransferable: () => false,
      receiveMessageOnPort: () => undefined,
      setEnvironmentData: () => {},
      getEnvironmentData: () => undefined,
      SHARE_ENV: Symbol('SHARE_ENV'),
    },
    dns,
    'dns/promises': dns.promises,
    inspector: {
      url: () => undefined,
      open: () => {},
      close: () => {},
      waitForDebugger: () => {},
      console: host.console,
      Session: class Session extends EventEmitter {
        connect() {}
        disconnect() {}
        post(m?: Dyn, p?: Dyn, cb?: Dyn) {
          const f = typeof p === 'function' ? p : cb
          f && queueMicrotask(() => f(new Error('inspector not available')))
        }
      },
    },
    http2: {
      constants: {
        HTTP2_HEADER_STATUS: ':status',
        HTTP2_HEADER_METHOD: ':method',
        HTTP2_HEADER_PATH: ':path',
        HTTP2_HEADER_AUTHORITY: ':authority',
        HTTP2_HEADER_SCHEME: ':scheme',
        HTTP2_HEADER_CONTENT_LENGTH: 'content-length',
        HTTP2_HEADER_CONTENT_TYPE: 'content-type',
        HTTP2_HEADER_EXPECT: 'expect',
        NGHTTP2_CANCEL: 8,
        NGHTTP2_NO_ERROR: 0,
      },
      connect: ni('http2.connect'),
      createServer: ni('http2.createServer'),
      createSecureServer: ni('http2.createSecureServer'),
      getDefaultSettings: () => ({}),
      sensitiveHeaders: Symbol('nodejs.http2.sensitiveHeaders'),
    },
    cluster: { isPrimary: true, isMaster: true, isWorker: false, workers: {}, fork: ni('cluster.fork'), on() {} },
    dgram: { createSocket: ni('dgram.createSocket') },
    domain: {
      create: () => {
        track('domain.create')
        const d = new EventEmitter()
        d.run = (fn?: Dyn) => fn()
        d.add = () => {}
        d.remove = () => {}
        d.bind = (f?: Dyn) => f
        d.intercept = (f?: Dyn) => f
        d.enter = () => {}
        d.exit = () => {}
        return d
      },
    },
    repl: { start: ni('repl.start') },
    trace_events: { createTracing: () => ({ enable() {}, disable() {}, enabled: false }), getEnabledCategories: () => undefined },
    wasi: {
      WASI: class WASI {
        constructor() {
          ni('wasi.WASI')()
        }
      },
    },
    'stream/consumers': (() => {
      const collect = async (s?: Dyn) => {
        const chunks = []
        for await (const c of s)
          chunks.push(typeof c === 'string' ? Buffer.from(c) : Buffer.from(c.buffer ? new Uint8Array(c.buffer, c.byteOffset, c.byteLength) : c))
        return Buffer.concat(chunks)
      }
      return {
        buffer: collect,
        text: async (s?: Dyn) => (await collect(s)).toString('utf8'),
        json: async (s?: Dyn) => JSON.parse((await collect(s)).toString('utf8')),
        arrayBuffer: async (s?: Dyn) => {
          const b = await collect(s)
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
        },
        blob: async (s?: Dyn) => new Blob([await collect(s)]),
      }
    })(),
    'stream/web': {
      ReadableStream: TrackedReadableStream,
      WritableStream,
      TransformStream,
      ReadableStreamDefaultReader,
      WritableStreamDefaultWriter,
      ByteLengthQueuingStrategy,
      CountQueuingStrategy,
      TextEncoderStream,
      TextDecoderStream,
      CompressionStream,
      DecompressionStream,
      ReadableByteStreamController: globalThis.ReadableByteStreamController,
      ReadableStreamBYOBReader: globalThis.ReadableStreamBYOBReader,
      ReadableStreamDefaultController: globalThis.ReadableStreamDefaultController,
    },
  }
}

