// node:http and node:https, client side. A request is buffered and performed as one exchange (see fetch.ts);
// the response body streams. Servers exist only as listen-only stubs.
import type { Dyn, ProcessCore } from '../types.js'
import { BufferPkg as Buffer } from '../vendor.js'
import type { TransportFetch } from './fetch.js'
import { STATUS_TEXT } from './http1.js'

interface Deps {
  core: ProcessCore
  stream: Dyn
  EventEmitter: Dyn
  net: Dyn
  Server: Dyn
  transportFetch: TransportFetch
}

export function createHttp({ core, stream, EventEmitter, net, Server, transportFetch }: Deps): { http: Dyn; https: Dyn } {
  const { live, track } = core
  const STATUS_CODES: Record<number, string> = STATUS_TEXT
  class Agent extends EventEmitter {
    constructor(opts: Dyn = {}) {
      super()
      this.options = opts
      this.maxSockets = opts.maxSockets ?? Infinity
      this.sockets = {}
      this.requests = {}
      this.freeSockets = {}
      this.keepAlive = !!opts.keepAlive
    }
    destroy() {}
    createConnection(o?: Dyn, cb?: Dyn) {
      return net.connect(o, cb)
    }
    getName() {
      return 'agent'
    }
  }
  class IncomingMessage extends stream.Readable {
    constructor() {
      super({
        read() {
          this._pull && this._pull()
        },
      })
      this.headers = {}
      this.rawHeaders = []
      this.trailers = {}
      this.httpVersion = '1.1'
      this.httpVersionMajor = 1
      this.httpVersionMinor = 1
      this.complete = false
      this.aborted = false
    }
    setTimeout(ms?: Dyn, cb?: Dyn) {
      return this
    }
  }
  class ClientRequest extends stream.Writable {
    constructor(defaultProtocol?: Dyn, args?: Dyn) {
      super()
      let opts: Dyn = {}
      let cb: Dyn
      if (typeof args[args.length - 1] === 'function') cb = args.pop()
      for (const a of args) {
        if (typeof a === 'string' || a instanceof URL) {
          const u = new URL(a)
          opts = {
            ...opts,
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port,
            path: u.pathname + u.search,
            auth: u.username ? decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password) : undefined,
          }
        } else if (a && typeof a === 'object') opts = { ...opts, ...a }
      }
      const protocol = opts.protocol || defaultProtocol
      const hostName = opts.hostname || opts.host || 'localhost'
      this.method = (opts.method || 'GET').toUpperCase()
      this.path = opts.path || '/'
      this.host = hostName
      this.protocol = protocol
      this._url = `${protocol}//${hostName.includes(':') && !hostName.startsWith('[') ? `[${hostName}]` : hostName}${opts.port ? ':' + opts.port : ''}${this.path}`
      this._headers = new Map()
      this._chunks = []
      this._controller = new AbortController()
      this.aborted = false
      this.reusedSocket = false
      this.finished = false
      for (const [k, v] of Object.entries(opts.headers || {})) this.setHeader(k, v)
      if (opts.auth && !this.hasHeader('authorization')) this.setHeader('authorization', 'Basic ' + Buffer.from(opts.auth).toString('base64'))
      if (opts.signal)
        opts.signal.addEventListener(
          'abort',
          () => this.destroy(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })),
          { once: true },
        )
      if (opts.timeout) this.setTimeout(opts.timeout)
      if (cb) this.once('response', cb)
      const sock = new EventEmitter()
      Object.assign(sock, {
        setTimeout() {
          return sock
        },
        setNoDelay() {
          return sock
        },
        setKeepAlive() {
          return sock
        },
        ref() {
          return sock
        },
        unref() {
          return sock
        },
        destroy() {},
        end() {},
        remoteAddress: hostName,
        remotePort: Number(opts.port) || (protocol === 'https:' ? 443 : 80),
        encrypted: protocol === 'https:',
        authorized: true,
        writable: true,
        readable: true,
        connecting: false,
        destroyed: false,
      })
      this.socket = this.connection = sock
      queueMicrotask(() => this.emit('socket', sock))
      track('http.request', this.method + ' ' + protocol + '//' + hostName)
    }
    setHeader(k?: Dyn, v?: Dyn) {
      this._headers.set(String(k).toLowerCase(), [k, v])
      return this
    }
    getHeader(k?: Dyn) {
      const h = this._headers.get(String(k).toLowerCase())
      return h && h[1]
    }
    hasHeader(k?: Dyn) {
      return this._headers.has(String(k).toLowerCase())
    }
    removeHeader(k?: Dyn) {
      this._headers.delete(String(k).toLowerCase())
    }
    getHeaders() {
      return Object.fromEntries([...this._headers].map(([k, [, v]]: Dyn) => [k, v]))
    }
    getHeaderNames() {
      return [...this._headers.keys()]
    }
    getRawHeaderNames() {
      return [...this._headers.values()].map(([k]: Dyn) => k)
    }
    flushHeaders() {}
    setNoDelay() {}
    setSocketKeepAlive() {}
    setTimeout(ms?: Dyn, cb?: Dyn) {
      if (cb) this.once('timeout', cb)
      clearTimeout(this._timer)
      if (ms) this._timer = setTimeout(() => this.emit('timeout'), ms)
      return this
    }
    abort() {
      this.aborted = true
      this.destroy()
    }
    _write(chunk?: Dyn, enc?: Dyn, cb?: Dyn) {
      this._chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, enc) : chunk)
      cb()
    }
    _final(cb?: Dyn) {
      this.finished = true
      cb()
      const headers: [string, string][] = []
      for (const [, [k, v]] of this._headers) for (const one of [].concat(v)) headers.push([k, String(one)])
      live.ref()
      let released = false
      const release = () => {
        if (!released) {
          released = true
          live.unref()
          clearTimeout(this._timer)
        }
      }
      transportFetch(this._url, {
        method: this.method,
        headers,
        body: this._chunks.length ? Buffer.concat(this._chunks) : undefined,
        signal: this._controller.signal,
      }).then(
        (res?: Dyn) => {
          const msg = new IncomingMessage()
          msg.statusCode = res.status
          msg.statusMessage = res.statusText || STATUS_CODES[res.status] || ''
          msg.socket = msg.connection = this.socket
          msg.req = this
          this.res = msg
          for (const [k, v] of res.headers) {
            if (k === 'content-encoding') continue
            msg.rawHeaders.push(k, v)
            if (k === 'set-cookie') (msg.headers[k] ||= []).push(v)
            else msg.headers[k] = k in msg.headers ? msg.headers[k] + ', ' + v : v
          }
          const reader = res.body ? res.body.getReader() : null
          let reading = false
          msg._pull = () => {
            if (reading) return
            reading = true
            if (!reader) {
              msg.complete = true
              msg.push(null)
              release()
              return
            }
            reader.read().then(
              ({ done, value }: Dyn) => {
                reading = false
                if (done) {
                  msg.complete = true
                  msg.push(null)
                  release()
                } else if (msg.push(Buffer.from(value))) msg._pull()
              },
              (e?: Dyn) => {
                release()
                msg.destroy(e)
              },
            )
          }
          msg.on('close', () => {
            release()
            if (reader && !msg.complete) reader.cancel().catch(() => {})
          })
          this.emit('response', msg)
          if (this.listenerCount('response') === 0) msg.resume()
        },
        (e?: Dyn) => {
          release()
          if (!this.destroyed) {
            const err =
              e && e.name === 'AbortError'
                ? Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
                : Object.assign(new Error((e && e.message) || 'request failed'), { code: (e && e.code) || 'ECONNREFUSED', cause: e })
            this.emit('error', err)
            this.emit('close')
          }
        },
      )
    }
    _destroy(err?: Dyn, cb?: Dyn) {
      this._controller.abort()
      clearTimeout(this._timer)
      cb(err)
    }
  }
  const mkHttp = (protocol?: Dyn) => {
    const mod: Dyn = {
      request: (...args: Dyn[]) => new ClientRequest(protocol, args),
      get: (...args: Dyn[]) => {
        const r = new ClientRequest(protocol, args)
        r.end()
        return r
      },
      Agent,
      globalAgent: new Agent(),
      ClientRequest,
      IncomingMessage,
      STATUS_CODES,
      METHODS: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
      Server: class HttpServer extends Server {
        constructor(o?: Dyn, h?: Dyn) {
          super(o, undefined)
          if (typeof o === 'function') h = o
          if (h) this.on('request', h)
        }
      },
      ServerResponse: class ServerResponse extends stream.Writable {},
      OutgoingMessage: class OutgoingMessage extends stream.Writable {},
      maxHeaderSize: 16384,
      validateHeaderName() {},
      validateHeaderValue() {},
      setMaxIdleHTTPParsers() {},
    }
    mod.createServer = (o?: Dyn, h?: Dyn) => new mod.Server(o, h)
    return mod
  }
  return { http: mkHttp('http:'), https: mkHttp('https:') }
}
