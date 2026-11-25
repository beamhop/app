// The Node layer's networking against in-memory brokers: no sockets, no servers.
import { describe, expect, it } from 'vitest'
import type { ByteTransport, NetBroker, SecureTransport, SocketChannel, SocketEvents, TlsConnector } from '../src/kernel/net.js'
import { NetError } from '../src/kernel/net.js'
import { createMachine } from '../src/machine.js'
import { transformEsm } from '../src/esm/transform.js'
import { encodeChunk, LAST_CHUNK, type ParsedRequest, RequestParser } from '../src/node/net/http1.js'
import { bytes, run, text, write } from './helpers.js'

type Handler = (req: ParsedRequest & { text: string }) => { status: number; headers?: [string, string][]; body?: Uint8Array | string; chunks?: string[] }

/** A broker whose "internet" is one function: an HTTP server reachable at any allowed host, over sockets or exchanges. */
function fakeNet(handler: Handler, allow = ['api.test:80', 'api.test:443']) {
  const log = { sockets: [] as string[], exchanges: [] as string[], halfClosed: 0 }
  const serve = (events: SocketEvents) => {
    const parser = new RequestParser((req) => {
      const res = handler({ ...req, text: text(req.body) })
      queueMicrotask(() => {
        // Written by hand: this is the origin server, and it may declare a content-encoding (the bridge's encoder drops it).
        events.data(bytes(`HTTP/1.1 ${res.status} X\r\n${(res.headers ?? []).map(([k, v]) => `${k}: ${v}\r\n`).join('')}transfer-encoding: chunked\r\n\r\n`))
        for (const c of res.chunks ?? [res.body ?? '']) if (c.length) events.data(encodeChunk(typeof c === 'string' ? bytes(c) : c))
        events.data(LAST_CHUNK)
      })
    })
    return (chunk: Uint8Array) => parser.push(chunk)
  }
  const broker: NetBroker = {
    openSocket(host, port, events): SocketChannel {
      log.sockets.push(`${host}:${port}`)
      if (host === 'nxdomain.test') return { opened: rejected(new NetError('dns', 'no such host')), write() {}, end() {}, close() {} }
      if (!allow.includes(`${host}:${port}`)) return { opened: rejected(new NetError('policy', 'destination not allowed')), write() {}, end() {}, close() {} }
      const receive = serve(events)
      // Like a server that closes once the client has finished sending.
      const end = (): void => {
        log.halfClosed++
        queueMicrotask(() => (events.end(), events.close()))
      }
      return { opened: Promise.resolve(), write: (c) => receive(c), end, close() {} }
    },
    openHttp(request, events) {
      log.exchanges.push(`${request.method} ${request.url}`)
      const url = new URL(request.url)
      if (!allow.includes(`${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`)) return { response: rejected(new NetError('policy', 'destination not allowed')), abort() {} }
      const res = handler({ method: request.method, target: url.pathname + url.search, headers: request.headers, body: request.body ?? new Uint8Array(0), text: text(request.body ?? new Uint8Array(0)) })
      queueMicrotask(() => {
        for (const c of res.chunks ?? [res.body ?? '']) if (c.length) events.body(typeof c === 'string' ? bytes(c) : c)
        events.end()
      })
      return { response: Promise.resolve({ status: res.status, headers: res.headers ?? [] }), abort() {} }
    },
  }
  return { broker, log }
}
function rejected<T>(error: Error): Promise<T> {
  const p = Promise.reject<T>(error)
  p.catch(() => {})
  return p
}
const machine = (broker: NetBroker, netMode: 'tunnel' | 'http', connectTls?: TlsConnector) => createMachine({ loadTransformer: () => transformEsm, net: broker, netMode, connectTls })

const echo: Handler = (req) => ({ status: 200, headers: [['content-type', 'application/json']], body: JSON.stringify({ method: req.method, target: req.target, body: req.text, auth: req.headers.find(([k]) => k.toLowerCase() === 'authorization')?.[1] }) })

describe('fetch', () => {
  const script = `
    const res = await fetch('http://api.test/v1/echo?q=1', { method: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify({ hi: 1 }) })
    console.log(res.status, res.headers.get('content-type'), JSON.stringify(await res.json()))
  `
  for (const netMode of ['tunnel', 'http'] as const) {
    it(`performs a request and reads the body in ${netMode} mode`, async () => {
      const { broker, log } = fakeNet(echo)
      const m = machine(broker, netMode)
      write(m, '/work/f.mjs', script)
      const r = await run(m, ['node', 'f.mjs'])
      expect(r.stderr).toBe('')
      expect(r.stdout).toBe('200 application/json {"method":"POST","target":"/v1/echo?q=1","body":"{\\"hi\\":1}","auth":"Bearer t"}\n')
      expect(log).toMatchObject(netMode === 'tunnel' ? { sockets: ['api.test:80'], exchanges: [] } : { sockets: [], exchanges: ['POST http://api.test/v1/echo?q=1'] })
    })
  }

  it('streams a response body chunk by chunk and keeps the process alive until it is consumed', async () => {
    const { broker } = fakeNet(() => ({ status: 200, chunks: ['data: 1\n\n', 'data: 2\n\n'] }))
    const m = machine(broker, 'tunnel')
    write(m, '/work/s.mjs', `
      const res = await fetch('http://api.test/stream')
      const seen = []
      for await (const chunk of res.body) seen.push(new TextDecoder().decode(chunk))
      setTimeout(() => console.log(JSON.stringify(seen)), 30)
    `)
    expect((await run(m, ['node', 's.mjs'])).stdout).toBe('["data: 1\\n\\n","data: 2\\n\\n"]\n')
  })

  it('follows redirects, decodes gzip over the tunnel, and reads data: URLs without the network', async () => {
    const gz = new Uint8Array(await new Response(new Blob(['compressed body']).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
    const { broker, log } = fakeNet((req) => {
      if (req.target === '/old') return { status: 302, headers: [['location', '/new']] }
      if (req.target === '/new') return { status: 200, headers: [['content-encoding', 'gzip']], body: gz }
      return { status: 404 }
    })
    const m = machine(broker, 'tunnel')
    write(m, '/work/r.mjs', `
      const res = await fetch('http://api.test/old')
      const manual = await fetch('http://api.test/old', { redirect: 'manual' })
      const data = await fetch('data:text/plain;base64,aGk=')
      console.log(res.status, res.redirected, res.url, await res.text(), res.headers.get('content-encoding'), manual.status, await data.text())
    `)
    const r = await run(m, ['node', 'r.mjs'])
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe('200 true http://api.test/new compressed body null 302 hi\n')
    expect(log.sockets).toHaveLength(3)
  })

  it('fails like Node when the destination is refused, unknown, or the network is off', async () => {
    const probe = `
      const attempt = (url) => fetch(url).then(() => 'ok', (e) => e.name + ':' + e.message + ':' + (e.cause && e.cause.code))
      console.log(await attempt('http://evil.test/'), await attempt('http://nxdomain.test/'))
    `
    const tunnel = machine(fakeNet(echo).broker, 'tunnel')
    write(tunnel, '/work/p.mjs', probe)
    expect((await run(tunnel, ['node', 'p.mjs'])).stdout).toBe('TypeError:fetch failed:ECONNREFUSED TypeError:fetch failed:ENOTFOUND\n')
    const http = machine(fakeNet(echo).broker, 'http')
    write(http, '/work/p.mjs', probe)
    expect((await run(http, ['node', 'p.mjs'])).stdout).toBe('TypeError:fetch failed:policy TypeError:fetch failed:policy\n')
    const off = createMachine({ loadTransformer: () => transformEsm })
    write(off, '/work/p.mjs', probe)
    expect((await run(off, ['node', 'p.mjs'])).stdout).toBe('TypeError:fetch failed:undefined TypeError:fetch failed:undefined\n')
  })
})

describe('net.Socket and node:http', () => {
  it('carries raw bytes over the tunnel, with connect, data, half-close and close events', async () => {
    const { broker, log } = fakeNet(echo)
    const m = machine(broker, 'tunnel')
    write(m, '/work/sock.js', `
      const net = require('net')
      const s = net.connect({ host: 'api.test', port: 80 }, () => {
        events.push('connect:' + s.remoteAddress + ':' + s.remotePort)
        s.write('GET /raw HTTP/1.1\\r\\nhost: api.test\\r\\n\\r\\n')
      })
      const events = []; let got = ''
      s.on('data', (d) => { got += d; if (got.includes('0\\r\\n\\r\\n')) s.end() })
      s.on('close', (hadError) => console.log(events.join(','), got.split('\\r\\n')[0], hadError, s.bytesWritten > 0, s.bytesRead > 0))
    `)
    const r = await run(m, ['node', 'sock.js'])
    expect(r.stdout).toBe('connect:api.test:80 HTTP/1.1 200 X false true true\n')
    expect(log.halfClosed).toBe(1)
  })

  it("reports connection failures with Node's codes", async () => {
    const m = machine(fakeNet(echo).broker, 'tunnel')
    write(m, '/work/fail.js', `
      const net = require('net'); const out = []
      const attempt = (host, next) => net.connect(80, host).on('error', (e) => { out.push(e.code + ' ' + e.syscall); next() })
      attempt('evil.test', () => attempt('nxdomain.test', () => net.connect('/var/run/x.sock').on('error', (e) => console.log(out.join(', '), e.code))))
    `)
    expect((await run(m, ['node', 'fail.js'])).stdout).toBe('ECONNREFUSED connect, ENOTFOUND getaddrinfo ENOENT\n')
  })

  it('serves http.request in both modes', async () => {
    for (const netMode of ['tunnel', 'http'] as const) {
      const m = machine(fakeNet(echo).broker, netMode)
      write(m, '/work/h.js', `
        const req = require('http').request({ hostname: 'api.test', path: '/h', method: 'PUT', headers: { Authorization: 'Basic x' } }, (res) => {
          let body = ''; res.setEncoding('utf8'); res.on('data', (d) => (body += d)); res.on('end', () => console.log(res.statusCode, res.headers['content-type'], body))
        })
        req.end('payload')
      `)
      const r = await run(m, ['node', 'h.js'])
      expect(r.stderr).toBe('')
      expect(r.stdout).toBe('200 application/json {"method":"PUT","target":"/h","body":"payload","auth":"Basic x"}\n')
    }
  })

  it('accepts listen() but warns that nothing can connect', async () => {
    const m = machine(fakeNet(echo).broker, 'tunnel')
    expect((await run(m, ['node', '-e', 'const s = require("http").createServer(); s.listen(0, () => { console.log(typeof s.address().port); s.close() })'])).stdout).toBe('number\n')
  })
})

describe('TLS', () => {
  const httpsProbe = `
    const viaFetch = await fetch('https://api.test/secure').then(async (r) => r.status + ' ' + (await r.json()).target, (e) => e.message + ':' + e.cause.code)
    const tls = await import('node:tls')
    const viaTls = await new Promise((resolve) => {
      const s = tls.connect({ host: 'api.test', port: 443, servername: 'api.test' }, () => { resolve('secureConnect ' + s.encrypted + ' ' + s.alpnProtocol); s.destroy() })
      s.on('error', (e) => resolve(e.code))
    })
    console.log(viaFetch + ' | ' + viaTls)
  `

  it('is refused with a clear error in tunnel mode while the machine has no TLS', async () => {
    const { broker, log } = fakeNet(echo)
    const m = machine(broker, 'tunnel')
    write(m, '/work/t.mjs', httpsProbe)
    expect((await run(m, ['node', 't.mjs'])).stdout).toBe('fetch failed:ERR_TLS_NOT_AVAILABLE | ERR_TLS_NOT_AVAILABLE\n')
    expect(log.sockets).toEqual([]) // nothing was sent in the clear instead
  })

  it('runs through the connector hook when one is installed', async () => {
    // A stand-in for packages/tls: no encryption, but the same interface, so the plumbing is what is tested.
    const calls: { serverName: string; alpn?: string[] }[] = []
    const connector: TlsConnector = async (transport: ByteTransport, options): Promise<SecureTransport> => {
      calls.push(options)
      return { readable: transport.readable, alpn: options.alpn?.[0] ?? null, protocolVersion: 'TLSv1.3', cipherSuite: 'TEST', write: async (b) => void (await transport.write(b)), end: async () => transport.end(), close: () => transport.close() }
    }
    const { broker, log } = fakeNet(echo)
    const m = machine(broker, 'tunnel', connector)
    write(m, '/work/t.mjs', httpsProbe)
    const r = await run(m, ['node', 't.mjs'])
    expect(r.stderr).toBe('')
    expect(r.stdout).toBe('200 /secure | secureConnect true false\n')
    expect(calls).toEqual([{ serverName: 'api.test', alpn: ['http/1.1'] }, { serverName: 'api.test', alpn: undefined }])
    expect(log.sockets).toEqual(['api.test:443', 'api.test:443'])
  })

  it('is the proxy\'s job in http mode: https URLs are plain exchanges', async () => {
    const { broker, log } = fakeNet(echo)
    const m = machine(broker, 'http')
    write(m, '/work/t.mjs', 'const r = await fetch("https://api.test/secure"); console.log(r.status, (await r.json()).target)')
    expect((await run(m, ['node', 't.mjs'])).stdout).toBe('200 /secure\n')
    expect(log.exchanges).toEqual(['GET https://api.test/secure'])
  })
})
