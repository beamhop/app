// Beamhop proxy for Cloudflare Workers. Same protocol as node.ts (PROTOCOL.md), with the shared
// logic from core.ts: tunnel mode over `cloudflare:sockets`, plain mode over `fetch`.
//
// UNTESTED: this file is type-checked but has never run on Workers. README.md lists where the
// platform cannot meet the contract (send-buffer backpressure, address pinning in plain mode,
// limits shared across isolates, compressed bodies).
import { connect } from 'cloudflare:sockets'
import {
  CLOSE_IDLE, CLOSE_LIMIT, CLOSE_NORMAL, CLOSE_PROTOCOL, CLOSE_REFUSED, CLOSE_UPSTREAM,
  END_FRAME, HEADER_ERROR, HEADER_RESP_HEADERS, HEADER_STATUS, Limiter, OK_FRAME, ProxyError, SUBPROTOCOL,
  authorize, checkHostPort, corsHeaders, encodeHeaders, errorBody, failFrame, filterResponseHeaders, healthBody,
  isEndFrame, parseConfig, parsePlainRequest, parseSubprotocols, parseTunnelRequest, preflightHeaders,
  resolveDestination, toProxyError,
  type HeaderPairs, type Lookup, type ProxyConfig,
} from './core'

// The few Workers runtime types this file needs, declared here so the package type-checks without
// @cloudflare/workers-types.
interface WorkerWebSocket {
  accept(): void
  send(data: string | ArrayBuffer | ArrayBufferView): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message', listener: (event: { data: string | ArrayBuffer }) => void): void
  addEventListener(type: 'close' | 'error', listener: (event: unknown) => void): void
}
declare const WebSocketPair: new () => { 0: WorkerWebSocket; 1: WorkerWebSocket }
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void }

/** Worker variables: the same names as the Node proxy's environment variables. */
export type Env = Record<string, unknown>

/** Frames received before `{"ok":true}` are held up to this many bytes. */
const EARLY_DATA_LIMIT = 1024 * 1024

interface State { cfg: ProxyConfig; limiter: Limiter }
let state: State | null = null
let stateSource = ''

/** Config and limiter live for the life of the isolate (limits are therefore per isolate). */
function getState(env: Env): State {
  const source = JSON.stringify(Object.entries(env).filter(([k, v]) => k.startsWith('BH_PROXY_') && typeof v !== 'object'))
  if (!state || source !== stateSource) {
    const cfg = parseConfig(env)
    state = { cfg, limiter: new Limiter(cfg.maxConnections, cfg.bytesPerMinute) }
    stateSource = source
  }
  return state
}

/** Resolves over DNS-over-HTTPS (JSON form), A then AAAA. */
function dohLookup(cfg: ProxyConfig): Lookup {
  return async (host) => {
    const query = async (type: 'A' | 'AAAA', code: number): Promise<string[]> => {
      const url = new URL(cfg.dohUrl)
      url.searchParams.set('name', host)
      url.searchParams.set('type', type)
      const res = await fetch(url.href, { headers: { accept: 'application/dns-json' } })
      if (!res.ok) throw new Error(`DNS query failed: HTTP ${res.status}`)
      const body = (await res.json()) as { Status?: number; Answer?: { type?: number; data?: string }[] }
      if (body.Status !== 0) return []
      return (body.Answer ?? []).filter((a) => a.type === code && typeof a.data === 'string').map((a) => a.data as string)
    }
    const [a, aaaa] = await Promise.all([query('A', 1), query('AAAA', 28)])
    return [...a, ...aaaa]
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProxyError('timeout', message)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

function json(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...corsHeaders(), 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } })
}

function errorResponse(err: ProxyError): Response {
  return json(502, errorBody(err), { [HEADER_ERROR]: err.code })
}

function clientId(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? ''
}

// ---------------------------------------------------------------------------------------------
// Tunnel mode

function handleTunnel(request: Request, st: State, ctx: ExecutionContext): Response {
  if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
    return json(426, '{"code":"request","message":"WebSocket upgrade required"}', { upgrade: 'websocket' })
  }
  const { cfg, limiter } = st
  const pair = new WebSocketPair()
  const client = pair[0]
  const ws = pair[1]
  ws.accept()
  const { offered, token } = parseSubprotocols(request.headers.get('sec-websocket-protocol'))

  let done = false
  let open = false
  let release: (() => void) | null = null
  let limitKey = ''
  let socket: ReturnType<typeof connect> | null = null
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let localEnded = false
  let remoteEnded = false
  let early: Uint8Array[] = []
  let earlyBytes = 0
  let earlyEnd = false
  let idle: ReturnType<typeof setTimeout> | null = null
  // Writes to the socket, in order. Each one waits for the socket's own backpressure.
  let writes: Promise<void> = Promise.resolve()
  let finished!: () => void
  const lifetime = new Promise<void>((r) => (finished = r))

  const cleanup = (): void => {
    if (done) return
    done = true
    if (idle) clearTimeout(idle)
    release?.()
    // Let queued writes go out, then drop the connection.
    const s = socket
    void writes.catch(() => {}).then(() => s?.close().catch(() => {}))
    void reader?.cancel().catch(() => {})
    finished()
  }
  const closeWs = (code: number, reason: string): void => {
    try {
      ws.close(code, reason.slice(0, 120))
    } catch { /* already closed */ }
    cleanup()
  }
  const touch = (): void => {
    if (idle) clearTimeout(idle)
    idle = setTimeout(() => closeWs(CLOSE_IDLE, 'idle timeout'), cfg.idleTimeoutMs)
  }
  const account = (n: number): boolean => {
    touch()
    if (limiter.consume(limitKey, n)) return true
    closeWs(CLOSE_LIMIT, 'limit')
    return false
  }
  const toTarget = (bytes: Uint8Array): void => {
    if (!account(bytes.byteLength)) return
    const w = writer!
    writes = writes.then(() => w.write(bytes))
    writes.catch(() => closeWs(CLOSE_UPSTREAM, 'connection to the target failed'))
  }
  const endTarget = (): void => {
    if (localEnded) return
    localEnded = true
    const w = writer!
    writes = writes.then(() => w.close())
    writes.then(() => {
      if (remoteEnded) closeWs(CLOSE_NORMAL, '')
    }, () => closeWs(CLOSE_UPSTREAM, 'connection to the target failed'))
  }

  ws.addEventListener('message', (event) => {
    if (done) return
    if (typeof event.data === 'string') {
      if (!isEndFrame(event.data)) return closeWs(CLOSE_PROTOCOL, 'unexpected text frame')
      if (open) endTarget()
      else earlyEnd = true
      return
    }
    if (localEnded || earlyEnd) return closeWs(CLOSE_PROTOCOL, 'data after end')
    const bytes = new Uint8Array(event.data)
    if (open) return toTarget(bytes)
    earlyBytes += bytes.byteLength
    if (earlyBytes > EARLY_DATA_LIMIT) return closeWs(CLOSE_PROTOCOL, 'too much data before the tunnel opened')
    early.push(bytes)
  })
  ws.addEventListener('close', () => closeWs(CLOSE_NORMAL, ''))
  ws.addEventListener('error', () => cleanup())

  const run = async (): Promise<void> => {
    try {
      limitKey = authorize(cfg, token, clientId(request))
      const dest = parseTunnelRequest(new URL(request.url).searchParams)
      checkHostPort(cfg, dest.host, dest.port)
      release = limiter.acquire(limitKey)
      const s = await withTimeout(
        (async () => {
          // Resolve first and connect to the address, so the policy check and the connection
          // cannot see different DNS answers.
          const addrs = await resolveDestination(cfg, dest.host, dohLookup(cfg))
          let last: unknown = new ProxyError('connect', 'no address to connect to')
          for (const addr of addrs.slice(0, 4)) {
            try {
              const candidate = connect({ hostname: addr, port: dest.port }, { secureTransport: 'off', allowHalfOpen: true })
              await candidate.opened
              return candidate
            } catch (e) {
              last = e
            }
          }
          throw toProxyError(last, 'connect')
        })(),
        cfg.connectTimeoutMs,
        `no connection to ${dest.host}:${dest.port} within ${cfg.connectTimeoutMs} ms`,
      )
      if (done) return void s.close().catch(() => {})
      socket = s
    } catch (e) {
      if (done) return
      const err = toProxyError(e)
      try {
        ws.send(failFrame(err))
      } catch { /* client already gone */ }
      return closeWs(CLOSE_REFUSED, err.code)
    }

    writer = socket.writable.getWriter()
    reader = socket.readable.getReader()
    open = true
    touch()
    ws.send(OK_FRAME)
    for (const b of early) toTarget(b)
    early = []
    if (earlyEnd && !done) endTarget()

    // Target to client. Workers give no view of the WebSocket's send buffer, so this loop cannot
    // stop reading while that buffer is above 1 MiB; the runtime does its own buffering.
    try {
      const r = reader
      for (;;) {
        const { value, done: eof } = await r.read()
        if (done) return
        if (eof) break
        if (!account(value.byteLength)) return
        ws.send(value)
      }
      remoteEnded = true
      ws.send(END_FRAME)
      if (localEnded) {
        await writes.catch(() => {})
        closeWs(CLOSE_NORMAL, '')
      }
    } catch {
      if (!done) closeWs(CLOSE_UPSTREAM, 'connection to the target failed')
    }
  }
  ctx.waitUntil(Promise.all([run(), lifetime]))

  const headers = new Headers()
  if (offered) headers.set('sec-websocket-protocol', SUBPROTOCOL)
  return new Response(null, { status: 101, headers, webSocket: client } as ResponseInit)
}

// ---------------------------------------------------------------------------------------------
// Plain mode

async function handlePlain(request: Request, st: State): Promise<Response> {
  const { cfg, limiter } = st
  let release: (() => void) | null = null
  try {
    const plain = parsePlainRequest((name) => request.headers.get(name))
    const limitKey = authorize(cfg, plain.token, clientId(request))
    checkHostPort(cfg, plain.host, plain.port)
    release = limiter.acquire(limitKey)
    const done = release

    // fetch() resolves the name itself, so unlike tunnel mode the address checked here is not
    // necessarily the address connected to. This check still refuses address literals and names
    // that resolve to non-public addresses at the time of the request.
    await withTimeout(resolveDestination(cfg, plain.host, dohLookup(cfg)), cfg.connectTimeoutMs, `could not resolve ${plain.host} in time`)

    const headers = new Headers()
    for (const [k, v] of plain.headers) headers.append(k, v)
    const hasBody = request.body !== null && request.method !== 'GET' && request.method !== 'HEAD'
    const meter = (onDone: (() => void) | null): TransformStream<Uint8Array, Uint8Array> =>
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (!limiter.consume(limitKey, chunk.byteLength)) {
            controller.error(new ProxyError('limit', 'byte limit for this minute reached'))
            onDone?.()
            return
          }
          controller.enqueue(chunk)
        },
        flush() {
          onDone?.()
        },
        // Part of the Streams standard, not yet in TypeScript's DOM types.
        cancel() {
          onDone?.()
        },
      } as Transformer<Uint8Array, Uint8Array>)

    let res: Response
    try {
      res = await withTimeout(
        fetch(plain.url.href, {
          method: request.method,
          headers,
          body: hasBody ? request.body!.pipeThrough(meter(null)) : null,
          redirect: 'manual',
        }),
        cfg.idleTimeoutMs,
        `no response from ${plain.host} within ${cfg.idleTimeoutMs} ms`,
      )
    } catch (e) {
      throw toProxyError(e, 'connect')
    }

    // The Workers runtime decompresses response bodies, so the encoding and length the target
    // declared no longer describe the bytes passed on.
    const pairs: HeaderPairs = []
    const decoded = res.headers.has('content-encoding')
    res.headers.forEach((value, name) => {
      if (name === 'set-cookie') return
      if (decoded && (name === 'content-encoding' || name === 'content-length')) return
      pairs.push([name, value])
    })
    for (const cookie of res.headers.getSetCookie()) pairs.push(['set-cookie', cookie])

    const out = new Headers(corsHeaders())
    out.set(HEADER_STATUS, String(res.status))
    out.set(HEADER_RESP_HEADERS, encodeHeaders(filterResponseHeaders(pairs)))
    out.set('cache-control', 'no-store')
    const type = res.headers.get('content-type')
    if (type) out.set('content-type', type)

    release = null // from here the response stream releases the slot
    if (res.body === null) {
      done()
      return new Response(null, { status: res.status, headers: out })
    }
    const body = res.body.pipeThrough(meter(done))
    return new Response(body, { status: res.status, headers: out })
  } catch (e) {
    return errorResponse(toProxyError(e))
  } finally {
    release?.()
  }
}

// ---------------------------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let st: State
    try {
      st = getState(env)
    } catch (e) {
      return json(500, JSON.stringify({ code: 'request', message: `proxy misconfigured: ${e instanceof Error ? e.message : String(e)}` }))
    }
    const { cfg } = st
    const path = new URL(request.url).pathname
    const known = path === '/v1/health' || (path === '/v1/http' && cfg.modes.includes('http')) || (path === '/v1/tcp' && cfg.modes.includes('tcp'))
    if (!known) return json(404, '{"code":"request","message":"no such endpoint"}')
    if (request.method === 'OPTIONS' && !(path === '/v1/http' && request.headers.has('x-bh-url'))) {
      return new Response(null, { status: 204, headers: preflightHeaders((n) => request.headers.get(n)) })
    }
    if (path === '/v1/health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, '{"code":"request","message":"GET only"}', { allow: 'GET, HEAD, OPTIONS' })
      return json(200, JSON.stringify(healthBody(cfg)))
    }
    if (path === '/v1/tcp') return handleTunnel(request, st, ctx)
    return handlePlain(request, st)
  },
}
