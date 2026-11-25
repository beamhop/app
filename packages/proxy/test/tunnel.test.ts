import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { ProxyError, openTunnel, type Tunnel } from '../src/client'
import { TOKEN, closedPort, digestServer, echoServer, pattern, patternDigest, proxy, runCleanups, settled, sourceServer } from './helpers'

afterEach(runCleanups)

const MB = 1024 * 1024

/** A tunnel opened with the `ws` package directly, to see the wire and to control reading. */
function raw(proxyUrl: string, query: string, protocols: string[] = ['bh1', `bh1.${TOKEN}`]) {
  const ws = new WebSocket(`${proxyUrl.replace('http', 'ws')}/v1/tcp?${query}`, protocols)
  const frames: (string | Buffer)[] = []
  const waiters: (() => void)[] = []
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    frames.push(isBinary ? data : data.toString('utf8'))
    waiters.splice(0).forEach((w) => w())
  })
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on('close', (code, reason) => {
      resolve({ code, reason: reason.toString() })
      waiters.splice(0).forEach((w) => w())
    })
    ws.on('error', () => resolve({ code: -1, reason: 'error' }))
  })
  let taken = 0
  const next = async (): Promise<string | Buffer | undefined> => {
    while (frames.length <= taken && ws.readyState <= WebSocket.OPEN) await new Promise<void>((r) => waiters.push(r))
    return frames[taken++]
  }
  return { ws, next, closed }
}

async function collect(tunnel: Tunnel): Promise<Buffer> {
  const parts: Uint8Array[] = []
  for await (const chunk of tunnel) parts.push(chunk)
  return Buffer.concat(parts)
}

const failure = async (p: Promise<unknown>): Promise<ProxyError> => {
  const e = await p.then(() => new Error('resolved'), (err: unknown) => err)
  expect(e).toBeInstanceOf(ProxyError)
  return e as ProxyError
}

describe('tunnel mode', () => {
  it('speaks the documented frames: ok, binary both ways, end both ways, close', async () => {
    const p = await proxy()
    const echo = await echoServer()
    const t = raw(p.url, `host=127.0.0.1&port=${echo.port}`)
    expect(await t.next()).toBe('{"ok":true}')
    expect(t.ws.protocol).toBe('bh1')
    const bytes = Buffer.from([0, 255, 1, 254, 13, 10, 0, 128])
    t.ws.send(bytes)
    expect(await t.next()).toEqual(bytes)
    t.ws.send('{"end":true}')
    expect(await t.next()).toBe('{"end":true}') // the echo server ends when we end
    expect(await t.closed).toEqual({ code: 1000, reason: '' })
    await vi.waitFor(() => expect(p.stats().tunnels).toBe(0))
  })

  it('round-trips binary data through the client and delivers it to callbacks', async () => {
    const p = await proxy()
    const echo = await echoServer()
    const tunnel = await openTunnel({ proxyUrl: p.url, token: TOKEN, host: '127.0.0.1', port: echo.port })
    const all = new Uint8Array(256 * 40).map((_, i) => i & 0xff)
    const got: Uint8Array[] = []
    let ended = false
    tunnel.onData = (b) => got.push(b)
    tunnel.onEnd = () => (ended = true)
    await tunnel.write(all.subarray(0, 5000))
    await tunnel.write(all.subarray(5000))
    tunnel.end()
    await expect(tunnel.write(new Uint8Array(1))).rejects.toMatchObject({ code: 'request' })
    expect(await tunnel.closed).toMatchObject({ code: 1000 })
    expect(ended).toBe(true)
    expect(Buffer.concat(got)).toEqual(Buffer.from(all))
  })

  it('half-closes: the target answers after the client has ended its side', async () => {
    const p = await proxy()
    const sink = await digestServer()
    const tunnel = await openTunnel({ proxyUrl: p.url, token: TOKEN, host: '127.0.0.1', port: sink.port })
    const data = Buffer.from('half-close me \u0000ÿ', 'latin1')
    await tunnel.write(data)
    tunnel.end()
    // The answer exists only once the target has seen our FIN, and arrives after it.
    expect((await collect(tunnel)).toString()).toBe(`${data.length} ${createHash('sha256').update(data).digest('hex')}`)
    expect(await tunnel.closed).toMatchObject({ code: 1000 })
  })

  it('keeps the tunnel usable after the target half-closes first', async () => {
    const p = await proxy()
    const source = await sourceServer(1000)
    const t = raw(p.url, `host=127.0.0.1&port=${source.port}`)
    expect(await t.next()).toBe('{"ok":true}')
    let got = 0
    for (;;) {
      const f = await t.next()
      if (typeof f === 'string') {
        expect(f).toBe('{"end":true}')
        break
      }
      got += f!.length
    }
    expect(got).toBe(1000)
    expect(t.ws.readyState).toBe(WebSocket.OPEN)
    t.ws.send(Buffer.from('still writable'))
    await vi.waitFor(() => expect(source.sockets[0]!.bytesRead).toBe(14))
    t.ws.send('{"end":true}')
    expect(await t.closed).toMatchObject({ code: 1000 })
  })

  it('downloads 50 MB, and stops reading from the target while the client is not reading', async () => {
    const size = 50 * MB
    const p = await proxy()
    const source = await sourceServer(size)
    const t = raw(p.url, `host=127.0.0.1&port=${source.port}`)
    const hash = createHash('sha256')
    let received = 0
    let sawEnd = false
    t.ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return void (sawEnd ||= data.toString() === '{"end":true}')
      received += data.length
      hash.update(data)
    })
    expect(await t.next()).toBe('{"ok":true}')
    const before = process.memoryUsage()
    t.ws.pause() // a client that has stopped reading

    // With nobody reading, the proxy must stop pulling from the target: the target's writes stall.
    await vi.waitFor(() => expect(p.stats().backpressurePauses).toBeGreaterThan(0), { timeout: 20_000 })
    const sent = await settled(() => source.sockets[0]!.bytesWritten)
    const after = process.memoryUsage()
    // What left the target and did not reach the client sits in kernel socket buffers plus about
    // 1 MiB of WebSocket send buffer in the proxy. It must be far from the whole transfer.
    expect(sent - received).toBeLessThan(24 * MB)
    expect(sent).toBeLessThan(size)
    // Memory sanity: the proxy (in this process, with the target and client) holds no large backlog.
    expect(after.arrayBuffers - before.arrayBuffers).toBeLessThan(16 * MB)
    expect(after.heapUsed - before.heapUsed).toBeLessThan(32 * MB)

    t.ws.resume()
    expect(await t.closed.then((c) => (t.ws.send === undefined ? c : c))).toBeDefined()
    expect(sawEnd).toBe(true)
    expect(received).toBe(size)
    expect(hash.digest('hex')).toBe(patternDigest(size))
  }, 60_000)

  it('uploads 50 MB through the client with write backpressure', async () => {
    const size = 50 * MB
    const p = await proxy()
    const sink = await digestServer({ startPaused: true })
    const tunnel = await openTunnel({ proxyUrl: p.url, token: TOKEN, host: '127.0.0.1', port: sink.port })
    let written = 0
    let maxBuffered = 0
    const before = process.memoryUsage()
    const upload = (async () => {
      for (const chunk of pattern(size)) {
        await tunnel.write(chunk)
        written += chunk.length
        maxBuffered = Math.max(maxBuffered, tunnel.bufferedAmount)
      }
      tunnel.end()
    })()

    // The target is not reading: awaited writes must stall long before 50 MB has been accepted.
    await vi.waitFor(() => expect(written).toBeGreaterThan(0), { timeout: 20_000 })
    const stalledAt = await settled(() => written)
    const during = process.memoryUsage()
    expect(stalledAt).toBeLessThan(size - 16 * MB)
    expect(sink.received()).toBe(0)
    expect(during.arrayBuffers - before.arrayBuffers).toBeLessThan(16 * MB)

    sink.sockets[0]!.resume()
    await upload
    expect((await collect(tunnel)).toString()).toBe(`${size} ${patternDigest(size)}`)
    expect(maxBuffered).toBeLessThan(4 * MB)
    expect(await tunnel.closed).toMatchObject({ code: 1000 })
  }, 60_000)

  it('refuses a wrong or missing token with an auth frame', async () => {
    const p = await proxy()
    const echo = await echoServer()
    const bad = raw(p.url, `host=127.0.0.1&port=${echo.port}`, ['bh1', 'bh1.wrong'])
    expect(JSON.parse((await bad.next()) as string)).toMatchObject({ ok: false, code: 'auth' })
    expect((await bad.closed).code).toBe(1008)
    const none = raw(p.url, `host=127.0.0.1&port=${echo.port}`, ['bh1'])
    expect(JSON.parse((await none.next()) as string)).toMatchObject({ ok: false, code: 'auth' })
    expect((await failure(openTunnel({ proxyUrl: p.url, token: 'nope', host: '127.0.0.1', port: echo.port }))).code).toBe('auth')
    expect((await failure(openTunnel({ proxyUrl: p.url, host: '127.0.0.1', port: echo.port }))).code).toBe('auth')
    expect(echo.sockets.length).toBe(0)
  })

  it('needs no token when open', async () => {
    const p = await proxy({ open: true, tokens: [] })
    const echo = await echoServer()
    const tunnel = await openTunnel({ proxyUrl: p.url, host: '127.0.0.1', port: echo.port })
    await tunnel.write(new Uint8Array([1, 2, 3]))
    tunnel.end()
    expect(await collect(tunnel)).toEqual(Buffer.from([1, 2, 3]))
  })

  it('refuses loopback, private and other internal addresses unless allowed', async () => {
    const echo = await echoServer()
    const p = await proxy({ allowPrivate: false })
    for (const host of ['127.0.0.1', '::1', '[::1]', '10.0.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::ffff:127.0.0.1']) {
      const e = await failure(openTunnel({ proxyUrl: p.url, token: TOKEN, host, port: echo.port }))
      expect(e.code, host).toBe('policy')
    }
    // `localhost` goes through the real system resolver and comes back as a loopback address.
    expect((await failure(openTunnel({ proxyUrl: p.url, token: TOKEN, host: 'localhost', port: echo.port }))).code).toBe('policy')
    expect((await failure(openTunnel({ proxyUrl: p.url, token: TOKEN, host: '0x7f.1', port: echo.port }))).code).toBe('request')
    expect(echo.sockets.length).toBe(0)
  })

  it('refuses a host name that resolves to a private address, and connects to the address it checked', async () => {
    const echo = await echoServer()
    const calls: string[] = []
    const lookup = async (host: string): Promise<string[]> => {
      calls.push(host)
      if (host === 'intranet.test') return ['10.0.0.5']
      if (host === 'metadata.test') return ['169.254.169.254', '::ffff:10.0.0.1']
      if (host === 'local.test') return ['127.0.0.1']
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    }
    const strict = await proxy({ allowPrivate: false }, { lookup })
    for (const host of ['intranet.test', 'metadata.test', 'local.test']) {
      expect((await failure(openTunnel({ proxyUrl: strict.url, token: TOKEN, host, port: echo.port }))).code, host).toBe('policy')
    }
    expect(echo.sockets.length).toBe(0)

    // With private addresses allowed the same name works, the resolver is asked exactly once, and
    // the connection goes to the address it returned (the name itself does not resolve anywhere).
    calls.length = 0
    const lax = await proxy({}, { lookup })
    const tunnel = await openTunnel({ proxyUrl: lax.url, token: TOKEN, host: 'local.test', port: echo.port })
    await tunnel.write(new Uint8Array([7]))
    tunnel.end()
    expect(await collect(tunnel)).toEqual(Buffer.from([7]))
    expect(calls).toEqual(['local.test'])
  })

  it('applies host and port allow and deny lists', async () => {
    const echo = await echoServer()
    const lookup = async (): Promise<string[]> => ['127.0.0.1']
    const p = await proxy({ allowHosts: ['*.ok.test', 'exact.test'], denyHosts: ['no.ok.test'], denyPorts: [{ from: 1, to: 1023 }] }, { lookup })
    const attempt = (host: string, port = echo.port) => openTunnel({ proxyUrl: p.url, token: TOKEN, host, port })
    for (const host of ['a.ok.test', 'A.B.OK.test', 'exact.test']) (await attempt(host)).close()
    for (const host of ['no.ok.test', 'ok.test', 'other.test', 'exact.test.evil.test', '127.0.0.1']) {
      expect((await failure(attempt(host))).code, host).toBe('policy')
    }
    expect((await failure(attempt('a.ok.test', 22))).code).toBe('policy')
    const portsOnly = await proxy({ allowPorts: [{ from: echo.port, to: echo.port }] })
    ;(await openTunnel({ proxyUrl: portsOnly.url, token: TOKEN, host: '127.0.0.1', port: echo.port })).close()
    const other = await echoServer()
    expect((await failure(openTunnel({ proxyUrl: portsOnly.url, token: TOKEN, host: '127.0.0.1', port: other.port }))).code).toBe('policy')
  })

  it('limits concurrent connections per token', async () => {
    const echo = await echoServer()
    const p = await proxy({ tokens: [TOKEN, 'second'], maxConnections: 2 })
    const open = (token = TOKEN) => openTunnel({ proxyUrl: p.url, token, host: '127.0.0.1', port: echo.port })
    const a = await open()
    const b = await open()
    expect((await failure(open())).code).toBe('limit')
    const c = await open('second') // another token has its own allowance
    a.close()
    await a.closed
    await vi.waitFor(() => expect(p.stats().tunnels).toBe(2))
    const d = await open()
    for (const t of [b, c, d]) t.close()
  })

  it('limits bytes per minute per token', async () => {
    const echo = await echoServer()
    let now = 1_700_000_000_000
    const p = await proxy({ bytesPerMinute: 3000 }, { now: () => now })
    const open = () => openTunnel({ proxyUrl: p.url, token: TOKEN, host: '127.0.0.1', port: echo.port })
    const t = await open()
    let error: ProxyError | null = null
    t.onError = (e) => (error = e)
    await t.write(new Uint8Array(1000)) // 1000 up + 1000 echoed down
    await t.write(new Uint8Array(1000)) // over 3000 on the way back
    expect(await t.closed).toMatchObject({ code: 4002 })
    expect(error).toMatchObject({ code: 'limit' })
    expect((await failure(open())).code).toBe('limit')
    now += 60_000
    ;(await open()).close()
  })

  it('maps failures to codes: request, dns, connect, timeout', async () => {
    const hang = new Promise<string[]>(() => {})
    const lookup = async (host: string): Promise<string[]> => {
      if (host === 'slow.test') return hang
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    }
    const p = await proxy({ connectTimeoutMs: 150 }, { lookup })
    const attempt = (host: string, port: number) => openTunnel({ proxyUrl: p.url, token: TOKEN, host, port })
    expect((await failure(attempt('missing.test', 80))).code).toBe('dns')
    expect((await failure(attempt('127.0.0.1', await closedPort()))).code).toBe('connect')
    expect((await failure(attempt('slow.test', 80))).code).toBe('timeout')
    expect((await failure(attempt('bad host', 80))).code).toBe('request')
    const noPort = raw(p.url, 'host=a.test')
    expect(JSON.parse((await noPort.next()) as string)).toMatchObject({ ok: false, code: 'request' })
    expect((await failure(openTunnel({ proxyUrl: 'http://127.0.0.1:' + (await closedPort()), token: TOKEN, host: 'a.test', port: 80 }))).code).toBe('proxy')
    await vi.waitFor(() => expect(p.stats().tunnels).toBe(0))
  })

  it('closes an idle tunnel', async () => {
    const echo = await echoServer()
    const p = await proxy({ idleTimeoutMs: 150 })
    const t = await openTunnel({ proxyUrl: p.url, token: TOKEN, host: '127.0.0.1', port: echo.port })
    let error: ProxyError | null = null
    t.onError = (e) => (error = e)
    await t.write(new Uint8Array([1]))
    expect(await t.closed).toMatchObject({ code: 4001 })
    expect(error).toMatchObject({ code: 'timeout' })
    await vi.waitFor(() => expect(echo.sockets[0]!.destroyed).toBe(true))
  })

  it('tears down the target connection when the client closes, after delivering what was sent', async () => {
    const p = await proxy()
    const sink = await digestServer()
    const t = await openTunnel({ proxyUrl: p.url, token: TOKEN, host: '127.0.0.1', port: sink.port })
    await t.write(new Uint8Array(100_000))
    t.close()
    expect(await t.closed).toMatchObject({ code: 1000 })
    await vi.waitFor(() => expect(sink.sockets[0]!.destroyed || sink.sockets[0]!.readableEnded).toBe(true))
    expect(sink.received()).toBe(100_000)
    await vi.waitFor(() => expect(p.stats().tunnels).toBe(0))
  })

  it('reports a target that resets the connection', async () => {
    const p = await proxy()
    const echo = await echoServer()
    const t = await openTunnel({ proxyUrl: p.url, token: TOKEN, host: '127.0.0.1', port: echo.port })
    let error: ProxyError | null = null
    t.onError = (e) => (error = e)
    await t.write(new Uint8Array([1]))
    await vi.waitFor(() => expect(echo.sockets.length).toBe(1))
    echo.sockets[0]!.resetAndDestroy()
    expect(await t.closed).toMatchObject({ code: 1011 })
    expect(error).toMatchObject({ code: 'connect' })
    await expect(collect(t)).rejects.toMatchObject({ code: 'connect' })
  })

  it('shuts down gracefully: open tunnels are closed with 1001 and the port is released', async () => {
    const p = await proxy()
    const echo = await echoServer()
    const t = await openTunnel({ proxyUrl: p.url, token: TOKEN, host: '127.0.0.1', port: echo.port })
    await p.close(2000)
    expect(await t.closed).toMatchObject({ code: 1001 })
    expect((await failure(openTunnel({ proxyUrl: p.url, token: TOKEN, host: '127.0.0.1', port: echo.port }))).code).toBe('proxy')
  })

  it('does not offer the tunnel when tcp mode is off', async () => {
    const p = await proxy({ modes: ['http'] })
    expect((await failure(openTunnel({ proxyUrl: p.url, token: TOKEN, host: '127.0.0.1', port: 80 }))).code).toBe('proxy')
  })
})
