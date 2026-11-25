// Browser-side client for the Beamhop proxy (PROTOCOL.md). No Node dependencies: it needs only
// WebSocket, fetch and streams, so it also runs in workers, Node 22, Deno and Bun.
import {
  CLOSE_IDLE, CLOSE_LIMIT, CLOSE_NORMAL, END_FRAME, HEADER_ERROR, HEADER_HEADERS, HEADER_RESP_HEADERS, HEADER_STATUS,
  HEADER_TOKEN, HEADER_URL, ProxyError, SUBPROTOCOL, WS_HIGH_WATER, decodeHeaders, encodeHeaders, isEndFrame,
  type HeaderPairs, type Mode, type ProxyErrorCode,
} from './core'

export { ProxyError, encodeHeaders, decodeHeaders }
export type { HeaderPairs, Mode, ProxyErrorCode }

/** Outgoing data is cut into frames of at most this size. */
const FRAME_SIZE = 256 * 1024
const KNOWN_CODES = new Set<string>(['auth', 'policy', 'dns', 'connect', 'timeout', 'limit', 'request'])

function endpoint(proxyUrl: string, path: string, ws: boolean): string {
  const base = new URL(proxyUrl)
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  const url = new URL(path, base)
  if (ws) url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol
  return url.href
}

function asCode(code: unknown): ProxyErrorCode {
  return typeof code === 'string' && KNOWN_CODES.has(code) ? (code as ProxyErrorCode) : 'proxy'
}

// ---------------------------------------------------------------------------------------------
// Tunnel mode

export interface TunnelOptions {
  /** Base URL of the proxy, `https://proxy.example` (or `http://localhost:8787`). */
  proxyUrl: string
  /** Access token; omit for an open proxy. */
  token?: string
  host: string
  port: number
  /** Gives up (and rejects, or closes the tunnel) when aborted. */
  signal?: AbortSignal
  /** WebSocket implementation, for runtimes without a global one. */
  WebSocket?: typeof WebSocket
}

export interface TunnelClose {
  /** WebSocket close code: 1000 normal, 1001 proxy shutting down, 1011 target connection failed, 4001 idle timeout, 4002 limit. */
  code: number
  reason: string
}

export interface Tunnel extends AsyncIterable<Uint8Array> {
  /**
   * Sends bytes to the target. Resolves once the browser's send buffer is back under 1 MiB, so
   * awaiting each call gives backpressure. Rejects if the tunnel is closed or `end()` was called.
   */
  write(bytes: Uint8Array): Promise<void>
  /** Half-close: no more bytes from this side (TCP FIN). The target can keep sending. */
  end(): void
  /** Tears down both directions. */
  close(): void
  /**
   * Callbacks. Bytes that arrive before `onData` is set are kept and delivered when it is set.
   * `onEnd`: the target half-closed. `onError`: the tunnel died abnormally (always followed by
   * `onClose`). `onClose`: the tunnel is gone, for whatever reason.
   */
  onData: ((bytes: Uint8Array) => void) | null
  onEnd: (() => void) | null
  onError: ((error: ProxyError) => void) | null
  onClose: ((info: TunnelClose) => void) | null
  /** Resolves when the tunnel is gone. Never rejects. */
  readonly closed: Promise<TunnelClose>
  /** Bytes queued in the WebSocket and not yet sent. */
  readonly bufferedAmount: number
}

/**
 * Opens a TCP connection to `host:port` through the proxy. Resolves after the proxy's
 * `{"ok":true}` frame; rejects with a `ProxyError` whose `code` is the proxy's (`auth`, `policy`,
 * `dns`, `connect`, `timeout`, `limit`, `request`) or `proxy` when the proxy itself is unreachable.
 *
 * Use either the callbacks or `for await (const chunk of tunnel)`, not both. The iterator ends
 * when the target half-closes or the tunnel closes normally, and throws if it dies abnormally.
 */
export function openTunnel(options: TunnelOptions): Promise<Tunnel> {
  const WS = options.WebSocket ?? globalThis.WebSocket
  if (!WS) return Promise.reject(new ProxyError('proxy', 'no WebSocket implementation available'))
  const url = new URL(endpoint(options.proxyUrl, 'v1/tcp', true))
  url.searchParams.set('host', options.host)
  url.searchParams.set('port', String(options.port))
  const protocols = options.token ? [SUBPROTOCOL, `${SUBPROTOCOL}.${options.token}`] : [SUBPROTOCOL]

  return new Promise<Tunnel>((resolve, reject) => {
    let ws: WebSocket
    try {
      ws = new WS(url.href, protocols)
    } catch (e) {
      return reject(new ProxyError('proxy', e instanceof Error ? e.message : 'could not open a WebSocket'))
    }
    ws.binaryType = 'arraybuffer'

    let opened = false
    let settled = false
    let localEnded = false
    let remoteEnded = false
    let gone = false
    let closedByUs = false
    let failure: ProxyError | null = null
    let handshakeError: ProxyError | null = null

    // Received and not yet consumed: chunks, then possibly the end marker.
    const queue: Uint8Array[] = []
    let endQueued = false
    let onData: ((bytes: Uint8Array) => void) | null = null
    let onEnd: (() => void) | null = null
    let wake: (() => void) | null = null
    let resolveClosed!: (info: TunnelClose) => void
    const closed = new Promise<TunnelClose>((r) => (resolveClosed = r))

    const flush = (): void => {
      while (onData && queue.length > 0) onData(queue.shift()!)
      if (endQueued && queue.length === 0 && onEnd) {
        endQueued = false
        onEnd()
      }
    }
    const notify = (): void => {
      flush()
      const w = wake
      wake = null
      w?.()
    }

    const onAbort = (): void => {
      closedByUs = true
      if (!settled) {
        settled = true
        reject(new ProxyError('proxy', 'aborted'))
      }
      if (ws.readyState === WS.OPEN || ws.readyState === WS.CONNECTING) ws.close()
    }

    const tunnel: Tunnel = {
      async write(bytes) {
        if (gone || ws.readyState !== WS.OPEN) throw failure ?? new ProxyError('connect', 'tunnel is closed')
        if (localEnded) throw new ProxyError('request', 'write after end')
        for (let off = 0; off < bytes.byteLength; off += FRAME_SIZE) {
          // Copy: the caller may reuse its buffer, and a view on a SharedArrayBuffer cannot be sent.
          ws.send(bytes.slice(off, off + FRAME_SIZE))
          while (ws.bufferedAmount > WS_HIGH_WATER) {
            await new Promise((r) => setTimeout(r, 4))
            if (gone || ws.readyState !== WS.OPEN) throw failure ?? new ProxyError('connect', 'tunnel closed while writing')
          }
        }
      },
      end() {
        if (localEnded || gone || ws.readyState !== WS.OPEN) return
        localEnded = true
        ws.send(END_FRAME)
      },
      close() {
        closedByUs = true
        if (ws.readyState === WS.OPEN || ws.readyState === WS.CONNECTING) ws.close(CLOSE_NORMAL)
      },
      get onData() {
        return onData
      },
      set onData(fn) {
        onData = fn
        flush()
      },
      get onEnd() {
        return onEnd
      },
      set onEnd(fn) {
        onEnd = fn
        flush()
      },
      onError: null,
      onClose: null,
      closed,
      get bufferedAmount() {
        return ws.bufferedAmount
      },
      [Symbol.asyncIterator]() {
        const next = async (): Promise<IteratorResult<Uint8Array>> => {
          for (;;) {
            if (queue.length > 0) return { done: false, value: queue.shift()! }
            if (endQueued || remoteEnded) {
              endQueued = false
              return { done: true, value: undefined }
            }
            if (gone) {
              if (failure) throw failure
              return { done: true, value: undefined }
            }
            await new Promise<void>((r) => (wake = r))
          }
        }
        return {
          next,
          async return() {
            tunnel.close()
            return { done: true, value: undefined }
          },
        }
      },
    }

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') {
        if (!opened) {
          let frame: { ok?: unknown; code?: unknown; message?: unknown }
          try {
            frame = JSON.parse(ev.data) as typeof frame
          } catch {
            frame = {}
          }
          if (frame.ok === true) {
            opened = true
            settled = true
            resolve(tunnel)
          } else {
            handshakeError = new ProxyError(asCode(frame.code), typeof frame.message === 'string' ? frame.message : 'the proxy refused the connection')
          }
          return
        }
        if (isEndFrame(ev.data) && !remoteEnded) {
          remoteEnded = true
          endQueued = true
          notify()
        }
        return
      }
      if (!opened) return
      queue.push(new Uint8Array(ev.data as ArrayBuffer))
      notify()
    }
    // The close event that always follows carries the outcome; nothing to do here.
    ws.onerror = () => {}
    ws.onclose = (ev: CloseEvent) => {
      gone = true
      options.signal?.removeEventListener('abort', onAbort)
      const info: TunnelClose = { code: ev.code, reason: ev.reason }
      if (!settled) {
        settled = true
        reject(handshakeError ?? new ProxyError('proxy', `could not reach the proxy (WebSocket closed with ${ev.code})`))
        resolveClosed(info)
        return
      }
      if (opened && !closedByUs && ev.code !== CLOSE_NORMAL) {
        const code: ProxyErrorCode = ev.code === CLOSE_IDLE ? 'timeout' : ev.code === CLOSE_LIMIT ? 'limit' : 'connect'
        failure = new ProxyError(code, ev.reason || `tunnel closed abnormally (${ev.code})`)
      }
      notify()
      if (failure) tunnel.onError?.(failure)
      tunnel.onClose?.(info)
      resolveClosed(info)
    }

    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Plain mode

export interface ProxyFetchOptions {
  proxyUrl: string
  token?: string
  /** Absolute http(s) URL of the target. */
  url: string
  method?: string
  /**
   * Headers for the target, as pairs so that order and repeats survive. Anything goes, including
   * names `fetch` refuses (`user-agent`, `cookie`, `host`, ...): they travel encoded.
   */
  headers?: HeaderPairs | Record<string, string>
  /**
   * Request body. A `ReadableStream` is sent with `duplex: "half"`, which browsers only allow over
   * HTTP/2 or HTTP/3 and only Chromium implements; pass bytes when unsure.
   */
  body?: BodyInit | null
  signal?: AbortSignal
  /** fetch implementation, for tests and runtimes without a global one. */
  fetch?: typeof fetch
}

export interface ProxyResponse {
  /** The target's status. */
  status: number
  /** The target's response headers in order, repeats (such as `set-cookie`) kept apart. */
  headers: HeaderPairs
  /** The target's body, streamed as it arrives. */
  body: ReadableStream<Uint8Array>
}

/**
 * Makes an HTTP request through the proxy's plain mode. The proxy operator can read the request
 * and the response. Redirects are not followed: a 3xx comes back as it is. Rejects with a
 * `ProxyError` when the proxy refuses or fails (`code` from the proxy), or `proxy` when the proxy
 * is unreachable or the answer did not come from a Beamhop proxy.
 */
export async function proxyFetch(options: ProxyFetchOptions): Promise<ProxyResponse> {
  const doFetch = options.fetch ?? globalThis.fetch
  const pairs: HeaderPairs = Array.isArray(options.headers) ? options.headers : Object.entries(options.headers ?? {})
  const headers: Record<string, string> = { [HEADER_URL]: options.url }
  if (options.token) headers[HEADER_TOKEN] = options.token
  if (pairs.length > 0) headers[HEADER_HEADERS] = encodeHeaders(pairs)
  const body = options.body ?? null
  const init: RequestInit & { duplex?: 'half' } = {
    method: options.method ?? 'GET',
    headers,
    body,
    signal: options.signal,
    // Not 'manual': a browser would then hide any 3xx behind an opaque response. The proxy never
    // sends a real Location header, so with 'follow' a target's 3xx is returned as it is.
    redirect: 'follow',
    cache: 'no-store',
    credentials: 'omit',
  }
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) init.duplex = 'half'

  let res: Response
  try {
    res = await doFetch(endpoint(options.proxyUrl, 'v1/http', false), init)
  } catch (e) {
    if (options.signal?.aborted) throw e
    throw new ProxyError('proxy', `could not reach the proxy: ${e instanceof Error ? e.message : String(e)}`)
  }

  const error = res.headers.get(HEADER_ERROR)
  if (error) {
    let message = `the proxy failed (${error})`
    try {
      const parsed = (await res.json()) as { message?: unknown }
      if (typeof parsed.message === 'string') message = parsed.message
    } catch { /* keep the generic message */ }
    throw new ProxyError(asCode(error), message)
  }
  const status = Number(res.headers.get(HEADER_STATUS))
  const encoded = res.headers.get(HEADER_RESP_HEADERS)
  if (!Number.isInteger(status) || status < 100 || encoded === null) {
    void res.body?.cancel().catch(() => {})
    throw new ProxyError('proxy', `unexpected answer from ${options.proxyUrl} (HTTP ${res.status}); is it a Beamhop proxy?`)
  }
  let respHeaders: HeaderPairs
  try {
    respHeaders = decodeHeaders(encoded)
  } catch {
    void res.body?.cancel().catch(() => {})
    throw new ProxyError('proxy', 'the proxy returned unreadable response headers')
  }
  return { status, headers: respHeaders, body: res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }) }
}

// ---------------------------------------------------------------------------------------------
// Health

export interface ProxyHealth { ok: true; v: number; modes: Mode[] }

/** Asks the proxy which protocol version and modes it supports. Rejects with `proxy` otherwise. */
export async function health(proxyUrl: string, options: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<ProxyHealth> {
  const doFetch = options.fetch ?? globalThis.fetch
  let parsed: { ok?: unknown; v?: unknown; modes?: unknown }
  try {
    const res = await doFetch(endpoint(proxyUrl, 'v1/health', false), { signal: options.signal, cache: 'no-store', credentials: 'omit' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    parsed = (await res.json()) as typeof parsed
  } catch (e) {
    if (options.signal?.aborted) throw e
    throw new ProxyError('proxy', `no Beamhop proxy at ${proxyUrl}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (parsed.ok !== true || typeof parsed.v !== 'number' || !Array.isArray(parsed.modes)) {
    throw new ProxyError('proxy', `no Beamhop proxy at ${proxyUrl}`)
  }
  return { ok: true, v: parsed.v, modes: parsed.modes.filter((m): m is Mode => m === 'tcp' || m === 'http') }
}
