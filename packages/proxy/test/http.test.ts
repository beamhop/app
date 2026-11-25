import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProxyError, health, proxyFetch, type HeaderPairs } from '../src/client'
import { decodeHeaders, encodeHeaders } from '../src/core'
import { TOKEN, closedPort, deferred, listen, pattern, patternDigest, proxy, readAll, runCleanups } from './helpers'

afterEach(runCleanups)

const failure = async (p: Promise<unknown>): Promise<ProxyError> => {
  const e = await p.then(() => new Error('resolved'), (err: unknown) => err)
  expect(e).toBeInstanceOf(ProxyError)
  return e as ProxyError
}
const pairsOf = (raw: string[]): HeaderPairs => {
  const out: HeaderPairs = []
  for (let i = 0; i < raw.length; i += 2) out.push([raw[i]!, raw[i + 1]!])
  return out
}
const values = (headers: HeaderPairs, name: string): string[] => headers.filter(([k]) => k.toLowerCase() === name).map(([, v]) => v)

/** One HTTP target with a route per behaviour under test. */
async function target() {
  const sse = { gate: deferred(), secondSent: false, closed: deferred() }
  const hang = { reached: deferred(), closed: deferred() }
  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/inspect') {
      const hash = createHash('sha256')
      let bytes = 0
      req.on('data', (d: Buffer) => {
        bytes += d.length
        hash.update(d)
      })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: pairsOf(req.rawHeaders), bytes, sha256: hash.digest('hex') }))
      })
    } else if (url.pathname === '/cookies') {
      res.writeHead(200, [['Set-Cookie', 'a=1; Path=/; HttpOnly'], ['Set-Cookie', 'b=2; Secure'], ['X-Twice', 'one'], ['X-Twice', 'two'], ['Content-Type', 'text/plain']] as unknown as http.OutgoingHttpHeaders)
      res.end('cookies')
    } else if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/inspect?followed=1' })
      res.end('go away')
    } else if (url.pathname === '/status') {
      res.writeHead(Number(url.searchParams.get('code')), { 'content-type': 'text/plain' })
      res.end(`status ${url.searchParams.get('code')}`)
    } else if (url.pathname === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: one\n\n')
      res.on('close', () => sse.closed.resolve())
      void sse.gate.promise.then(() => {
        sse.secondSent = true
        res.end('data: two\n\n')
      })
    } else if (url.pathname === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      const gen = pattern(Number(url.searchParams.get('size')))
      const pump = (): void => {
        for (;;) {
          const { value, done } = gen.next()
          if (done) return void res.end()
          if (!res.write(value)) return void res.once('drain', pump)
        }
      }
      pump()
    } else if (url.pathname === '/hang') {
      hang.reached.resolve()
      res.on('close', () => hang.closed.resolve())
    } else if (url.pathname === '/drop') {
      req.socket.destroy()
    } else if (url.pathname === '/die') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('partial')
      res.flushHeaders()
      setImmediate(() => res.socket?.destroy())
    } else {
      res.writeHead(404)
      res.end()
    }
  }
  const port = await listen(http.createServer(handler))
  return { port, origin: `http://127.0.0.1:${port}`, sse, hang, handler }
}

describe('plain mode', () => {
  it('carries headers that fetch refuses to set, in order and with repeats', async () => {
    const p = await proxy()
    const t = await target()
    const headers: HeaderPairs = [
      ['User-Agent', 'beamhop-harness/1.0'], ['Cookie', 'session=abc; theme=dark'], ['Host', 'virtual.example:8443'],
      ['Origin', 'https://elsewhere.example'], ['Referer', 'https://elsewhere.example/page'], ['Accept-Encoding', 'gzip, br'],
      ['X-Multi', 'first'], ['X-Multi', 'second'], ['Authorization', 'Bearer secret'], ['Sec-Fetch-Mode', 'navigate'],
      // Connection-level headers belong to the proxy's own connection and are not forwarded.
      ['Connection', 'keep-alive'], ['Transfer-Encoding', 'chunked'], ['Content-Length', '999'],
    ]
    const res = await proxyFetch({ proxyUrl: p.url, token: TOKEN, url: `${t.origin}/inspect?q=1&r=%20`, method: 'POST', headers, body: 'hello' })
    expect(res.status).toBe(200)
    const seen = JSON.parse((await readAll(res.body)).toString()) as { method: string; url: string; headers: HeaderPairs; bytes: number }
    expect(seen.method).toBe('POST')
    expect(seen.url).toBe('/inspect?q=1&r=%20')
    expect(seen.bytes).toBe(5)
    // Exactly what was asked for, in the order given, then the body length and the proxy's own Connection.
    expect(seen.headers).toEqual([...headers.slice(0, 10), ['content-length', '5'], ['connection', 'close']])
    // Nothing of the proxy's protocol leaks to the target.
    expect(seen.headers.some(([k]) => k.toLowerCase().startsWith('x-bh-'))).toBe(false)
  })

  it('sets Host from the URL when none is given, and adds nothing else', async () => {
    const p = await proxy()
    const t = await target()
    const res = await proxyFetch({ proxyUrl: p.url, token: TOKEN, url: `${t.origin}/inspect` })
    const seen = JSON.parse((await readAll(res.body)).toString()) as { method: string; headers: HeaderPairs }
    expect(seen.method).toBe('GET')
    expect(seen.headers).toEqual([['host', `127.0.0.1:${t.port}`], ['connection', 'close']])
  })

  it('returns every response header, each set-cookie separately', async () => {
    const p = await proxy()
    const t = await target()
    const res = await proxyFetch({ proxyUrl: p.url, token: TOKEN, url: `${t.origin}/cookies` })
    expect(values(res.headers, 'set-cookie')).toEqual(['a=1; Path=/; HttpOnly', 'b=2; Secure'])
    expect(values(res.headers, 'x-twice')).toEqual(['one', 'two'])
    expect(values(res.headers, 'content-type')).toEqual(['text/plain'])
    expect(values(res.headers, 'transfer-encoding')).toEqual([]) // framing of the proxy-to-target hop
    expect((await readAll(res.body)).toString()).toBe('cookies')
  })

  it('puts the documented headers on the wire', async () => {
    const p = await proxy()
    const t = await target()
    const res = await fetch(`${p.url}/v1/http`, { headers: { 'x-bh-url': `${t.origin}/status?code=418`, 'x-bh-token': TOKEN, origin: 'https://app.example' } })
    expect(res.status).toBe(418)
    expect(res.headers.get('x-bh-status')).toBe('418')
    expect(res.headers.get('x-bh-error')).toBeNull()
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const exposed = res.headers.get('access-control-expose-headers') ?? ''
    for (const h of ['x-bh-resp-headers', 'x-bh-status', 'x-bh-error']) expect(exposed).toContain(h)
    expect(values(decodeHeaders(res.headers.get('x-bh-resp-headers')!), 'content-type')).toEqual(['text/plain'])
    expect(await res.text()).toBe('status 418')
  })

  it('streams server-sent events as they are produced', async () => {
    const p = await proxy()
    const t = await target()
    const res = await proxyFetch({ proxyUrl: p.url, token: TOKEN, url: `${t.origin}/sse`, headers: { accept: 'text/event-stream' } })
    expect(values(res.headers, 'content-type')).toEqual(['text/event-stream'])
    const reader = res.body.getReader()
    const first = await reader.read()
    // The first event is here while the target has not yet produced the second, let alone finished.
    expect(Buffer.from(first.value!).toString()).toBe('data: one\n\n')
    expect(t.sse.secondSent).toBe(false)
    t.sse.gate.resolve()
    const second = await reader.read()
    expect(Buffer.from(second.value!).toString()).toBe('data: two\n\n')
    expect((await reader.read()).done).toBe(true)
  })

  it('stops the target request when the client goes away mid-stream', async () => {
    const p = await proxy()
    const t = await target()
    const res = await proxyFetch({ proxyUrl: p.url, token: TOKEN, url: `${t.origin}/sse` })
    const reader = res.body.getReader()
    await reader.read()
    await reader.cancel()
    await t.sse.closed.promise
    await vi.waitFor(() => expect(p.stats().requests).toBe(0))
  })

  it('does not follow redirects', async () => {
    const p = await proxy()
    const t = await target()
    const res = await proxyFetch({ proxyUrl: p.url, token: TOKEN, url: `${t.origin}/redirect` })
    expect(res.status).toBe(302)
    expect(values(res.headers, 'location')).toEqual(['/inspect?followed=1'])
    expect((await readAll(res.body)).toString()).toBe('go away')
    // On the wire the Location is only inside x-bh-resp-headers, so no browser follows it either.
    const wire = await fetch(`${p.url}/v1/http`, { headers: { 'x-bh-url': `${t.origin}/redirect`, 'x-bh-token': TOKEN }, redirect: 'manual' })
    expect(wire.status).toBe(302)
    expect(wire.headers.get('location')).toBeNull()
    await wire.arrayBuffer()
  })

  it('streams request and response bodies unchanged', async () => {
    const size = 8 * 1024 * 1024
    const p = await proxy()
    const t = await target()
    const body = Buffer.concat([...pattern(size)])
    const up = await proxyFetch({ proxyUrl: p.url, token: TOKEN, url: `${t.origin}/inspect`, method: 'PUT', body })
    expect(JSON.parse((await readAll(up.body)).toString())).toMatchObject({ method: 'PUT', bytes: size, sha256: patternDigest(size) })
    // A streamed request body (no length known in advance) arrives complete as well.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of pattern(size)) c.enqueue(chunk)
        c.close()
      },
    })
    const streamed = await proxyFetch({ proxyUrl: p.url, token: TOKEN, url: `${t.origin}/inspect`, method: 'POST', body: stream })
    const seen = JSON.parse((await readAll(streamed.body)).toString()) as { bytes: number; sha256: string; headers: HeaderPairs }
    expect(seen).toMatchObject({ bytes: size, sha256: patternDigest(size) })
    expect(values(seen.headers, 'transfer-encoding')).toEqual(['chunked'])
    const down = await proxyFetch({ proxyUrl: p.url, token: TOKEN, url: `${t.origin}/big?size=${size}` })
    expect(createHash('sha256').update(await readAll(down.body)).digest('hex')).toBe(patternDigest(size))
  })

  it('passes other methods and statuses through, including a target 502', async () => {
    const p = await proxy()
    const t = await target()
    for (const method of ['DELETE', 'PATCH', 'OPTIONS', 'PUT']) {
      const res = await proxyFetch({ proxyUrl: p.url, token: TOKEN, url: `${t.origin}/inspect`, method })
      expect(JSON.parse((await readAll(res.body)).toString())).toMatchObject({ method })
    }
    const head = await proxyFetch({ proxyUrl: p.url, token: TOKEN, url: `${t.origin}/status?code=200`, method: 'HEAD' })
    expect(head.status).toBe(200)
    expect((await readAll(head.body)).length).toBe(0)
    for (const status of [204, 404, 500, 502]) {
      const res = await proxyFetch({ proxyUrl: p.url, token: TOKEN, url: `${t.origin}/status?code=${status}` })
      expect(res.status).toBe(status) // a 502 from the target is the target's answer, not a proxy failure
      expect((await readAll(res.body)).toString()).toBe(status === 204 ? '' : `status ${status}`)
    }
  })

  it('refuses a wrong or missing token with 502 and x-bh-error: auth', async () => {
    const p = await proxy()
    const t = await target()
    const res = await fetch(`${p.url}/v1/http`, { headers: { 'x-bh-url': `${t.origin}/inspect`, 'x-bh-token': 'wrong' } })
    expect(res.status).toBe(502)
    expect(res.headers.get('x-bh-error')).toBe('auth')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(await res.json()).toMatchObject({ code: 'auth', message: expect.any(String) })
    expect((await failure(proxyFetch({ proxyUrl: p.url, url: `${t.origin}/inspect` }))).code).toBe('auth')
    expect((await failure(proxyFetch({ proxyUrl: p.url, token: 'wrong', url: `${t.origin}/inspect`, method: 'POST', body: 'x'.repeat(100_000) }))).code).toBe('auth')
    const open = await proxy({ open: true, tokens: [] })
    expect((await proxyFetch({ proxyUrl: open.url, url: `${t.origin}/status?code=200` })).status).toBe(200)
  })

  it('applies the destination policy after resolution', async () => {
    const t = await target()
    const lookup = async (host: string): Promise<string[]> => {
      if (host === 'intranet.test') return ['192.168.7.7']
      if (host === 'local.test' || host.endsWith('ok.test')) return ['127.0.0.1']
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
    }
    const strict = await proxy({ allowPrivate: false }, { lookup })
    const get = (proxyUrl: string, url: string) => proxyFetch({ proxyUrl, token: TOKEN, url })
    for (const url of [`${t.origin}/inspect`, `http://[::1]:${t.port}/`, `http://intranet.test:${t.port}/`, `http://local.test:${t.port}/`, `http://2130706433:${t.port}/`, 'http://169.254.169.254/latest/meta-data/']) {
      expect((await failure(get(strict.url, url))).code, url).toBe('policy')
    }
    const lists = await proxy({ allowHosts: ['*.ok.test'], denyHosts: ['no.ok.test'] }, { lookup })
    expect((await get(lists.url, `http://a.ok.test:${t.port}/status?code=200`)).status).toBe(200)
    expect((await failure(get(lists.url, `http://no.ok.test:${t.port}/`))).code).toBe('policy')
    expect((await failure(get(lists.url, `http://local.test:${t.port}/`))).code).toBe('policy')
    const ports = await proxy({ allowPorts: [{ from: 443, to: 443 }] })
    expect((await failure(get(ports.url, `${t.origin}/`))).code).toBe('policy')
  })

  it('maps failures to codes: request, dns, connect, timeout', async () => {
    const t = await target()
    const hang = new Promise<string[]>(() => {})
    const lookup = async (host: string): Promise<string[]> => {
      if (host === 'slow.test') return hang
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
    }
    const p = await proxy({ connectTimeoutMs: 150 }, { lookup })
    const get = (url: string) => proxyFetch({ proxyUrl: p.url, token: TOKEN, url })
    expect((await failure(get('http://missing.test/'))).code).toBe('dns')
    expect((await failure(get(`http://127.0.0.1:${await closedPort()}/`))).code).toBe('connect')
    expect((await failure(get('http://slow.test/'))).code).toBe('timeout')
    expect((await failure(get('ftp://example.test/'))).code).toBe('request')
    expect((await failure(get('not a url'))).code).toBe('request')
    const noUrl = await fetch(`${p.url}/v1/http`, { headers: { 'x-bh-token': TOKEN } })
    expect([noUrl.status, noUrl.headers.get('x-bh-error')]).toEqual([502, 'request'])
    const badHeaders = await fetch(`${p.url}/v1/http`, { headers: { 'x-bh-token': TOKEN, 'x-bh-url': `${t.origin}/inspect`, 'x-bh-headers': encodeHeaders([['bad name', 'v']]) } })
    expect([badHeaders.status, badHeaders.headers.get('x-bh-error')]).toEqual([502, 'request'])
    // A target that accepts the connection and then drops it without answering.
    expect((await failure(get(`${t.origin}/drop`))).code).toBe('connect')
    expect((await failure(proxyFetch({ proxyUrl: `http://127.0.0.1:${await closedPort()}`, token: TOKEN, url: 'http://a.test/' }))).code).toBe('proxy')
    expect((await failure(proxyFetch({ proxyUrl: t.origin, token: TOKEN, url: 'http://a.test/' }))).code).toBe('proxy') // not a Beamhop proxy
  })

  it('times out a target that never answers, and breaks the stream of one that dies mid-body', async () => {
    const t = await target()
    const p = await proxy({ idleTimeoutMs: 150 })
    const e = await failure(proxyFetch({ proxyUrl: p.url, token: TOKEN, url: `${t.origin}/hang` }))
    expect(e.code).toBe('timeout')
    await t.hang.closed.promise // the proxy let go of the target connection

    const res = await proxyFetch({ proxyUrl: p.url, token: TOKEN, url: `${t.origin}/die` })
    expect(res.status).toBe(200)
    await expect(readAll(res.body)).rejects.toThrow()
  })

  it('limits concurrent requests and bytes per minute per token', async () => {
    const t = await target()
    let now = 1_700_000_000_000
    const p = await proxy({ maxConnections: 1, bytesPerMinute: 5000 }, { now: () => now })
    const get = (path: string) => proxyFetch({ proxyUrl: p.url, token: TOKEN, url: `${t.origin}${path}` })
    const held = await get('/sse')
    expect((await failure(get('/status?code=200'))).code).toBe('limit')
    t.sse.gate.resolve()
    await readAll(held.body)
    await vi.waitFor(() => expect(p.stats().requests).toBe(0))
    expect((await get('/status?code=200')).status).toBe(200)
    await vi.waitFor(() => expect(p.stats().requests).toBe(0))
    // 64 KiB is over the 5000-byte allowance: the stream is cut, and the token is refused until the next minute.
    const big = await get('/big?size=65536')
    await expect(readAll(big.body)).rejects.toThrow()
    expect((await failure(get('/status?code=200'))).code).toBe('limit')
    now += 60_000
    expect((await get('/status?code=200')).status).toBe(200)
  })

  it('answers CORS preflights for any origin without a token', async () => {
    const p = await proxy()
    for (const path of ['/v1/http', '/v1/health', '/v1/tcp']) {
      const res = await fetch(`${p.url}${path}`, {
        method: 'OPTIONS',
        headers: { origin: 'https://app.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-bh-url,x-bh-token,x-bh-headers,content-type', 'access-control-request-private-network': 'true' },
      })
      expect(res.status, path).toBe(204)
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(res.headers.get('access-control-allow-headers')).toBe('x-bh-url,x-bh-token,x-bh-headers,content-type')
      for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) expect(res.headers.get('access-control-allow-methods')).toContain(m)
      expect(res.headers.get('access-control-allow-private-network')).toBe('true')
      expect(Number(res.headers.get('access-control-max-age'))).toBeGreaterThan(0)
    }
  })

  it('reports health and supported modes without a token', async () => {
    const p = await proxy()
    const res = await fetch(`${p.url}/v1/health`)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(await res.json()).toEqual({ ok: true, v: 1, modes: ['tcp', 'http'] })
    expect(await health(p.url)).toEqual({ ok: true, v: 1, modes: ['tcp', 'http'] })
    expect(await health(`${p.url}/`)).toMatchObject({ ok: true })
    const tcpOnly = await proxy({ modes: ['tcp'] })
    expect(await health(tcpOnly.url)).toEqual({ ok: true, v: 1, modes: ['tcp'] })
    expect((await fetch(`${tcpOnly.url}/v1/http`, { headers: { 'x-bh-url': 'http://a.test/', 'x-bh-token': TOKEN } })).status).toBe(404)
    expect((await fetch(`${p.url}/nope`)).status).toBe(404)
    expect((await failure(health(`http://127.0.0.1:${await closedPort()}`))).code).toBe('proxy')
  })

  it('finishes requests in flight on shutdown, then refuses new ones', async () => {
    const p = await proxy()
    const t = await target()
    const res = await proxyFetch({ proxyUrl: p.url, token: TOKEN, url: `${t.origin}/sse` })
    const closing = p.close(5000)
    t.sse.gate.resolve()
    expect((await readAll(res.body)).toString()).toBe('data: one\n\ndata: two\n\n')
    await closing
    expect((await failure(health(p.url))).code).toBe('proxy')
  })
})

describe('plain mode over TLS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bh-proxy-test-'))
  let cert = ''
  let key = ''
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=secure.test',
      '-addext', 'subjectAltName=DNS:secure.test', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' })
    cert = readFileSync(join(dir, 'cert.pem'), 'utf8')
    key = readFileSync(join(dir, 'key.pem'), 'utf8')
  } catch { /* no openssl: the test below is skipped */ }
  rmSync(dir, { recursive: true, force: true })

  it.skipIf(!cert)('connects to the resolved address but verifies the certificate against the name', async () => {
    const t = await target()
    let sni: string | undefined
    const server = https.createServer({ cert, key, SNICallback: (name, cb) => {
      sni = name
      cb(null)
    } }, t.handler)
    const port = await listen(server)
    const lookup = async (host: string): Promise<string[]> => (host.endsWith('.test') ? ['127.0.0.1'] : Promise.reject(new Error('ENOTFOUND')))
    const p = await proxy({}, { lookup, ca: [cert] })
    const res = await proxyFetch({ proxyUrl: p.url, token: TOKEN, url: `https://secure.test:${port}/inspect`, method: 'POST', body: 'tls', headers: [['Cookie', 'k=v']] })
    const seen = JSON.parse((await readAll(res.body)).toString()) as { bytes: number; headers: HeaderPairs }
    expect(seen.bytes).toBe(3)
    expect(seen.headers).toEqual([['host', `secure.test:${port}`], ['Cookie', 'k=v'], ['content-length', '3'], ['connection', 'close']])
    expect(sni).toBe('secure.test')
    // The certificate is for secure.test only, and an unknown issuer is refused.
    expect((await failure(proxyFetch({ proxyUrl: p.url, token: TOKEN, url: `https://other.test:${port}/inspect` }))).code).toBe('connect')
    const untrusting = await proxy({}, { lookup })
    expect((await failure(proxyFetch({ proxyUrl: untrusting.url, token: TOKEN, url: `https://secure.test:${port}/inspect` }))).code).toBe('connect')
  })
})
