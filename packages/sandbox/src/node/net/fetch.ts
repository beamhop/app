// `fetch` for guest code, and the HTTP exchange primitive node:http shares with it.
// In 'http' mode an exchange goes to the app as one `http.open`. In 'tunnel' mode it is spoken as HTTP/1.1 by a
// small client here, over a net.Socket (or a TLS socket for https, once the machine has TLS).
import { host } from '../../host.js'
import type { Dyn, ProcessCore } from '../types.js'
import { encodeRequestHead, headerValue, ResponseParser } from './http1.js'
import type { NetStats } from './socket.js'

export interface ExchangeInit {
  method: string
  headers: [string, string][]
  body?: Uint8Array | null
  signal?: AbortSignal | null
}
export type TransportFetch = (url: string, init: ExchangeInit) => Promise<Response>

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304])
const abortError = (signal?: AbortSignal | null): unknown => signal?.reason ?? new host.DOMException('This operation was aborted', 'AbortError')
const fetchFailed = (cause: unknown): TypeError => Object.assign(new TypeError('fetch failed'), { cause })

function makeResponse(url: string, status: number, statusText: string, headers: [string, string][], body: ReadableStream<Uint8Array> | null): Response {
  const res = new host.Response(NULL_BODY_STATUS.has(status) ? null : body, { status, statusText, headers })
  Object.defineProperty(res, 'url', { value: url })
  return res
}

interface Deps {
  core: ProcessCore
  net: Dyn
  tls: Dyn
  stats: NetStats
}

export function createFetch({ core, net, tls }: Deps): { fetch: (input: Dyn, init?: Dyn) => Promise<Response>; transportFetch: TransportFetch } {
  const { kernel, live, track } = core

  /** One exchange through the app (proxy plain mode). */
  function brokerFetch(url: string, init: ExchangeInit): Promise<Response> {
    return new Promise((resolve, reject) => {
      if (init.signal?.aborted) return reject(abortError(init.signal))
      let controller!: ReadableStreamDefaultController<Uint8Array>
      let settled = false
      const quiet = (fn: () => void): void => {
        try {
          fn()
        } catch {
          // the body stream was cancelled by the reader
        }
      }
      const body = new host.ReadableStream<Uint8Array>({ start: (c) => void (controller = c), cancel: () => exchange.abort() })
      // Bodies arrive decoded, so the request must not negotiate a content coding the guest would then try to undo.
      const headers = init.headers.filter(([k]) => k.toLowerCase() !== 'accept-encoding')
      headers.push(['accept-encoding', 'identity'])
      const exchange = kernel.net.openHttp(
        { url, method: init.method, headers, body: init.body && init.body.length > 0 ? init.body : null },
        {
          body: (chunk) => quiet(() => controller.enqueue(chunk)),
          end: () => quiet(() => controller.close()),
          abort: (error) => quiet(() => controller.error(fetchFailed(new Error(error ?? 'aborted')))),
        },
      )
      init.signal?.addEventListener(
        'abort',
        () => {
          exchange.abort()
          if (!settled) reject(abortError(init.signal))
          else quiet(() => controller.error(abortError(init.signal)))
        },
        { once: true },
      )
      exchange.response.then(
        (head) => {
          settled = true
          const drop = new Set(['content-encoding', 'content-length', 'transfer-encoding'])
          resolve(makeResponse(url, head.status, '', head.headers.filter(([k]) => !drop.has(k.toLowerCase())), init.method === 'HEAD' ? null : body))
        },
        (e) => {
          settled = true
          reject(fetchFailed(e))
        },
      )
    })
  }

  /** One exchange spoken over a socket (tunnel mode). The connection is not reused. */
  function socketFetch(url: string, init: ExchangeInit): Promise<Response> {
    return new Promise((resolve, reject) => {
      if (init.signal?.aborted) return reject(abortError(init.signal))
      const u = new host.URL(url)
      const secure = u.protocol === 'https:'
      const port = Number(u.port || (secure ? 443 : 80))
      const host = u.hostname.replace(/^\[|\]$/g, '')
      const sock: Dyn = secure ? tls.connect({ host, port, servername: host, ALPNProtocols: ['http/1.1'] }) : net.connect({ host, port })
      let controller!: ReadableStreamDefaultController<Uint8Array>
      let settled = false
      let finished = false
      const quiet = (fn: () => void): void => {
        try {
          fn()
        } catch {
          // the body stream was cancelled by the reader
        }
      }
      const fail = (e: unknown): void => {
        if (finished) return
        finished = true
        if (!settled) {
          settled = true
          reject(e)
        } else quiet(() => controller.error(e))
        sock.destroy()
      }
      const raw = new host.ReadableStream<Uint8Array>({ start: (c) => void (controller = c), cancel: () => sock.destroy() })
      const parser = new ResponseParser(init.method, {
        head(head) {
          settled = true
          const coding = (headerValue(head.headers, 'content-encoding') ?? '').toLowerCase().trim()
          const drop = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive'])
          let body: ReadableStream<Uint8Array> = raw
          if (coding === 'gzip' || coding === 'x-gzip' || coding === 'deflate') {
            body = raw.pipeThrough(new host.DecompressionStream(coding === 'deflate' ? 'deflate' : 'gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
            drop.add('content-encoding')
          }
          resolve(makeResponse(url, head.status, head.statusText, head.headers.filter(([k]) => !drop.has(k.toLowerCase())), init.method === 'HEAD' ? null : body))
        },
        body: (chunk) => quiet(() => controller.enqueue(chunk.slice())),
        end() {
          finished = true
          quiet(() => controller.close())
          sock.destroy()
        },
      })
      const body = init.body && init.body.length > 0 ? init.body : null
      const reserved = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding'])
      const headers: [string, string][] = [['host', u.host], ['connection', 'close'], ['accept-encoding', 'gzip, deflate']]
      for (const h of init.headers) if (!reserved.has(h[0].toLowerCase())) headers.push(h)
      if (body || !['GET', 'HEAD'].includes(init.method)) headers.push(['content-length', String(body ? body.length : 0)])
      sock.on(secure ? 'secureConnect' : 'connect', () => {
        sock.write(encodeRequestHead(init.method, (u.pathname || '/') + u.search, headers))
        if (body) sock.write(body)
      })
      sock.on('data', (d: Uint8Array) => {
        try {
          parser.push(d)
        } catch (e) {
          fail(fetchFailed(e))
        }
      })
      sock.on('end', () => {
        if (!parser.eof()) fail(fetchFailed(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })))
      })
      sock.on('error', (e: unknown) => fail(fetchFailed(e)))
      sock.on('close', () => {
        if (!parser.complete) fail(fetchFailed(Object.assign(new Error('socket closed before the response was complete'), { code: 'ECONNRESET' })))
      })
      init.signal?.addEventListener('abort', () => fail(abortError(init.signal)), { once: true })
    })
  }

  const transportFetch: TransportFetch = (url, init) => {
    if (kernel.netMode === 'http') return brokerFetch(url, init)
    if (kernel.netMode === 'tunnel') return socketFetch(url, init)
    track('fetch with networking disabled', url)
    return Promise.reject(fetchFailed(new Error('networking is disabled')))
  }

  function dataUrlResponse(url: string): Response {
    const comma = url.indexOf(',')
    if (comma === -1) throw new TypeError('fetch failed: malformed data: URL')
    const meta = url.slice(5, comma)
    const base64 = /;base64$/i.test(meta)
    const type = meta.replace(/;base64$/i, '') || 'text/plain;charset=US-ASCII'
    const text = decodeURIComponent(url.slice(comma + 1))
    const bytes = base64 ? Uint8Array.from(atob(text), (c) => c.charCodeAt(0)) : new host.TextEncoder().encode(text)
    return new host.Response(bytes, { status: 200, headers: { 'content-type': type } })
  }

  /** The global `fetch` a Node program starts with (until it installs its own, as pi does with undici). */
  async function fetch(input: Dyn, init: Dyn = {}): Promise<Response> {
    // A Request made by the guest's own fetch implementation is not the platform's; read both structurally.
    const isRequest = typeof input === 'object' && input !== null && typeof input.url === 'string' && typeof input.method === 'string'
    let url: string = isRequest ? input.url : String(input)
    let method: string = (init.method || (isRequest ? input.method : 'GET')).toUpperCase()
    const headers = new host.Headers(init.headers || (isRequest ? input.headers : undefined))
    const rawBody: Dyn = init.body !== undefined ? init.body : isRequest ? input.body : undefined
    const signal: AbortSignal | undefined = init.signal || (isRequest ? input.signal : undefined)
    const redirect: string = init.redirect || (isRequest ? input.redirect : 'follow')
    if (url.startsWith('data:')) return dataUrlResponse(url)
    if (!/^https?:/i.test(url)) throw new TypeError(`fetch failed: unsupported URL scheme in ${url.slice(0, 40)}`)

    let body: Uint8Array | null = null
    if (typeof rawBody === 'string') {
      if (!headers.has('content-type')) headers.set('content-type', 'text/plain;charset=UTF-8')
      body = new host.TextEncoder().encode(rawBody)
    } else if (rawBody instanceof URLSearchParams) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8')
      body = new host.TextEncoder().encode(rawBody.toString())
    } else if (rawBody instanceof ArrayBuffer) body = new Uint8Array(rawBody)
    else if (ArrayBuffer.isView(rawBody)) body = new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength)
    else if (rawBody != null) {
      // Blob, FormData, ReadableStream: let the platform serialise it. The request body is buffered.
      const r = new host.Response(rawBody)
      const type = r.headers.get('content-type')
      if (type && !headers.has('content-type')) headers.set('content-type', type)
      body = new Uint8Array(await r.arrayBuffer())
    }

    // The request holds the process open until its response body has been read to the end or cancelled, as a socket would.
    live.ref()
    let released = false
    const release = (): void => {
      if (!released) {
        released = true
        live.unref()
      }
    }
    try {
      let res: Response
      for (let hops = 0; ; hops++) {
        res = await transportFetch(url, { method, headers: [...headers], body, signal })
        const location = res.headers.get('location')
        if (redirect === 'manual' || ![301, 302, 303, 307, 308].includes(res.status) || !location) break
        if (redirect === 'error') throw fetchFailed(new Error('unexpected redirect'))
        if (hops >= 20) throw fetchFailed(new Error('redirect count exceeded'))
        void res.body?.cancel()
        const next = new host.URL(location, url)
        if (next.origin !== new host.URL(url).origin) for (const h of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(h)
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET'
          body = null
          for (const h of ['content-type', 'content-length']) headers.delete(h)
        }
        url = next.href
      }
      if (!res.body) {
        release()
        return res
      }
      const reader = res.body.getReader()
      const tracked = new host.ReadableStream<Uint8Array>({
        async pull(c) {
          try {
            const { done, value } = await reader.read()
            if (done) {
              release()
              c.close()
            } else c.enqueue(value)
          } catch (e) {
            release()
            c.error(e)
          }
        },
        cancel(reason) {
          release()
          return reader.cancel(reason)
        },
      })
      signal?.addEventListener('abort', release, { once: true })
      const out = new host.Response(tracked, { status: res.status, statusText: res.statusText, headers: res.headers })
      Object.defineProperty(out, 'url', { value: url })
      Object.defineProperty(out, 'redirected', { value: url !== (isRequest ? input.url : String(input)) })
      return out
    } catch (e) {
      release()
      throw e
    }
  }
  return { fetch, transportFetch }
}
