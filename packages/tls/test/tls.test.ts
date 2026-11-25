import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import type tls from 'node:tls'
import { connectTls, RootStore, TlsError, type TlsOptions, type TlsSocket } from '../src/index'
import { CLIENT_AUTH, derToPem, issue, type Issued } from './helpers/certs'
import { readAll, readN, startRawServer, startTlsServer, type Mode, type TestServer } from './helpers/net'

const HOST = 'test.beamhop.example'
const DAY = 86400_000
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

let ca: Issued // ECDSA P-256 root
let rsaCa: Issued // RSA root
let rsaInt: Issued // RSA intermediate under rsaCa
let otherCa: Issued // never trusted
let roots: RootStore
const leaf: Record<string, Issued> = {}
const servers: TestServer[] = []

const echo = (s: tls.TLSSocket) => void s.pipe(s)
async function server(cert: Issued | { key: string; cert: string }, extra: tls.TlsOptions = {}, handler: (s: tls.TLSSocket) => void = echo) {
  const s = await startTlsServer({ key: cert.key, cert: 'pem' in cert ? cert.pem : cert.cert, ...extra }, handler)
  servers.push(s)
  return s
}
async function connect(s: TestServer, mode: Mode = 'memory', opts: Partial<TlsOptions> = {}, rechunk = false) {
  const c = await s.connect(mode, { rechunk })
  const sock = await connectTls(c.transport, { serverName: HOST, roots, ...opts })
  return { sock, ...c }
}
/** Handshake against a server presenting `cert`; resolves to the TlsError code, or 'ok'. */
async function outcome(cert: Issued | { key: string; cert: string }, opts: Partial<TlsOptions> = {}, extra: tls.TlsOptions = {}): Promise<string> {
  const s = await server(cert, extra)
  const results: string[] = []
  for (const mode of ['memory', 'tcp'] as const) {
    try {
      const { sock } = await connect(s, mode, opts)
      sock.close()
      results.push('ok')
    } catch (e) {
      if (!(e instanceof TlsError)) throw e
      results.push(e.code)
    }
  }
  expect(results[0], 'memory and tcp transports agree').toBe(results[1])
  return results[0]!
}
async function roundTrip(sock: TlsSocket, text = 'ping') {
  const r = sock.readable.getReader()
  await sock.write(enc(text))
  const got = dec(await readN(r, text.length))
  r.releaseLock()
  return got
}

beforeAll(async () => {
  ca = await issue({ cn: 'Beamhop Test Root (ECDSA)', ca: true })
  rsaCa = await issue({ cn: 'Beamhop Test Root (RSA)', ca: true, alg: 'rsa' })
  rsaInt = await issue({ cn: 'Beamhop Test Intermediate (RSA)', ca: true, alg: 'rsa', issuer: rsaCa })
  otherCa = await issue({ cn: 'Somebody Else Root', ca: true })
  roots = RootStore.fromPem(ca.pem + rsaCa.pem)
  leaf.ecdsa = await issue({ cn: HOST, issuer: ca })
  leaf.p384 = await issue({ cn: HOST, issuer: ca, alg: 'p384' })
  leaf.ed25519 = await issue({ cn: HOST, issuer: ca, alg: 'ed25519' })
  leaf.rsa = await issue({ cn: HOST, issuer: rsaInt, alg: 'rsa' })
}, 60_000)

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()))
})

describe('handshake and data', () => {
  for (const mode of ['memory', 'tcp'] as const) {
    for (const version of ['TLSv1.3', 'TLSv1.2'] as const) {
      it(`echoes 5 MB with odd chunk boundaries (${mode}, ${version})`, async () => {
        const s = await server(leaf.ecdsa!, { minVersion: version, maxVersion: version })
        const { sock } = await connect(s, mode, {}, true)
        expect(sock.protocolVersion).toBe(version)
        const data = randomBytes(5 * 1024 * 1024 + 123)
        const sizes = [1, 17, 16384, 16385, 70001, 3, 1 << 20, 65536, 999_983]
        const writer = (async () => {
          for (let o = 0, i = 0; o < data.length; i++) {
            const n = sizes[i % sizes.length]!
            await sock.write(data.subarray(o, o + n))
            o += n
          }
          await sock.end()
        })()
        const [got] = await Promise.all([readAll(sock.readable), writer])
        expect(got.length).toBe(data.length)
        expect(sha(got)).toBe(sha(data))
      }, 60_000)
    }
  }

  it('sends SNI and reports the cipher suite', async () => {
    // Node servers impose their own suite order by default; with that off, ours (ChaCha20 first) wins.
    const s = await server(leaf.ecdsa!, { honorCipherOrder: false })
    const { sock } = await connect(s)
    expect(await roundTrip(sock)).toBe('ping')
    expect(s.sni).toEqual([HOST])
    expect(sock.protocolVersion).toBe('TLSv1.3')
    expect(sock.cipherSuite).toBe('TLS13_CHACHA20_POLY1305_SHA256')
    sock.close()
  })

  it.each(['TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256'])('TLS 1.3 suite %s', async (suite) => {
    const s = await server(leaf.ecdsa!, { ciphers: suite, minVersion: 'TLSv1.3' })
    const { sock } = await connect(s)
    expect(sock.cipherSuite.replace('TLS13_', 'TLS_')).toBe(suite)
    expect(await roundTrip(sock, 'x'.repeat(40_000))).toBe('x'.repeat(40_000))
    sock.close()
  })

  it.each([
    ['ECDHE-ECDSA-AES128-GCM-SHA256', 'ecdsa'],
    ['ECDHE-ECDSA-CHACHA20-POLY1305', 'ecdsa'],
    ['ECDHE-RSA-AES256-GCM-SHA384', 'rsa'],
    ['ECDHE-RSA-CHACHA20-POLY1305', 'rsa'],
  ])('TLS 1.2 suite %s', async (suite, kind) => {
    const cert = kind === 'rsa' ? { key: leaf.rsa!.key, cert: leaf.rsa!.pem + rsaInt.pem } : leaf.ecdsa!
    const s = await server(cert, { ciphers: suite, maxVersion: 'TLSv1.2' })
    const { sock } = await connect(s)
    expect(sock.protocolVersion).toBe('TLSv1.2')
    expect(await roundTrip(sock)).toBe('ping')
    sock.close()
  })

  it.each(['X25519', 'P-256', 'P-384'])('key exchange group %s', async (group) => {
    const s = await server(leaf.ecdsa!, { ecdhCurve: group })
    const { sock } = await connect(s)
    expect(await roundTrip(sock)).toBe('ping')
    sock.close()
  })

  it('accepts ECDSA P-256, ECDSA P-384, Ed25519 and RSA (via intermediate) server certificates', async () => {
    expect(await outcome(leaf.ecdsa!)).toBe('ok')
    expect(await outcome(leaf.p384!)).toBe('ok')
    expect(await outcome(leaf.ed25519!)).toBe('ok')
    expect(await outcome({ key: leaf.rsa!.key, cert: leaf.rsa!.pem + rsaInt.pem })).toBe('ok')
    // RSA handshake signatures: PSS in TLS 1.3, PKCS#1 v1.5 possible in TLS 1.2
    expect(await outcome({ key: leaf.rsa!.key, cert: leaf.rsa!.pem + rsaInt.pem }, {}, { maxVersion: 'TLSv1.2', sigalgs: 'rsa_pkcs1_sha256' })).toBe('ok')
    expect(await outcome({ key: leaf.rsa!.key, cert: leaf.rsa!.pem + rsaInt.pem }, {}, { maxVersion: 'TLSv1.2', sigalgs: 'rsa_pss_rsae_sha256' })).toBe('ok')
  })

  it('delivers data the server sends immediately after its Finished', async () => {
    const s = await server(leaf.ecdsa!, {}, (sk) => sk.write('hello from server'))
    for (const mode of ['memory', 'tcp'] as const) {
      const { sock } = await connect(s, mode)
      expect(dec(await readN(sock.readable.getReader(), 17))).toBe('hello from server')
      sock.close()
    }
  })
})

describe('ALPN', () => {
  it('negotiates from the offered list, or null', async () => {
    const s = await server(leaf.ecdsa!, { ALPNProtocols: ['h2', 'http/1.1'] })
    expect((await connect(s, 'memory', { alpn: ['http/1.1'] })).sock.alpn).toBe('http/1.1')
    expect((await connect(s, 'tcp', { alpn: ['http/1.1', 'h2'] })).sock.alpn).toBe('h2')
    expect((await connect(s, 'memory', { alpn: ['h2'] })).sock.alpn).toBe('h2')
    expect((await connect(s, 'memory')).sock.alpn).toBe(null)
    const plain = await server(leaf.ecdsa!)
    expect((await connect(plain, 'memory', { alpn: ['http/1.1'] })).sock.alpn).toBe(null)
  })

  it('fails the handshake when there is no protocol in common', async () => {
    const s = await server(leaf.ecdsa!, { ALPNProtocols: ['h2'] })
    await expect(connect(s, 'memory', { alpn: ['http/1.1'] })).rejects.toMatchObject({ code: 'handshake-failed' })
  })
})

describe('certificate verification', () => {
  it('rejects a chain from an untrusted CA', async () => {
    expect(await outcome(await issue({ cn: HOST, issuer: otherCa }))).toBe('cert-untrusted')
    expect(await outcome(leaf.ecdsa!, { roots: RootStore.empty() })).toBe('cert-untrusted')
    expect(await outcome(leaf.ecdsa!, { roots: RootStore.fromPem(otherCa.pem) })).toBe('cert-untrusted')
  })

  it('rejects a self-signed leaf', async () => {
    expect(await outcome(await issue({ cn: HOST }))).toBe('cert-untrusted')
  })

  it('rejects a leaf whose intermediate is not sent, accepts it when sent', async () => {
    expect(await outcome(leaf.rsa!)).toBe('cert-untrusted')
    expect(await outcome({ key: leaf.rsa!.key, cert: leaf.rsa!.pem + rsaInt.pem })).toBe('ok')
    // order of extra certificates does not matter, unrelated ones are ignored
    expect(await outcome({ key: leaf.rsa!.key, cert: leaf.rsa!.pem + otherCa.pem + rsaInt.pem })).toBe('ok')
  })

  it('rejects the wrong hostname', async () => {
    expect(await outcome(leaf.ecdsa!, { serverName: 'other.example' })).toBe('cert-name-mismatch')
    expect(await outcome(leaf.ecdsa!, { serverName: 'beamhop.example' })).toBe('cert-name-mismatch')
    expect(await outcome(leaf.ecdsa!, { serverName: `x.${HOST}` })).toBe('cert-name-mismatch')
    expect(await outcome(leaf.ecdsa!, { serverName: HOST.toUpperCase() })).toBe('ok')
  })

  it('applies wildcard rules', async () => {
    const wild = await issue({ cn: 'wild', sans: ['*.wild.example'], issuer: ca })
    expect(await outcome(wild, { serverName: 'a.wild.example' })).toBe('ok')
    expect(await outcome(wild, { serverName: 'a.b.wild.example' })).toBe('cert-name-mismatch')
    expect(await outcome(wild, { serverName: 'wild.example' })).toBe('cert-name-mismatch')
  })

  it('ignores the subject CN when there is no SAN', async () => {
    expect(await outcome(await issue({ cn: HOST, sans: [], issuer: ca }))).toBe('cert-name-mismatch')
  })

  it('checks IP addresses against IP SANs only', async () => {
    const ip = await issue({ cn: 'ip', sans: ['127.0.0.1', 'ip.example'], issuer: ca })
    expect(await outcome(ip, { serverName: '127.0.0.1' })).toBe('ok')
    expect(await outcome(ip, { serverName: '127.0.0.2' })).toBe('cert-name-mismatch')
    expect(await outcome(leaf.ecdsa!, { serverName: '127.0.0.1' })).toBe('cert-name-mismatch')
  })

  it('rejects an expired certificate', async () => {
    const expired = await issue({ cn: HOST, issuer: ca, notBefore: new Date(Date.now() - 10 * DAY), notAfter: new Date(Date.now() - DAY) })
    expect(await outcome(expired)).toBe('cert-expired')
    // ... and a valid one once the injected clock has passed its notAfter
    expect(await outcome(leaf.ecdsa!, { now: () => new Date(Date.now() + 31 * DAY) })).toBe('cert-expired')
    // an expired cert is fine if the clock says it is still in its window
    expect(await outcome(expired, { now: () => new Date(Date.now() - 5 * DAY) })).toBe('ok')
  })

  it('rejects a not-yet-valid certificate', async () => {
    const future = await issue({ cn: HOST, issuer: ca, notBefore: new Date(Date.now() + DAY), notAfter: new Date(Date.now() + 10 * DAY) })
    expect(await outcome(future)).toBe('cert-not-yet-valid')
    expect(await outcome(leaf.ecdsa!, { now: () => new Date(Date.now() - 2 * DAY) })).toBe('cert-not-yet-valid')
  })

  it('rejects an expired intermediate', async () => {
    const oldInt = await issue({ cn: 'Old Intermediate', ca: true, issuer: ca, notBefore: new Date(Date.now() - 10 * DAY), notAfter: new Date(Date.now() - DAY) })
    const l = await issue({ cn: HOST, issuer: oldInt })
    expect(await outcome({ key: l.key, cert: l.pem + oldInt.pem })).toBe('cert-expired')
  })

  it('rejects a chain through a certificate that is not a CA', async () => {
    const notCa = await issue({ cn: 'not-a-ca.example', issuer: ca })
    const l = await issue({ cn: HOST, issuer: notCa })
    expect(['cert-untrusted', 'cert-invalid']).toContain(await outcome({ key: l.key, cert: l.pem + notCa.pem }))
  })

  it('rejects a leaf without the serverAuth extended key usage', async () => {
    expect(await outcome(await issue({ cn: HOST, issuer: ca, eku: [CLIENT_AUTH] }))).toBe('cert-invalid')
  })

  it('rejects a certificate whose signature has been tampered with', async () => {
    const der = leaf.ecdsa!.der.slice()
    der[der.length - 1]! ^= 0x01
    expect(['cert-invalid', 'cert-untrusted']).toContain(await outcome({ key: leaf.ecdsa!.key, cert: derToPem(der) }))
  })

  it('rejects a forged leaf that only copies the trusted issuer name', async () => {
    const fakeCa = await issue({ cn: 'Beamhop Test Root (ECDSA)', ca: true })
    expect(['cert-invalid', 'cert-untrusted']).toContain(await outcome(await issue({ cn: HOST, issuer: fakeCa })))
  })

  it('rejects malformed custom roots', async () => {
    const s = await server(leaf.ecdsa!)
    const c = await s.connect('memory')
    await expect(connectTls(c.transport, { serverName: HOST, roots: RootStore.fromDer([new Uint8Array([1, 2, 3])]) })).rejects.toThrow(/invalid root certificate/)
    expect(() => RootStore.fromPem('nothing here')).toThrow(TypeError)
  })
})

describe('protocol versions', () => {
  it('TLS 1.2-only server: connects with TLS 1.2; fails with protocol-version if the caller requires 1.3', async () => {
    const s = await server(leaf.ecdsa!, { maxVersion: 'TLSv1.2' })
    const { sock } = await connect(s)
    expect(sock.protocolVersion).toBe('TLSv1.2')
    expect(await roundTrip(sock)).toBe('ping')
    sock.close()
    expect(await outcome(leaf.ecdsa!, { versions: ['TLSv1.3'] }, { maxVersion: 'TLSv1.2' })).toBe('protocol-version')
  })

  it('TLS 1.3-only server: connects with TLS 1.3; fails with protocol-version if the caller allows only 1.2', async () => {
    const s = await server(leaf.ecdsa!, { minVersion: 'TLSv1.3' })
    const { sock } = await connect(s)
    expect(sock.protocolVersion).toBe('TLSv1.3')
    expect(await roundTrip(sock)).toBe('ping')
    sock.close()
    expect(await outcome(leaf.ecdsa!, { versions: ['TLSv1.2'] }, { minVersion: 'TLSv1.3' })).toBe('protocol-version')
  })

  it('TLS 1.1-only server: protocol-version', async () => {
    expect(await outcome(leaf.ecdsa!, {}, { minVersion: 'TLSv1.1', maxVersion: 'TLSv1.1', ciphers: 'DEFAULT@SECLEVEL=0' })).toBe('protocol-version')
  })

  it('TLS 1.2 server with only non-forward-secret or CBC suites: handshake-failed', async () => {
    expect(await outcome({ key: leaf.rsa!.key, cert: leaf.rsa!.pem + rsaInt.pem }, {}, { maxVersion: 'TLSv1.2', ciphers: 'AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256' })).toBe('handshake-failed')
  })
})

describe('closing', () => {
  it('ends the readable cleanly on close_notify', async () => {
    // (The server ends in response to data: a node:tls server that calls end() straight from its
    // connection callback closes the TCP socket without sending close_notify, which this client
    // correctly reports as "truncated".)
    const s = await server(leaf.ecdsa!, {}, (sk) => sk.once('data', () => sk.end('bye')))
    for (const mode of ['memory', 'tcp'] as const) {
      const { sock } = await connect(s, mode)
      await sock.write(enc('q'))
      expect(dec(await readAll(sock.readable))).toBe('bye')
      await sock.end()
    }
  })

  for (const version of ['TLSv1.3', 'TLSv1.2'] as const) {
    it(`errors the readable with "truncated" when the stream ends without close_notify (${version})`, async () => {
      const s = await server(leaf.ecdsa!, { maxVersion: version }, (sk) => sk.write('partial'))
      const { sock, serverRaw } = await connect(s, 'memory')
      const r = sock.readable.getReader()
      expect(dec(await readN(r, 7))).toBe('partial')
      serverRaw!.end() // EOF on the wire, no TLS alert
      await expect(r.read()).rejects.toMatchObject({ name: 'TlsError', code: 'truncated' })
      await expect(sock.write(enc('x'))).rejects.toMatchObject({ code: 'truncated' })
    })
  }

  it('treats an abrupt TCP close as truncation too', async () => {
    let raw: import('node:net').Socket | undefined
    const s = await server(leaf.ecdsa!, {}, (sk) => {
      sk.write('partial', () => setTimeout(() => (sk as unknown as { _handle: { close(): void } })._handle.close(), 50))
      raw = sk as unknown as import('node:net').Socket
    })
    const { sock } = await connect(s, 'tcp')
    const r = sock.readable.getReader()
    expect(dec(await readN(r, 7))).toBe('partial')
    const err = await r.read().then(
      () => undefined,
      (e: TlsError) => e,
    )
    expect(raw).toBeDefined()
    expect(err).toBeInstanceOf(TlsError)
    expect(['truncated', 'transport']).toContain(err!.code)
  })

  it('allowUncleanEof opts out of the truncation error', async () => {
    const s = await server(leaf.ecdsa!, {}, (sk) => sk.write('partial'))
    const { sock, serverRaw } = await connect(s, 'memory', { allowUncleanEof: true })
    const r = sock.readable.getReader()
    expect(dec(await readN(r, 7))).toBe('partial')
    serverRaw!.end()
    expect((await r.read()).done).toBe(true)
  })

  it('end() half-closes: the server sees EOF and can still reply', async () => {
    const s = await server(leaf.ecdsa!, { allowHalfOpen: true }, (sk) => {
      const parts: Buffer[] = []
      sk.on('data', (d: Buffer) => parts.push(d))
      sk.on('end', () => sk.end(`got ${Buffer.concat(parts).toString()}`))
    })
    for (const mode of ['memory', 'tcp'] as const) {
      const { sock } = await connect(s, mode)
      await sock.write(enc('request'))
      await sock.end()
      await expect(sock.write(enc('more'))).rejects.toMatchObject({ code: 'closed' })
      expect(dec(await readAll(sock.readable))).toBe('got request')
    }
  })

  it('close() sends close_notify, errors a pending read with "closed", and rejects later writes', async () => {
    let ended: () => void
    const serverSawEnd = new Promise<void>((r) => (ended = r))
    const s = await server(leaf.ecdsa!, {}, (sk) => {
      sk.on('end', () => ended())
      sk.resume()
    })
    const { sock } = await connect(s, 'tcp')
    const r = sock.readable.getReader()
    const pendingRead = r.read()
    sock.close()
    await expect(pendingRead).rejects.toMatchObject({ code: 'closed' })
    await expect(sock.write(enc('x'))).rejects.toMatchObject({ code: 'closed' })
    await expect(sock.end()).rejects.toMatchObject({ code: 'closed' })
    sock.close()
    await serverSawEnd // 'end' on the server's TLS socket = it received our close_notify / FIN
  })

  it('an AbortSignal aborts a stalled handshake with "closed"', async () => {
    const raw = await startRawServer(() => {}) // accepts, never answers
    const ac = new AbortController()
    const p = connectTls(await raw.connect(), { serverName: HOST, roots, signal: ac.signal })
    setTimeout(() => ac.abort(), 50)
    await expect(p).rejects.toMatchObject({ code: 'closed' })
    raw.close()
  })
})

describe('hostile or broken peers', () => {
  it.each([
    ['an HTTP error page', Buffer.from('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n')],
    ['random bytes', randomBytes(4096)],
    ['a huge bogus record', Buffer.concat([Buffer.from([0x16, 0x03, 0x03, 0xff, 0xff]), randomBytes(70000)])],
    ['an SSH banner', Buffer.from('SSH-2.0-OpenSSH_9.6\r\n')],
  ])('server that sends %s: handshake-failed', async (_name, bytes) => {
    const raw = await startRawServer((s) => s.write(bytes))
    await expect(connectTls(await raw.connect(), { serverName: HOST, roots })).rejects.toMatchObject({ name: 'TlsError', code: 'handshake-failed' })
    raw.close()
  })

  it('server that closes immediately: handshake-failed', async () => {
    const raw = await startRawServer((s) => s.end())
    await expect(connectTls(await raw.connect(), { serverName: HOST, roots })).rejects.toMatchObject({ code: 'handshake-failed' })
    raw.close()
  })

  it('server that truncates its handshake flight: handshake-failed', async () => {
    const s = await server(leaf.ecdsa!)
    const c = await s.connect('memory')
    // forward only the first 200 bytes of the server's reply, then EOF
    const r = c.transport.readable.getReader()
    let sent = false
    const cut = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        if (sent) return ctl.close()
        const { value } = await r.read()
        sent = true
        ctl.enqueue(value!.subarray(0, 200))
      },
    })
    await expect(connectTls({ ...c.transport, readable: cut }, { serverName: HOST, roots })).rejects.toMatchObject({ code: 'handshake-failed' })
  })

  it('garbage injected after the handshake: delivers earlier data, then protocol-error', async () => {
    const s = await server(leaf.ecdsa!, {}, (sk) => sk.write('good'))
    const { sock, serverRaw } = await connect(s, 'memory')
    const r = sock.readable.getReader()
    expect(dec(await readN(r, 4))).toBe('good')
    serverRaw!.write(Buffer.concat([Buffer.from([0x17, 0x03, 0x03, 0x00, 0x40]), randomBytes(64)]))
    await expect(r.read()).rejects.toMatchObject({ code: 'protocol-error' })
  })

  it('a flipped ciphertext bit is detected', async () => {
    const s = await server(leaf.ecdsa!, {}, (sk) => sk.on('data', () => sk.write('y'.repeat(1000))))
    const c = await s.connect('memory')
    let flip = false
    const src = c.transport.readable.getReader()
    const tampered = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        const { done, value } = await src.read()
        if (done) return ctl.close()
        if (flip) value[value.length - 20]! ^= 0x80
        ctl.enqueue(value)
      },
    })
    const sock = await connectTls({ ...c.transport, readable: tampered }, { serverName: HOST, roots })
    flip = true
    await sock.write(enc('go'))
    await expect(readAll(sock.readable)).rejects.toMatchObject({ code: 'protocol-error' })
  })

  it('a transport write failure surfaces as "transport"', async () => {
    const s = await server(leaf.ecdsa!)
    const c = await s.connect('memory')
    let broken = false
    const sock = await connectTls(
      {
        ...c.transport,
        write: (b) => {
          if (broken) throw new Error('pipe burst')
          return c.transport.write(b)
        },
      },
      { serverName: HOST, roots },
    )
    broken = true
    await expect(sock.write(enc('x'))).rejects.toMatchObject({ code: 'transport' })
    await expect(readAll(sock.readable)).rejects.toMatchObject({ code: 'transport' })
  })
})

describe('bundled Mozilla roots', () => {
  it('load lazily, carry provenance, and do not trust the test CA', async () => {
    const moz = await RootStore.mozilla()
    expect(moz.info!.count).toBeGreaterThan(100)
    expect(moz.info!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(await outcome(leaf.ecdsa!, { roots: moz })).toBe('cert-untrusted')
    expect(await outcome(leaf.ecdsa!, { roots: RootStore.concat(moz, roots) })).toBe('ok')
  })
})
