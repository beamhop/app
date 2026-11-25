// Beamhop proxy for Node: one HTTP server carrying /v1/tcp (WebSocket tunnel), /v1/http (plain
// mode) and /v1/health. Protocol in PROTOCOL.md; policy, limits and encoding in core.ts.
import dns from 'node:dns'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import {
  CLOSE_GOING_AWAY, CLOSE_IDLE, CLOSE_LIMIT, CLOSE_NORMAL, CLOSE_PROTOCOL, CLOSE_REFUSED, CLOSE_UPSTREAM,
  END_FRAME, HEADER_ERROR, HEADER_RESP_HEADERS, HEADER_STATUS, Limiter, OK_FRAME, ProxyError, SUBPROTOCOL, WS_HIGH_WATER,
  authorize, checkHostPort, corsHeaders, encodeHeaders, errorBody, failFrame, filterResponseHeaders, healthBody,
  ipVersion, isEndFrame, parsePlainRequest, parseSubprotocols, parseTunnelRequest, preflightHeaders,
  resolveDestination, toProxyError,
  type HeaderPairs, type Lookup, type ProxyConfig,
} from './core'

export interface ConnectionLog {
  mode: 'tcp' | 'http'
  host: string
  port: number
  /** Bytes from the client to the target, and back. */
  up: number
  down: number
  ms: number
  /** Failure code, if the connection was refused or failed. */
  error?: string
}

export interface ProxyOptions {
  /** Name resolution. Default: the system resolver (`dns.lookup`, all addresses). */
  lookup?: Lookup
  /** Clock for the per-minute byte limit. */
  now?: () => number
  /** Extra certificate authorities (PEM) trusted for plain-mode HTTPS targets, besides Node's roots. */
  ca?: string[]
  /** Called once per finished tunnel or plain request. Never receives tokens, paths or content. */
  log?: (entry: ConnectionLog) => void
}

export interface ProxyStats {
  /** Open tunnels, and plain requests in flight. */
  tunnels: number
  requests: number
  /** Times a tunnel stopped reading from TCP because the WebSocket send buffer was above 1 MiB. */
  backpressurePauses: number
}

export interface RunningProxy {
  readonly port: number
  readonly host: string
  /** `http://host:port`, for `proxyUrl`. */
  readonly url: string
  stats(): ProxyStats
  /**
   * Stops accepting, closes tunnels with 1001, lets plain requests in flight finish for up to
   * `graceMs` (default 5000), then drops whatever is left.
   */
  close(graceMs?: number): Promise<void>
}

/** Tunnel frames received before `{"ok":true}` are held up to this many bytes. */
const EARLY_DATA_LIMIT = WS_HIGH_WATER
/** Largest WebSocket message accepted from a client. */
const MAX_FRAME = 4 * 1024 * 1024
const MAX_ADDRESSES = 4

const systemLookup: Lookup = async (host) => (await dns.promises.lookup(host, { all: true })).map((a) => a.address)

function isTimeout(e: unknown): boolean {
  return e instanceof ProxyError && e.code === 'timeout'
}

function connectOne(address: string, port: number, signal: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: address, port, allowHalfOpen: true })
    const onAbort = (): void => {
      sock.destroy()
      reject(new ProxyError('timeout', 'connection attempt abandoned'))
    }
    sock.once('connect', () => {
      signal.removeEventListener('abort', onAbort)
      sock.removeAllListeners('error')
      sock.setNoDelay(true)
      resolve(sock)
    })
    sock.once('error', (e) => {
      signal.removeEventListener('abort', onAbort)
      reject(new ProxyError('connect', `could not connect: ${(e as NodeJS.ErrnoException).code ?? e.message}`))
    })
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

function secure(sock: net.Socket, servername: string | undefined, ca: string[] | undefined, signal: AbortSignal): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const t = tls.connect({
      socket: sock,
      servername,
      ALPNProtocols: ['http/1.1'],
      ...(ca ? { ca: [...tls.rootCertificates, ...ca] } : {}),
    })
    const onAbort = (): void => {
      t.destroy()
      reject(new ProxyError('timeout', 'TLS handshake abandoned'))
    }
    t.once('secureConnect', () => {
      signal.removeEventListener('abort', onAbort)
      t.removeAllListeners('error')
      resolve(t)
    })
    t.once('error', (e) => {
      signal.removeEventListener('abort', onAbort)
      t.destroy()
      reject(new ProxyError('connect', `TLS: ${(e as NodeJS.ErrnoException).code ?? e.message}`))
    })
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function startProxy(config: ProxyConfig, options: ProxyOptions = {}): Promise<RunningProxy> {
  const cfg = config
  const lookup = options.lookup ?? systemLookup
  const limiter = new Limiter(cfg.maxConnections, cfg.bytesPerMinute, options.now)
  const stats: ProxyStats = { tunnels: 0, requests: 0, backpressurePauses: 0 }
  const tunnels = new Set<WsSocket>()
  let closing = false

  const log = (entry: ConnectionLog): void => {
    try {
      options.log?.(entry)
    } catch { /* a logger must not break a connection */ }
  }

  /**
   * Resolves, applies the address policy, and connects to a resolved address (never to the name),
   * all within the connect timeout. `cancel` abandons the attempt from outside.
   */
  async function dial(host: string, port: number, cancel: AbortSignal, withTls: boolean): Promise<net.Socket | tls.TLSSocket> {
    const ac = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ac.abort()
    }, cfg.connectTimeoutMs)
    const onCancel = (): void => ac.abort()
    cancel.addEventListener('abort', onCancel, { once: true })
    if (cancel.aborted) ac.abort()
    try {
      const aborted = new Promise<never>((_, reject) => {
        const fire = (): void => reject(new ProxyError('timeout', 'abandoned'))
        if (ac.signal.aborted) fire()
        else ac.signal.addEventListener('abort', fire, { once: true })
      })
      aborted.catch(() => {})
      const addrs = await Promise.race([resolveDestination(cfg, host, lookup), aborted])
      let last: ProxyError = new ProxyError('connect', 'no address to connect to')
      for (const addr of addrs.slice(0, MAX_ADDRESSES)) {
        try {
          const sock = await connectOne(addr, port, ac.signal)
          if (!withTls) return sock
          return await secure(sock, ipVersion(host) ? undefined : host, options.ca, ac.signal)
        } catch (e) {
          last = toProxyError(e)
          if (ac.signal.aborted) break
        }
      }
      throw last
    } catch (e) {
      if (timedOut) throw new ProxyError('timeout', `no connection to ${host}:${port} within ${cfg.connectTimeoutMs} ms`)
      throw e
    } finally {
      clearTimeout(timer)
      cancel.removeEventListener('abort', onCancel)
    }
  }

  // -------------------------------------------------------------------------------------------
  // Tunnel mode

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_FRAME,
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  })

  function handleTunnel(ws: WsSocket, req: http.IncomingMessage): void {
    const started = Date.now()
    const entry: ConnectionLog = { mode: 'tcp', host: '', port: 0, up: 0, down: 0, ms: 0 }
    const cancel = new AbortController()
    let sock: net.Socket | null = null
    let release: (() => void) | null = null
    let limitKey = ''
    let open = false
    let done = false
    let early: Buffer[] = []
    let earlyBytes = 0
    let earlyEnd = false
    let localEnded = false
    let wsPaused = false
    let sockPaused = false
    let idle: NodeJS.Timeout | null = null

    tunnels.add(ws)
    stats.tunnels++

    const cleanup = (): void => {
      if (done) return
      done = true
      tunnels.delete(ws)
      stats.tunnels--
      if (idle) clearTimeout(idle)
      cancel.abort()
      release?.()
      if (sock && !sock.destroyed) {
        // Let bytes the client already sent reach the target, but do not wait for ever.
        const s = sock
        s.removeAllListeners('data')
        s.resume()
        s.destroySoon()
        setTimeout(() => s.destroy(), 5000).unref()
      }
      entry.ms = Date.now() - started
      log(entry)
    }

    const closeWs = (code: number, reason: string): void => {
      if (wsPaused) {
        wsPaused = false
        ws.resume()
      }
      if (ws.readyState === ws.OPEN) ws.close(code, reason.slice(0, 120))
    }

    const fail = (err: ProxyError): void => {
      entry.error = err.code
      if (ws.readyState === ws.OPEN) ws.send(failFrame(err))
      closeWs(CLOSE_REFUSED, err.code)
    }

    const account = (n: number): boolean => {
      idle?.refresh()
      if (limiter.consume(limitKey, n)) return true
      entry.error = 'limit'
      closeWs(CLOSE_LIMIT, 'limit')
      sock?.destroy()
      return false
    }

    const toTarget = (data: Buffer): void => {
      const s = sock!
      entry.up += data.length
      if (!account(data.length)) return
      if (!s.write(data) && !wsPaused) {
        wsPaused = true
        ws.pause()
        s.once('drain', () => {
          if (wsPaused && !done) {
            wsPaused = false
            ws.resume()
          }
        })
      }
    }

    const endTarget = (): void => {
      if (localEnded) return
      localEnded = true
      sock!.end()
    }

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (done) return
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (!isBinary) {
        if (!isEndFrame(buf.toString('utf8'))) return closeWs(CLOSE_PROTOCOL, 'unexpected text frame')
        if (open) endTarget()
        else earlyEnd = true
        return
      }
      if (localEnded || earlyEnd) return closeWs(CLOSE_PROTOCOL, 'data after end')
      if (open) return toTarget(buf)
      earlyBytes += buf.length
      if (earlyBytes > EARLY_DATA_LIMIT) return closeWs(CLOSE_PROTOCOL, 'too much data before the tunnel opened')
      early.push(buf)
    })
    ws.on('close', cleanup)
    ws.on('error', () => {
      ws.terminate()
      cleanup()
    })

    void (async () => {
      try {
        const { token } = parseSubprotocols(req.headers['sec-websocket-protocol'])
        limitKey = authorize(cfg, token, req.socket.remoteAddress ?? '')
        const dest = parseTunnelRequest(new URL(req.url ?? '/', 'http://x').searchParams)
        entry.host = dest.host
        entry.port = dest.port
        checkHostPort(cfg, dest.host, dest.port)
        release = limiter.acquire(limitKey)
        const s = (await dial(dest.host, dest.port, cancel.signal, false)) as net.Socket
        if (done) return void s.destroy()
        sock = s
      } catch (e) {
        if (!done) fail(toProxyError(e))
        return
      }
      const s = sock
      open = true
      idle = setTimeout(() => {
        entry.error = 'timeout'
        closeWs(CLOSE_IDLE, 'idle timeout')
        s.destroy()
      }, cfg.idleTimeoutMs)

      let sockError = false
      s.on('data', (chunk: Buffer) => {
        entry.down += chunk.length
        if (!account(chunk.length)) return
        if (ws.readyState !== ws.OPEN) return
        ws.send(chunk, { binary: true }, () => {
          if (sockPaused && ws.bufferedAmount <= WS_HIGH_WATER) {
            sockPaused = false
            s.resume()
          }
        })
        if (!sockPaused && ws.bufferedAmount > WS_HIGH_WATER) {
          sockPaused = true
          stats.backpressurePauses++
          s.pause()
        }
      })
      s.on('end', () => {
        if (ws.readyState === ws.OPEN) ws.send(END_FRAME)
      })
      s.on('error', () => {
        sockError = true
      })
      s.on('close', () => {
        if (done) return
        if (sockError) entry.error ??= 'connect'
        closeWs(sockError ? CLOSE_UPSTREAM : CLOSE_NORMAL, sockError ? 'connection to the target failed' : '')
      })

      ws.send(OK_FRAME)
      for (const b of early) toTarget(b)
      early = []
      if (earlyEnd && !done) endTarget()
    })()
  }

  // -------------------------------------------------------------------------------------------
  // Plain mode

  function sendError(req: http.IncomingMessage, res: http.ServerResponse, err: ProxyError): void {
    if (res.headersSent) return void res.destroy()
    const body = errorBody(err)
    res.writeHead(502, {
      ...corsHeaders(),
      [HEADER_ERROR]: err.code,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      connection: 'close',
    })
    res.end(body)
    req.resume() // discard whatever is left of the request body
  }

  function handlePlain(req: http.IncomingMessage, res: http.ServerResponse): void {
    const started = Date.now()
    const entry: ConnectionLog = { mode: 'http', host: '', port: 0, up: 0, down: 0, ms: 0 }
    const cancel = new AbortController()
    let release: (() => void) | null = null
    let limitKey = ''
    let upstream: net.Socket | tls.TLSSocket | null = null
    let upReq: http.ClientRequest | null = null
    let done = false
    let idle: NodeJS.Timeout | null = null

    stats.requests++
    const cleanup = (): void => {
      if (done) return
      done = true
      stats.requests--
      if (idle) clearTimeout(idle)
      cancel.abort()
      release?.()
      upReq?.destroy()
      upstream?.destroy()
      entry.ms = Date.now() - started
      log(entry)
    }
    const fail = (err: ProxyError): void => {
      if (done) return
      entry.error = err.code
      sendError(req, res, err)
      cleanup()
    }
    const account = (n: number): boolean => {
      idle?.refresh()
      if (limiter.consume(limitKey, n)) return true
      fail(new ProxyError('limit', 'byte limit for this minute reached'))
      return false
    }
    res.on('close', cleanup)
    req.on('error', () => res.destroy())

    void (async () => {
      let plain
      try {
        plain = parsePlainRequest((name) => {
          const v = req.headers[name]
          return Array.isArray(v) ? v[0] : v
        })
        limitKey = authorize(cfg, plain.token, req.socket.remoteAddress ?? '')
        entry.host = plain.host
        entry.port = plain.port
        checkHostPort(cfg, plain.host, plain.port)
        release = limiter.acquire(limitKey)
        const s = await dial(plain.host, plain.port, cancel.signal, plain.secure)
        if (done) return void s.destroy()
        upstream = s
      } catch (e) {
        return fail(toProxyError(e))
      }
      const sock = upstream

      idle = setTimeout(() => fail(new ProxyError('timeout', `no data for ${cfg.idleTimeoutMs} ms`)), cfg.idleTimeoutMs)

      const headers: HeaderPairs = [...plain.headers]
      if (!headers.some(([k]) => k.toLowerCase() === 'host')) headers.unshift(['host', plain.url.host])
      const length = req.headers['content-length']
      const chunked = req.headers['transfer-encoding'] !== undefined
      const hasBody = chunked || (length !== undefined && length !== '0')
      if (length !== undefined && !chunked && (hasBody || !['GET', 'HEAD'].includes(req.method ?? ''))) headers.push(['content-length', length])
      else if (chunked) headers.push(['transfer-encoding', 'chunked'])
      headers.push(['connection', 'close'])

      let up: http.ClientRequest
      try {
        up = http.request({
          method: req.method,
          path: plain.url.pathname + plain.url.search,
          headers: headers as unknown as http.OutgoingHttpHeaders,
          createConnection: () => sock as unknown as Duplex as net.Socket,
          setHost: false,
        })
      } catch (e) {
        return fail(new ProxyError('request', e instanceof Error ? e.message : 'invalid request'))
      }
      upReq = up

      up.on('error', (e) => fail(new ProxyError('connect', `request to the target failed: ${(e as NodeJS.ErrnoException).code ?? e.message}`)))
      up.on('upgrade', (_r, s) => {
        s.destroy()
        fail(new ProxyError('connect', 'the target switched protocols'))
      })
      up.on('response', (upRes) => {
        if (done) return
        const raw: HeaderPairs = []
        for (let i = 0; i + 1 < upRes.rawHeaders.length; i += 2) raw.push([upRes.rawHeaders[i]!, upRes.rawHeaders[i + 1]!])
        const status = upRes.statusCode ?? 502
        const out: Record<string, string> = {
          ...corsHeaders(),
          [HEADER_STATUS]: String(status),
          [HEADER_RESP_HEADERS]: encodeHeaders(filterResponseHeaders(raw)),
          'cache-control': 'no-store',
          'x-accel-buffering': 'no', // ask reverse proxies in front of this one not to buffer
        }
        const type = upRes.headers['content-type']
        if (type) out['content-type'] = type
        const len = upRes.headers['content-length']
        if (len !== undefined && upRes.headers['transfer-encoding'] === undefined && /^\d+$/.test(len)) out['content-length'] = len
        try {
          res.writeHead(status, out)
        } catch (e) {
          return fail(new ProxyError('connect', `unusable response from the target: ${e instanceof Error ? e.message : ''}`))
        }
        res.flushHeaders()
        upRes.on('data', (chunk: Buffer) => {
          entry.down += chunk.length
          if (!account(chunk.length)) return
          if (!res.write(chunk)) {
            upRes.pause()
            res.once('drain', () => upRes.resume())
          }
        })
        upRes.on('end', () => res.end())
        upRes.on('error', () => res.destroy())
        upRes.on('aborted', () => res.destroy())
      })

      if (!hasBody) {
        up.end()
        req.resume()
        return
      }
      req.on('data', (chunk: Buffer) => {
        if (done) return
        entry.up += chunk.length
        if (!account(chunk.length)) return
        if (!up.write(chunk)) {
          req.pause()
          up.once('drain', () => req.resume())
        }
      })
      req.on('end', () => up.end())
    })()
  }

  // -------------------------------------------------------------------------------------------
  // HTTP server

  const server = http.createServer({ maxHeaderSize: 128 * 1024, requestTimeout: 0 }, (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const known = path === '/v1/health' || (path === '/v1/http' && cfg.modes.includes('http')) || (path === '/v1/tcp' && cfg.modes.includes('tcp'))
    const text = (status: number, body: string, extra: Record<string, string> = {}): void => {
      res.writeHead(status, { ...corsHeaders(), 'content-type': 'application/json', 'cache-control': 'no-store', ...extra })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    if (!known) return text(404, '{"code":"request","message":"no such endpoint"}')
    // A CORS preflight. An OPTIONS request that carries x-bh-url is a request to forward instead.
    if (req.method === 'OPTIONS' && !(path === '/v1/http' && req.headers['x-bh-url'])) {
      res.writeHead(204, preflightHeaders((n) => req.headers[n] as string | undefined))
      return void res.end()
    }
    if (path === '/v1/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, '{"code":"request","message":"GET only"}', { allow: 'GET, HEAD, OPTIONS' })
      return text(200, JSON.stringify(healthBody(cfg)))
    }
    if (path === '/v1/tcp') return text(426, '{"code":"request","message":"WebSocket upgrade required"}', { upgrade: 'websocket', connection: 'Upgrade' })
    res.socket?.setNoDelay(true)
    handlePlain(req, res)
  })

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (closing || path !== '/v1/tcp' || !cfg.modes.includes('tcp')) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleTunnel(ws, req))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, cfg.host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address() as net.AddressInfo

  let closed: Promise<void> | null = null
  return {
    port: address.port,
    host: address.address,
    url: `http://${address.family === 'IPv6' ? `[${address.address}]` : address.address}:${address.port}`,
    stats: () => ({ ...stats }),
    close(graceMs = 5000) {
      closed ??= new Promise<void>((resolve) => {
        closing = true
        server.close(() => {
          clearTimeout(timer)
          clearInterval(sweep)
          resolve()
        })
        for (const ws of tunnels) ws.close(CLOSE_GOING_AWAY, 'proxy shutting down')
        // Keep-alive connections become idle one by one as their requests finish.
        server.closeIdleConnections()
        const sweep = setInterval(() => server.closeIdleConnections(), 50)
        const timer = setTimeout(() => {
          for (const ws of tunnels) ws.terminate()
          server.closeAllConnections()
        }, graceMs)
      })
      return closed
    },
  }
}
