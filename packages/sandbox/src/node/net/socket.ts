// net.Socket, tls.connect and the listen-only Server stub.
//
// A socket leaves the machine in one of two ways, chosen per boot (kernel.netMode):
//   'tunnel'  a byte pipe through the app to a blind TCP relay. What the guest writes reaches the destination
//             verbatim. TLS must then run inside the machine: `tls.connect` uses kernel.connectTls when one is
//             installed and fails with ERR_TLS_NOT_AVAILABLE otherwise.
//   'http'    the socket never connects anywhere. It parses the HTTP/1.1 requests the guest writes, has the app
//             perform them (proxy plain mode), and feeds an HTTP/1.1 response back. Any HTTP client built on
//             net/tls (undici, for one) works unchanged; the proxy operator sees plaintext.
import type { ByteTransport, SocketChannel } from '../../kernel/net.js'
import { NetError } from '../../kernel/net.js'
import { host as platform } from '../../host.js'
import type { Dyn, ProcessCore } from '../types.js'
import { BufferPkg as Buffer } from '../vendor.js'
import { HttpBridge } from './http-bridge.js'

export interface NetStats {
  sockets: number
  tlsSockets: number
  bridgeRequests: number
  tunnelConnections: number
  bytesOut: number
  bytesIn: number
}

/** What a connected socket writes to. */
interface Transport {
  write(chunk: Uint8Array): void
  end(): void
  destroy(): void
}

interface Deps {
  core: ProcessCore
  stream: Dyn
  EventEmitter: Dyn
  stats: NetStats
}

const isIPv4 = (s: unknown): boolean => typeof s === 'string' && /^(\d{1,3}\.){3}\d{1,3}$/.test(s) && s.split('.').every((n) => Number(n) <= 255)
const isIPv6 = (s: unknown): boolean => typeof s === 'string' && s.includes(':') && /^[0-9a-fA-F:.]+$/.test(s)

/** Node-style connect error for a failed tunnel open. The proxy's reason code is kept in the message. */
function connectError(e: unknown, host: string, port: number): Error {
  const proxyCode = e instanceof NetError ? e.code : 'connect'
  const code = proxyCode === 'dns' ? 'ENOTFOUND' : proxyCode === 'timeout' ? 'ETIMEDOUT' : proxyCode === 'ENETUNREACH' ? 'ENETUNREACH' : 'ECONNREFUSED'
  const detail = e instanceof Error && proxyCode !== 'connect' ? ` (${proxyCode}: ${e.message})` : ''
  return Object.assign(new Error(code === 'ENOTFOUND' ? `getaddrinfo ENOTFOUND ${host}${detail}` : `connect ${code} ${host}:${port}${detail}`), {
    code,
    syscall: code === 'ENOTFOUND' ? 'getaddrinfo' : 'connect',
    address: host,
    hostname: host,
    port,
  })
}

export function createSockets({ core, stream, EventEmitter, stats }: Deps) {
  const { kernel, live, track } = core

  class Socket extends stream.Duplex {
    constructor(opts: Dyn = {}) {
      super({ allowHalfOpen: opts.allowHalfOpen ?? false, emitClose: true })
      this.connecting = false
      this.pending = true
      this.remoteAddress = undefined
      this.remotePort = undefined
      this.remoteFamily = 'IPv4'
      this.localAddress = '127.0.0.1'
      this.localPort = 0
      this.bytesRead = 0
      this.bytesWritten = 0
      this.timeout = 0
      this._secure = !!opts.__secure
      this._alpn = opts.ALPNProtocols
      this._servername = opts.servername
      this._refed = false
      this._wantRef = true
      this._transport = null as Transport | null
      this._timer = undefined
      this._pendingWrite = null as (() => void) | null
      this.encrypted = this._secure || undefined
      this.authorized = this._secure
      this.alpnProtocol = false
      stats.sockets++
    }
    _hold(): void {
      if (!this._refed && this._wantRef) {
        this._refed = true
        live.ref()
      }
    }
    _release(): void {
      if (this._refed) {
        this._refed = false
        live.unref()
      }
    }
    ref(): this {
      this._wantRef = true
      if (!this.destroyed && (this.connecting || !this.pending)) this._hold()
      return this
    }
    unref(): this {
      this._wantRef = false
      this._release()
      return this
    }

    connect(...args: Dyn[]): this {
      let opts: Dyn = {}
      let cb: Dyn
      if (typeof args[args.length - 1] === 'function') cb = args.pop()
      if (args[0] && typeof args[0] === 'object') opts = args[0]
      else if (typeof args[0] === 'string' && !/^\d+$/.test(args[0])) opts = { path: args[0] } // net.connect('/path/to.sock')
      else opts = { port: args[0], host: args[1] }
      if (opts.path) {
        track('net.connect(unix socket)', String(opts.path))
        queueMicrotask(() => this.destroy(Object.assign(new Error('connect ENOENT ' + opts.path), { code: 'ENOENT', syscall: 'connect' })))
        return this
      }
      const host: string = opts.host || opts.hostname || 'localhost'
      const port = Number(opts.port)
      this.remoteAddress = host
      this.remotePort = port
      this.connecting = true
      this._host = host
      if (cb) this.once(this._secure ? 'secureConnect' : 'connect', cb)
      this._hold()

      const connected = (transport: Transport): void => {
        if (this.destroyed) return transport.destroy()
        this._transport = transport
        this.connecting = false
        this.pending = false
        this.readyState = 'open'
        this.emit('connect')
        this.emit('ready')
        if (this._secure) this.emit('secureConnect')
        const flush = this._pendingWrite
        this._pendingWrite = null
        flush?.()
      }
      const receive = (chunk: Uint8Array): void => {
        if (this.destroyed) return
        this.bytesRead += chunk.length
        stats.bytesIn += chunk.length
        this._touch()
        this.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      }
      const remoteEnd = (): void => {
        if (this.destroyed) return
        this.push(null)
        this._release()
      }
      const failed = (error?: string): void => {
        if (this.destroyed) return
        if (error) this.destroy(Object.assign(new Error(`read ECONNRESET (${error})`), { code: 'ECONNRESET', syscall: 'read' }))
        else {
          this.push(null)
          this.destroy()
        }
      }

      const mode = kernel.netMode
      if (mode === 'http') {
        const bridge = new HttpBridge({
          scheme: this._secure ? 'https' : 'http',
          host,
          port,
          broker: kernel.net,
          stats,
          push: receive,
          fail: (message) => this.destroy(Object.assign(new Error(message), { code: 'ECONNRESET' })),
        })
        queueMicrotask(() => connected({ write: (c) => bridge.write(c), end() {}, destroy: () => bridge.destroy() }))
      } else if (mode === 'tunnel') {
        if (this._secure && !kernel.connectTls) {
          track('tls.connect in tunnel mode (no TLS in the machine yet)', `${host}:${port}`)
          queueMicrotask(() => this.destroy(Object.assign(new Error(`TLS is not available in the machine yet: cannot connect to ${host}:${port} through the tunnel`), { code: 'ERR_TLS_NOT_AVAILABLE' })))
          return this
        }
        stats.tunnelConnections++
        if (this._secure) this._connectTls(host, port, connected, receive, remoteEnd, failed)
        else {
          const channel = kernel.net.openSocket(host, port, { data: receive, end: remoteEnd, close: failed })
          channel.opened.then(
            () => connected({ write: (c) => channel.write(c), end: () => channel.end(), destroy: () => channel.close() }),
            (e) => !this.destroyed && this.destroy(connectError(e, host, port)),
          )
        }
      } else {
        track('net.connect with networking disabled', `${host}:${port}`)
        queueMicrotask(() => this.destroy(connectError(new NetError('ENETUNREACH', 'networking is disabled'), host, port)))
      }
      return this
    }

    /** TLS over a tunnel socket, through the connector the kernel was given (see TlsConnector in kernel/net.ts). */
    _connectTls(host: string, port: number, connected: (t: Transport) => void, receive: (c: Uint8Array) => void, remoteEnd: () => void, failed: (e?: string) => void): void {
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const readable = new platform.ReadableStream<Uint8Array>({ start: (c) => void (controller = c) })
      const quiet = (fn: () => void): void => {
        try {
          fn()
        } catch {
          // the stream was already closed or errored by the other path
        }
      }
      const channel: SocketChannel = kernel.net.openSocket(host, port, {
        data: (chunk) => quiet(() => controller.enqueue(chunk)),
        end: () => quiet(() => controller.close()),
        close: (error) => quiet(() => (error ? controller.error(new Error(error)) : controller.close())),
      })
      const transport: ByteTransport = { readable, write: (b) => channel.write(b), end: () => channel.end(), close: () => channel.close() }
      channel.opened
        .then(() => kernel.connectTls!(transport, { serverName: this._servername || host, alpn: this._alpn }))
        .then(async (secure) => {
          this.alpnProtocol = secure.alpn ?? false
          this._tlsInfo = secure
          connected({ write: (c) => void secure.write(c).catch((e: Error) => failed(e.message)), end: () => void secure.end().catch(() => {}), destroy: () => secure.close() })
          const reader = secure.readable.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) return remoteEnd()
            receive(value)
          }
        })
        .catch((e: Error & { code?: string }) => {
          channel.close()
          if (this.destroyed) return
          this.destroy(e instanceof NetError ? connectError(e, host, port) : Object.assign(new Error(`TLS connection to ${host}:${port} failed: ${e.message}`), { code: 'ERR_TLS_HANDSHAKE', cause: e }))
        })
    }

    _touch(): void {
      if (!this.timeout) return
      clearTimeout(this._timer)
      this._timer = setTimeout(() => this.emit('timeout'), this.timeout)
    }
    _read(): void {}
    _write(chunk: Dyn, encoding: string, cb: (e?: unknown) => void): void {
      const doWrite = (): void => {
        const b: Uint8Array = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk
        this.bytesWritten += b.length
        stats.bytesOut += b.length
        this._touch()
        try {
          // Copy: the guest may reuse its buffer, and the bytes are about to be transferred to another thread.
          this._transport?.write(b.slice())
          cb()
        } catch (e) {
          cb(e)
        }
      }
      if (this.connecting) this._pendingWrite = doWrite
      else doWrite()
    }
    _final(cb: () => void): void {
      this._transport?.end()
      cb()
    }
    _destroy(err: unknown, cb: (e: unknown) => void): void {
      clearTimeout(this._timer)
      this._transport?.destroy()
      this._transport = null
      this._release()
      this._hadError = !!err
      cb(err)
    }
    emit(event: string | symbol, ...args: Dyn[]): boolean {
      // Node's sockets pass hadError to 'close' listeners; the stream base class emits it bare.
      if (event === 'close' && args.length === 0) return super.emit('close', !!this._hadError)
      return super.emit(event, ...args)
    }
    setTimeout(ms: number, cb?: () => void): this {
      this.timeout = ms
      clearTimeout(this._timer)
      if (ms) {
        this._touch()
        if (cb) this.once('timeout', cb)
      }
      return this
    }
    setNoDelay(): this { return this }
    setKeepAlive(): this { return this }
    address(): object { return { address: this.localAddress, family: 'IPv4', port: this.localPort } }
    // TLSSocket surface. Certificate details are not exposed by the connector interface.
    getPeerCertificate(): object { return {} }
    getProtocol(): string { return this._tlsInfo?.protocolVersion ?? 'TLSv1.3' }
    getCipher(): object { return { name: this._tlsInfo?.cipherSuite ?? 'TLS_AES_128_GCM_SHA256', version: this.getProtocol() } }
    getSession(): undefined { return undefined }
    isSessionReused(): boolean { return false }
    setSession(): void {}
    getPeerX509Certificate(): undefined { return undefined }
    setServername(name: string): void { this._servername = name }
    exportKeyingMaterial(): Dyn { return Buffer.alloc(0) }
    enableTrace(): void {}
    disableRenegotiation(): void {}
    setMaxSendFragment(): boolean { return true }
  }

  /** Servers can be created and "listen", but nothing can connect to them: the machine has no inbound network. */
  class Server extends EventEmitter {
    constructor(opts?: Dyn, handler?: Dyn) {
      super()
      if (typeof opts === 'function') handler = opts
      if (handler) this.on('connection', handler)
      this.listening = false
    }
    listen(...args: Dyn[]): this {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null
      const o = args[0] && typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] }
      this._port = o.port || 49152 + Math.floor(Math.random() * 1000)
      track('net/http Server.listen (accepted, but nothing can connect)', String(o.port ?? o.path ?? 0))
      this.listening = true
      queueMicrotask(() => {
        this.emit('listening')
        cb?.()
      })
      return this
    }
    address(): object | null { return this.listening ? { address: '127.0.0.1', family: 'IPv4', port: this._port } : null }
    close(cb?: () => void): this {
      this.listening = false
      queueMicrotask(() => {
        this.emit('close')
        cb?.()
      })
      return this
    }
    ref(): this { return this }
    unref(): this { return this }
    closeAllConnections(): void {}
    closeIdleConnections(): void {}
    setTimeout(): this { return this }
    getConnections(cb: (e: null, n: number) => void): void { cb(null, 0) }
    [Symbol.asyncDispose](): Promise<void> { return new Promise((r) => this.close(r)) }
  }

  const connect = (...args: Dyn[]): Dyn => new Socket(args[0] && typeof args[0] === 'object' ? args[0] : {}).connect(...args)
  const net = {
    Socket,
    Stream: Socket,
    Server,
    connect,
    createConnection: connect,
    createServer: (o?: Dyn, h?: Dyn) => new Server(o, h),
    isIP: (s: unknown) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0),
    isIPv4,
    isIPv6,
    getDefaultAutoSelectFamily: () => false,
    setDefaultAutoSelectFamily: () => {},
    getDefaultAutoSelectFamilyAttemptTimeout: () => 250,
    setDefaultAutoSelectFamilyAttemptTimeout: () => {},
    BlockList: class BlockList {
      addAddress(): void {}
      addRange(): void {}
      addSubnet(): void {}
      check(): boolean { return false }
    },
    SocketAddress: class SocketAddress {
      constructor(o: object = {}) {
        Object.assign(this, { address: '127.0.0.1', port: 0, family: 'ipv4' }, o)
      }
    },
  }

  const tls = {
    TLSSocket: Socket,
    connect: (...args: Dyn[]): Dyn => {
      let opts: Dyn
      let cb: Dyn
      if (typeof args[args.length - 1] === 'function') cb = args.pop()
      if (args[0] && typeof args[0] === 'object') opts = args[0]
      else opts = { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined, ...(typeof args[1] === 'object' ? args[1] : args[2]) }
      stats.tlsSockets++
      const s = new Socket({ ...opts, __secure: true })
      // `socket` is an existing connection to upgrade. Its bytes cannot be re-used here, so its destination is.
      const host = opts.host || opts.servername || (opts.socket && opts.socket._host)
      const port = opts.port || (opts.socket && opts.socket.remotePort) || 443
      return s.connect({ host, port }, cb)
    },
    createSecureContext: () => ({ context: {} }),
    rootCertificates: [],
    getCACertificates: () => [],
    setDefaultCACertificates: () => {},
    DEFAULT_MIN_VERSION: 'TLSv1.2',
    DEFAULT_MAX_VERSION: 'TLSv1.3',
    DEFAULT_ECDH_CURVE: 'auto',
    DEFAULT_CIPHERS: 'TLS_AES_256_GCM_SHA384',
    checkServerIdentity: () => undefined,
    createServer: (o?: Dyn, h?: Dyn) => new Server(o, h),
    Server,
    getCiphers: () => [],
    SecureContext: class SecureContext {},
  }
  return { net, tls, Server }
}
