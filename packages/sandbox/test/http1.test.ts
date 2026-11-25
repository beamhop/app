import { describe, expect, it } from 'vitest'
import type { HttpExchange, HttpRequestInit, HttpResponseEvents, NetBroker } from '../src/kernel/net.js'
import { NetError } from '../src/kernel/net.js'
import { HttpBridge } from '../src/node/net/http-bridge.js'
import { encodeChunk, encodeRequestHead, encodeResponseHead, HttpParseError, LAST_CHUNK, type ParsedRequest, RequestParser, type ResponseHead, ResponseParser } from '../src/node/net/http1.js'
import { bytes, text } from './helpers.js'

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
/** Feed `data` to `push` in pieces of `size` bytes. */
const feed = (data: Uint8Array, size: number, push: (chunk: Uint8Array) => void): void => {
  for (let i = 0; i < data.length; i += size) push(data.slice(i, i + size))
}

describe('RequestParser', () => {
  const wire = bytes(
    'POST /v1/chat/completions?x=1 HTTP/1.1\r\nHost: api.example.com\r\nContent-Type: application/json\r\nContent-Length: 12\r\n\r\n{"a":"b\r\nc"}' +
      'GET /second HTTP/1.1\r\nhost: api.example.com\r\n\r\n' +
      'PUT /chunked HTTP/1.1\r\nTransfer-Encoding: chunked\r\nX-Multi: a: b\r\n\r\n5\r\nhello\r\n6;ext=1\r\n world\r\n0\r\nTrailer: t\r\n\r\n',
  )
  const expected = [
    { method: 'POST', target: '/v1/chat/completions?x=1', headers: [['Host', 'api.example.com'], ['Content-Type', 'application/json'], ['Content-Length', '12']], body: '{"a":"b\r\nc"}' },
    { method: 'GET', target: '/second', headers: [['host', 'api.example.com']], body: '' },
    { method: 'PUT', target: '/chunked', headers: [['Transfer-Encoding', 'chunked'], ['X-Multi', 'a: b']], body: 'hello world' },
  ]

  it('parses pipelined requests with content-length and chunked bodies, however the bytes are split', () => {
    for (const size of [1, 2, 3, 7, 64, wire.length]) {
      const seen: ParsedRequest[] = []
      const parser = new RequestParser((r) => seen.push(r))
      feed(wire, size, (c) => parser.push(c))
      expect(seen.map((r) => ({ ...r, body: text(r.body) }))).toEqual(expected)
    }
  })

  it('reports a request only when its body is complete', () => {
    const seen: ParsedRequest[] = []
    const parser = new RequestParser((r) => seen.push(r))
    parser.push(bytes('POST / HTTP/1.1\r\ncontent-length: 4\r\n\r\nab'))
    expect(seen).toHaveLength(0)
    parser.push(bytes('cd'))
    expect(text(seen[0].body)).toBe('abcd')
  })

  it('rejects input that is not HTTP/1.1', () => {
    expect(() => new RequestParser(() => {}).push(bytes('\x16\x03\x01\x02\x00\x01\x00\r\n\r\n'))).toThrow(HttpParseError)
    expect(() => new RequestParser(() => {}).push(bytes('GET / HTTP/1.1\r\nbroken header\r\n\r\n'))).toThrow('malformed header')
    expect(() => new RequestParser(() => {}).push(bytes('POST / HTTP/1.1\r\ntransfer-encoding: chunked\r\n\r\nzz\r\n'))).toThrow('bad chunk size')
    expect(() => new RequestParser(() => {}).push(bytes('GET / HTTP/1.1\r\n' + 'x: ' + 'y'.repeat(300_000)))).toThrow('too large')
  })
})

describe('ResponseParser', () => {
  const parse = (method: string, wire: Uint8Array, size: number, eof = false) => {
    const out = { head: null as ResponseHead | null, body: '', ended: false }
    const parser = new ResponseParser(method, { head: (h) => (out.head = h), body: (c) => (out.body += text(c)), end: () => (out.ended = true) })
    feed(wire, size, (c) => parser.push(c))
    const clean = eof ? parser.eof() : null
    return { ...out, clean, complete: parser.complete }
  }

  it('reads chunked, content-length and close-delimited bodies at any split', () => {
    const chunked = bytes('HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n6\r\ndata: \r\n3\r\n1\n\n\r\n0\r\n\r\n')
    const length = bytes('HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nnot found')
    const close = bytes('HTTP/1.0 200 OK\r\n\r\nuntil the end')
    for (const size of [1, 5, 1000]) {
      expect(parse('GET', chunked, size)).toMatchObject({ head: { status: 200, statusText: 'OK', headers: [['content-type', 'text/event-stream'], ['transfer-encoding', 'chunked']] }, body: 'data: 1\n\n', ended: true })
      expect(parse('GET', length, size)).toMatchObject({ head: { status: 404, statusText: 'Not Found' }, body: 'not found', ended: true })
      expect(parse('GET', close, size)).toMatchObject({ body: 'until the end', ended: false })
      expect(parse('GET', close, size, true)).toMatchObject({ body: 'until the end', ended: true, clean: true })
    }
  })

  it('handles bodiless responses, interim responses and truncation', () => {
    expect(parse('HEAD', bytes('HTTP/1.1 200 OK\r\ncontent-length: 500\r\n\r\n'), 9)).toMatchObject({ body: '', ended: true })
    expect(parse('GET', bytes('HTTP/1.1 204 No Content\r\n\r\n'), 9)).toMatchObject({ head: { status: 204 }, ended: true })
    expect(parse('POST', bytes('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\ncontent-length: 2\r\n\r\nok'), 4)).toMatchObject({ head: { status: 201 }, body: 'ok', ended: true })
    expect(parse('GET', bytes('HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nshort'), 100, true)).toMatchObject({ body: 'short', ended: false, clean: false })
    expect(() => parse('GET', bytes('SSH-2.0-OpenSSH\r\n\r\n'), 100)).toThrow(HttpParseError)
  })
})

describe('encoders', () => {
  it('writes a response a parser reads back, re-framed as chunked without the upstream framing headers', () => {
    const head = encodeResponseHead({ status: 200, statusText: '', headers: [['Content-Type', 'text/plain'], ['Content-Length', '999'], ['Content-Encoding', 'gzip'], ['Set-Cookie', 'a=1'], ['Set-Cookie', 'b=2'], ['X-Evil', 'a\r\nInjected: 1']] }, true)
    expect(text(head)).toBe('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nX-Evil: a  Injected: 1\r\ntransfer-encoding: chunked\r\n\r\n')
    const out = { body: '', ended: false }
    const parser = new ResponseParser('GET', { head: () => {}, body: (c) => (out.body += text(c)), end: () => (out.ended = true) })
    parser.push(concat(head, encodeChunk(bytes('one ')), encodeChunk(bytes('two')), LAST_CHUNK))
    expect(out).toEqual({ body: 'one two', ended: true })
    expect(text(encodeResponseHead({ status: 304, statusText: '', headers: [] }, false))).toBe('HTTP/1.1 304 Not Modified\r\ncontent-length: 0\r\n\r\n')
    expect(text(encodeRequestHead('GET', '/p?q', [['host', 'h'], ['x', 'y']]))).toBe('GET /p?q HTTP/1.1\r\nhost: h\r\nx: y\r\n\r\n')
  })
})

describe('HttpBridge (the plain-proxy path behind a socket)', () => {
  interface Call {
    request: HttpRequestInit
    events: HttpResponseEvents
    respond(status: number, headers?: [string, string][]): void
    fail(error: NetError): void
    aborted: boolean
  }
  const setup = (scheme: 'http' | 'https' = 'http', port = 8080) => {
    const calls: Call[] = []
    const broker: NetBroker = {
      openSocket: () => {
        throw new Error('the bridge must not open sockets')
      },
      openHttp(request, events): HttpExchange {
        let respond!: Call['respond']
        let fail!: Call['fail']
        const response = new Promise<{ status: number; headers: [string, string][] }>((resolve, reject) => {
          respond = (status, headers = []) => resolve({ status, headers })
          fail = reject
        })
        const call: Call = { request, events, respond, fail, aborted: false }
        calls.push(call)
        return { response, abort: () => void (call.aborted = true) }
      },
    }
    const socket = { read: '', failure: null as string | null }
    const bridge = new HttpBridge({ scheme, host: 'api.example.com', port, broker, push: (c) => (socket.read += text(c)), fail: (m) => (socket.failure = m) })
    return { calls, socket, bridge }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('turns a written request into one exchange and streams the response back as HTTP/1.1', async () => {
    const { calls, socket, bridge } = setup()
    bridge.write(bytes('POST /v1/x?y=1 HTTP/1.1\r\nhost: api.example.com:8080\r\nauthorization: Bearer k\r\nconnection: keep-alive\r\naccept-encoding: gzip, br\r\ncontent-length: 2\r\n\r\n{}'))
    expect(calls).toHaveLength(1)
    expect(calls[0].request).toEqual({ url: 'http://api.example.com:8080/v1/x?y=1', method: 'POST', headers: [['authorization', 'Bearer k'], ['accept-encoding', 'identity']], body: bytes('{}') })
    calls[0].respond(200, [['content-type', 'text/event-stream'], ['content-length', '12']])
    await tick()
    expect(socket.read).toBe('HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n')
    calls[0].events.body(bytes('data: 1\n\n'))
    expect(socket.read.endsWith('9\r\ndata: 1\n\n\r\n')).toBe(true) // delivered as it arrives, not at the end
    calls[0].events.end()
    expect(socket.read.endsWith('0\r\n\r\n')).toBe(true)
    expect(socket.failure).toBeNull()
  })

  it('answers pipelined requests one at a time, in order', async () => {
    const { calls, socket, bridge } = setup()
    bridge.write(bytes('GET /a HTTP/1.1\r\nhost: h\r\n\r\nGET /b HTTP/1.1\r\nhost: h\r\n\r\n'))
    expect(calls.map((c) => c.request.url)).toEqual(['http://h/a'])
    calls[0].respond(204)
    await tick()
    calls[0].events.end()
    expect(calls.map((c) => c.request.url)).toEqual(['http://h/a', 'http://h/b'])
    calls[1].respond(200)
    await tick()
    calls[1].events.body(bytes('B'))
    calls[1].events.end()
    expect(socket.read).toBe('HTTP/1.1 204 No Content\r\ncontent-length: 0\r\n\r\nHTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n1\r\nB\r\n0\r\n\r\n')
  })

  it('builds the URL from scheme, default port and Host header, and holds body events that outrun the head', async () => {
    const tls = setup('https', 443)
    tls.bridge.write(bytes('HEAD /p HTTP/1.1\r\n\r\n'))
    expect(tls.calls[0].request).toMatchObject({ url: 'https://api.example.com/p', method: 'HEAD', body: null })
    const early = setup()
    early.bridge.write(bytes('GET / HTTP/1.1\r\nhost: h\r\n\r\n'))
    early.calls[0].respond(200)
    early.calls[0].events.body(bytes('early')) // same task as the response: the head has not been written yet
    early.calls[0].events.end()
    await tick()
    expect(early.socket.read).toBe('HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nearly\r\n0\r\n\r\n')
  })

  it('resets the socket when the exchange fails, is refused, or the guest writes something that is not HTTP', async () => {
    const refused = setup()
    refused.bridge.write(bytes('GET / HTTP/1.1\r\nhost: evil.example\r\n\r\n'))
    refused.calls[0].fail(new NetError('policy', 'destination not allowed'))
    await tick()
    expect(refused.socket.failure).toBe('proxied request failed: destination not allowed')
    const cut = setup()
    cut.bridge.write(bytes('GET / HTTP/1.1\r\nhost: h\r\n\r\n'))
    cut.calls[0].respond(200)
    await tick()
    cut.calls[0].events.abort('upstream reset')
    expect(cut.socket.failure).toBe('proxied request failed: upstream reset')
    const garbage = setup()
    garbage.bridge.write(bytes('\x16\x03\x01 not http\r\n\r\n'))
    expect(garbage.socket.failure).toContain('HTTP parse error')
    const destroyed = setup()
    destroyed.bridge.write(bytes('GET / HTTP/1.1\r\nhost: h\r\n\r\n'))
    destroyed.bridge.destroy()
    expect(destroyed.calls[0].aborted).toBe(true)
  })
})
