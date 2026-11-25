// The socket-level HTTP bridge used in 'http' mode. It sits behind a net.Socket: the guest's HTTP client writes
// HTTP/1.1 requests into the socket, the bridge has each one performed through the broker (`http.open`), and
// writes an HTTP/1.1 response back into the socket as the body streams in. Requests on one connection are
// answered in order (pipelining); request bodies are buffered; responses are re-framed as chunked.
import type { HttpExchange, NetBroker } from '../../kernel/net.js'
import { encodeChunk, encodeResponseHead, headerValue, LAST_CHUNK, type ParsedRequest, RequestParser, STATUS_TEXT } from './http1.js'

/** Request headers that describe the guest's connection to the bridge, not the request the proxy will make. */
const DROP_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'expect', 'accept-encoding'])

export interface HttpBridgeOptions {
  scheme: 'http' | 'https'
  host: string
  port: number
  broker: NetBroker
  stats?: { bridgeRequests: number }
  /** Bytes for the guest to read from the socket. */
  push(chunk: Uint8Array): void
  /** The exchange failed; the socket should be reset. */
  fail(message: string): void
}

export class HttpBridge {
  private readonly parser: RequestParser
  private readonly queue: ParsedRequest[] = []
  private busy = false
  private dead = false
  private exchange: HttpExchange | null = null

  constructor(private readonly opts: HttpBridgeOptions) {
    this.parser = new RequestParser((request) => {
      this.queue.push(request)
      this.pump()
    })
  }

  /** Bytes the guest wrote to the socket. */
  write(chunk: Uint8Array): void {
    if (this.dead) return
    try {
      this.parser.push(chunk)
    } catch (e) {
      this.dead = true
      this.opts.fail(e instanceof Error ? e.message : String(e))
    }
  }
  destroy(): void {
    this.dead = true
    this.exchange?.abort()
    this.exchange = null
  }

  /** The absolute URL a request on this connection is for. */
  urlFor(request: ParsedRequest): string {
    if (/^https?:\/\//i.test(request.target)) return request.target
    const defaultPort = this.opts.scheme === 'https' ? 443 : 80
    const authority = headerValue(request.headers, 'host') ?? (this.opts.port === defaultPort ? this.opts.host : `${this.opts.host}:${this.opts.port}`)
    return `${this.opts.scheme}://${authority}${request.target}`
  }

  private pump(): void {
    if (this.busy || this.dead) return
    const request = this.queue.shift()
    if (!request) return
    this.busy = true
    if (this.opts.stats) this.opts.stats.bridgeRequests++
    const { push, fail } = this.opts
    let started = false
    const done = (): void => {
      this.busy = false
      this.exchange = null
      this.pump()
    }
    // The app hands the body over decoded, so the guest must not be told it is compressed, and must not ask for it.
    const headers = request.headers.filter(([k]) => !DROP_REQUEST_HEADERS.has(k.toLowerCase()))
    headers.push(['accept-encoding', 'identity'])
    let bodiless = false
    // Body events can outrun the head (a broker may deliver both in one task); hold them until the head is written.
    const early: Uint8Array[] = []
    let endedEarly = false
    const finish = (): void => {
      if (!bodiless) push(LAST_CHUNK)
      done()
    }
    const exchange = this.opts.broker.openHttp(
      { url: this.urlFor(request), method: request.method, headers, body: request.body.length > 0 ? request.body : null },
      {
        body: (chunk) => {
          if (this.dead || chunk.length === 0) return
          if (!started) early.push(chunk)
          else if (!bodiless) push(encodeChunk(chunk))
        },
        end: () => {
          if (this.dead) return
          if (!started) endedEarly = true
          else finish()
        },
        abort: (error) => {
          if (this.dead) return
          this.dead = true
          fail('proxied request failed' + (error ? ': ' + error : ''))
        },
      },
    )
    this.exchange = exchange
    exchange.response.then(
      (head) => {
        if (this.dead) return
        started = true
        bodiless = request.method === 'HEAD' || head.status === 204 || head.status === 304
        push(encodeResponseHead({ status: head.status, statusText: STATUS_TEXT[head.status] ?? '', headers: head.headers }, !bodiless))
        if (!bodiless) for (const chunk of early) push(encodeChunk(chunk))
        if (endedEarly) finish()
      },
      (e: Error) => {
        if (this.dead) return
        this.dead = true
        fail('proxied request failed: ' + e.message)
      },
    )
  }
}
