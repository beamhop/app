// HTTP/1.1 wire format, both directions, over plain byte arrays. No I/O and no Node types, so it is easy to test:
//  - RequestParser reads the requests a client wrote to a socket (the plain-proxy bridge),
//  - ResponseParser reads a server's response from a socket (fetch over the tunnel),
//  - the encoders write a response head and chunked body (what the bridge feeds back into the socket).

export class HttpParseError extends Error {
  readonly code = 'HPE_INVALID'
  constructor(message: string) {
    super('HTTP parse error: ' + message)
  }
}

const CR = 13
const LF = 10
const MAX_HEAD_BYTES = 256 * 1024
const latin1 = (bytes: Uint8Array): string => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return s
}
const ascii = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

/** A growing byte buffer consumed from the front. */
class ByteQueue {
  private buf: Uint8Array = new Uint8Array(0)
  get length(): number {
    return this.buf.length
  }
  push(chunk: Uint8Array): void {
    if (this.buf.length === 0) this.buf = chunk
    else {
      const merged = new Uint8Array(this.buf.length + chunk.length)
      merged.set(this.buf)
      merged.set(chunk, this.buf.length)
      this.buf = merged
    }
  }
  take(n: number): Uint8Array {
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return out
  }
  /** Index of the first CRLF, or -1. */
  indexOfCrlf(): number {
    for (let i = this.buf.indexOf(CR); i !== -1 && i < this.buf.length - 1; i = this.buf.indexOf(CR, i + 1)) if (this.buf[i + 1] === LF) return i
    return -1
  }
  /** Index of the blank line ending a header block (CRLF CRLF), or -1. */
  indexOfHeadEnd(): number {
    for (let i = this.buf.indexOf(CR); i !== -1 && i < this.buf.length - 3; i = this.buf.indexOf(CR, i + 1)) {
      if (this.buf[i + 1] === LF && this.buf[i + 2] === CR && this.buf[i + 3] === LF) return i
    }
    return -1
  }
}

function parseHeaderLines(lines: string[]): [string, string][] {
  const headers: [string, string][] = []
  for (const line of lines) {
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon <= 0) throw new HttpParseError('malformed header line')
    headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()])
  }
  return headers
}
export const headerValue = (headers: [string, string][], name: string): string | undefined => headers.find(([k]) => k.toLowerCase() === name)?.[1]

/** Shared body framing: Content-Length, chunked, or (responses only) until the connection closes. */
type BodyState = { mode: 'none' } | { mode: 'length'; remaining: number } | { mode: 'chunk-size' } | { mode: 'chunk-data'; remaining: number } | { mode: 'chunk-end' } | { mode: 'trailer' } | { mode: 'close' }

/** Feeds body bytes to `onData`; returns true when the message is complete. */
function readBody(q: ByteQueue, state: BodyState, onData: (chunk: Uint8Array) => void, set: (s: BodyState) => void): boolean {
  for (;;) {
    switch (state.mode) {
      case 'none':
        return true
      case 'length': {
        if (state.remaining === 0) return true
        if (q.length === 0) return false
        const chunk = q.take(Math.min(q.length, state.remaining))
        state.remaining -= chunk.length
        onData(chunk)
        break
      }
      case 'chunk-size': {
        const i = q.indexOfCrlf()
        if (i === -1) return false
        const size = parseInt(latin1(q.take(i + 2)).split(';')[0].trim(), 16)
        if (!Number.isFinite(size) || size < 0) throw new HttpParseError('bad chunk size')
        set((state = size === 0 ? { mode: 'trailer' } : { mode: 'chunk-data', remaining: size }))
        break
      }
      case 'chunk-data': {
        if (q.length === 0) return false
        const chunk = q.take(Math.min(q.length, state.remaining))
        state.remaining -= chunk.length
        onData(chunk)
        if (state.remaining === 0) set((state = { mode: 'chunk-end' }))
        break
      }
      case 'chunk-end':
        if (q.length < 2) return false
        q.take(2)
        set((state = { mode: 'chunk-size' }))
        break
      case 'trailer': {
        const i = q.indexOfCrlf()
        if (i === -1) return false
        if (q.take(i + 2).length === 2) return true // the empty line after any trailers
        break
      }
      case 'close':
        if (q.length === 0) return false
        onData(q.take(q.length))
        return false
    }
  }
}

export interface ParsedRequest {
  method: string
  target: string
  headers: [string, string][]
  body: Uint8Array
}

/** Parses a stream of pipelined HTTP/1.1 requests. Each complete request (body included) is reported once. */
export class RequestParser {
  private readonly q = new ByteQueue()
  private current: { method: string; target: string; headers: [string, string][]; chunks: Uint8Array[] } | null = null
  private body: BodyState = { mode: 'none' }
  constructor(private readonly onRequest: (request: ParsedRequest) => void) {}

  push(chunk: Uint8Array): void {
    this.q.push(chunk)
    for (;;) {
      if (!this.current) {
        const end = this.q.indexOfHeadEnd()
        if (end === -1) {
          if (this.q.length > MAX_HEAD_BYTES) throw new HttpParseError('request head too large')
          return
        }
        const lines = latin1(this.q.take(end + 4)).split('\r\n')
        const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0])
        if (!m) throw new HttpParseError('malformed request line')
        const headers = parseHeaderLines(lines.slice(1))
        this.current = { method: m[1], target: m[2], headers, chunks: [] }
        if ((headerValue(headers, 'transfer-encoding') ?? '').toLowerCase().includes('chunked')) this.body = { mode: 'chunk-size' }
        else {
          const length = Number(headerValue(headers, 'content-length') ?? 0)
          if (!Number.isInteger(length) || length < 0) throw new HttpParseError('bad content-length')
          this.body = length > 0 ? { mode: 'length', remaining: length } : { mode: 'none' }
        }
      }
      const cur = this.current
      if (!readBody(this.q, this.body, (c) => cur.chunks.push(c), (s) => (this.body = s))) return
      this.current = null
      let total = 0
      for (const c of cur.chunks) total += c.length
      const body = new Uint8Array(total)
      let at = 0
      for (const c of cur.chunks) {
        body.set(c, at)
        at += c.length
      }
      this.onRequest({ method: cur.method, target: cur.target, headers: cur.headers, body })
    }
  }
}

export interface ResponseHead {
  status: number
  statusText: string
  headers: [string, string][]
}
export interface ResponseHandlers {
  head(head: ResponseHead): void
  body(chunk: Uint8Array): void
  end(): void
}

/** Parses one HTTP/1.1 response. Interim 1xx responses are skipped. */
export class ResponseParser {
  private readonly q = new ByteQueue()
  private body: BodyState | null = null
  private done = false
  constructor(
    private readonly method: string,
    private readonly handlers: ResponseHandlers,
  ) {}

  get complete(): boolean {
    return this.done
  }
  push(chunk: Uint8Array): void {
    if (this.done) return
    this.q.push(chunk)
    while (!this.body) {
      const end = this.q.indexOfHeadEnd()
      if (end === -1) {
        if (this.q.length > MAX_HEAD_BYTES) throw new HttpParseError('response head too large')
        return
      }
      const lines = latin1(this.q.take(end + 4)).split('\r\n')
      const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0])
      if (!m) throw new HttpParseError('malformed status line')
      const status = Number(m[1])
      if (status >= 100 && status < 200 && status !== 101) continue
      const headers = parseHeaderLines(lines.slice(1))
      const length = headerValue(headers, 'content-length')
      if (this.method === 'HEAD' || status === 204 || status === 304) this.body = { mode: 'none' }
      else if ((headerValue(headers, 'transfer-encoding') ?? '').toLowerCase().includes('chunked')) this.body = { mode: 'chunk-size' }
      else if (length !== undefined) this.body = { mode: 'length', remaining: Number(length) || 0 }
      else this.body = { mode: 'close' }
      this.handlers.head({ status, statusText: m[2] ?? '', headers })
    }
    if (readBody(this.q, this.body, this.handlers.body, (s) => (this.body = s))) this.finish()
  }
  /** The connection closed. Completes a read-until-close body; returns false if the response was cut short. */
  eof(): boolean {
    if (this.done) return true
    if (this.body?.mode === 'close') {
      this.finish()
      return true
    }
    return false
  }
  private finish(): void {
    this.done = true
    this.handlers.end()
  }
}

export const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
  304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict', 413: 'Payload Too Large', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
}

/** Headers that describe the transport framing of a hop, not the message; dropped when a response is re-framed. */
const HOP_BY_HOP = new Set(['content-length', 'transfer-encoding', 'content-encoding', 'connection', 'keep-alive'])

/** A response head for a body that will follow as chunks (or not at all). */
export function encodeResponseHead(head: ResponseHead, hasBody: boolean): Uint8Array {
  let text = `HTTP/1.1 ${head.status} ${head.statusText || STATUS_TEXT[head.status] || 'Unknown'}\r\n`
  for (const [k, v] of head.headers) if (!HOP_BY_HOP.has(k.toLowerCase())) text += `${k}: ${v.replace(/[\r\n]/g, ' ')}\r\n`
  text += hasBody ? 'transfer-encoding: chunked\r\n\r\n' : 'content-length: 0\r\n\r\n'
  return ascii(text)
}
export function encodeChunk(data: Uint8Array): Uint8Array {
  const size = ascii(data.length.toString(16) + '\r\n')
  const out = new Uint8Array(size.length + data.length + 2)
  out.set(size)
  out.set(data, size.length)
  out[out.length - 2] = CR
  out[out.length - 1] = LF
  return out
}
export const LAST_CHUNK: Uint8Array = ascii('0\r\n\r\n')

/** A request head as a client would write it. */
export function encodeRequestHead(method: string, target: string, headers: [string, string][]): Uint8Array {
  let text = `${method} ${target} HTTP/1.1\r\n`
  for (const [k, v] of headers) text += `${k}: ${v.replace(/[\r\n]/g, ' ')}\r\n`
  return ascii(text + '\r\n')
}
