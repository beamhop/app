// Runs inside a dedicated worker in the browser. Test code: a minimal HTTP/1.1 client over
// @beamhop/tls, plus timing. The page posts one job and gets one result back.
import { connectTls, initTls, RootStore, TlsError, type TlsOptions, type TlsSocket } from '../src/index'
import { openTunnel } from '../src/tunnel'

declare const self: DedicatedWorkerGlobalScope

interface Target {
  relay: string
  host: string
  port: number
  serverName: string
}
interface Job {
  target: Target
  bulk: Record<string, Target>
  rsa: Target
  caPem: string
  bulkMb: number
  handshakes: number
  public?: Target
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d

async function dial(t: Target, opts: Partial<TlsOptions>) {
  const t0 = performance.now()
  const transport = await openTunnel({ proxy: t.relay, host: t.host, port: t.port })
  const t1 = performance.now()
  const sock = await connectTls(transport, { serverName: t.serverName, alpn: ['http/1.1'], ...opts })
  return { sock, tunnelMs: t1 - t0, handshakeMs: performance.now() - t1 }
}

/** Incremental reader over the plaintext stream. */
class Reader {
  #r: ReadableStreamDefaultReader<Uint8Array>
  #buf = new Uint8Array(0)
  constructor(sock: TlsSocket) {
    this.#r = sock.readable.getReader()
  }
  async #more(): Promise<boolean> {
    const { done, value } = await this.#r.read()
    if (done) return false
    const n = new Uint8Array(this.#buf.length + value.length)
    n.set(this.#buf)
    n.set(value, this.#buf.length)
    this.#buf = n
    return true
  }
  async line(): Promise<string> {
    for (;;) {
      const i = this.#buf.indexOf(10)
      if (i >= 0) {
        const s = dec.decode(this.#buf.subarray(0, i)).replace(/\r$/, '')
        this.#buf = this.#buf.subarray(i + 1)
        return s
      }
      if (!(await this.#more())) throw new Error('unexpected end of stream in line')
    }
  }
  /** Calls `sink` with up to n bytes as they arrive (no copying of large bodies). */
  async bytes(n: number, sink: (b: Uint8Array) => void): Promise<void> {
    while (n > 0) {
      if (this.#buf.length === 0) {
        const { done, value } = await this.#r.read()
        if (done) throw new Error('unexpected end of stream in body')
        this.#buf = value
      }
      const take = this.#buf.subarray(0, n)
      this.#buf = this.#buf.subarray(take.length)
      n -= take.length
      sink(take)
    }
  }
  async head(): Promise<{ status: number; headers: Record<string, string> }> {
    const status = Number((await this.line()).split(' ')[1])
    const headers: Record<string, string> = {}
    for (let l = await this.line(); l !== ''; l = await this.line()) {
      const i = l.indexOf(':')
      headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim()
    }
    return { status, headers }
  }
  /** Decodes a chunked body, reporting each HTTP chunk as it completes. */
  async chunked(onChunk: (b: Uint8Array) => void): Promise<void> {
    for (;;) {
      const size = parseInt(await this.line(), 16)
      if (Number.isNaN(size)) throw new Error('bad chunk size')
      if (size === 0) {
        await this.line()
        return
      }
      const parts: Uint8Array[] = []
      await this.bytes(size, (b) => parts.push(b))
      await this.line()
      for (const p of parts) onChunk(p)
    }
  }
}

async function run(job: Job) {
  const out: Record<string, unknown> = {
    crossOriginIsolated: self.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    isWorker: typeof DedicatedWorkerGlobalScope !== 'undefined' && self instanceof DedicatedWorkerGlobalScope,
    webcrypto: { x25519: await supports('X25519'), ed25519: await supports('Ed25519') },
  }
  let t = performance.now()
  await initTls('/tls.wasm')
  out.wasmInitMs = round(performance.now() - t)
  const roots = RootStore.fromPem(job.caPem)

  // 1. HTTP/1.1 GET with a streamed, chunked response.
  {
    const { sock } = await dial(job.target, { roots })
    out.alpn = sock.alpn
    out.protocolVersion = sock.protocolVersion
    out.cipherSuite = sock.cipherSuite
    await sock.write(enc.encode(`GET /stream HTTP/1.1\r\nHost: ${job.target.serverName}\r\nConnection: close\r\n\r\n`))
    const rd = new Reader(sock)
    const head = await rd.head()
    const arrivals: { at: number; text: string }[] = []
    const t0 = performance.now()
    await rd.chunked((b) => arrivals.push({ at: round(performance.now() - t0), text: dec.decode(b) }))
    out.stream = { status: head.status, transferEncoding: head.headers['transfer-encoding'], arrivals }
    // Connection: close => the server ends with close_notify; a clean end proves it was seen.
    let clean = false
    try {
      await rd.bytes(1, () => {})
    } catch (e) {
      clean = !(e instanceof TlsError)
    }
    out.cleanClose = clean
    await sock.end().catch(() => {})
    sock.close()
  }

  // 2. Rejections, in the browser.
  const code = (p: Promise<{ sock: TlsSocket }>) =>
    p.then(
      ({ sock }) => (sock.close(), 'ok'),
      (e) => (e instanceof TlsError ? e.code : `unexpected: ${e}`),
    )
  t = performance.now()
  const untrusted = await code(dial(job.target, {})) // default roots = bundled Mozilla set (lazy chunk)
  out.rejects = {
    mozillaRootsVsTestCa: untrusted,
    wrongName: await code(dial({ ...job.target, serverName: 'wrong.example' }, { roots })),
    tls12Only: await code(dial(job.target, { roots, versions: ['TLSv1.2'] })),
  }
  out.mozillaRoots = (await RootStore.mozilla()).info

  // 3. Handshake timing (full handshakes, no resumption), tunnel setup excluded.
  const hs: Record<string, unknown> = {}
  for (const [name, target, opts] of [
    ['tls13-ecdsa-p256', job.target, {}],
    ['tls12-ecdsa-p256', job.target, { versions: ['TLSv1.2'] }],
    ['tls13-rsa2048-chain', job.rsa, {}],
  ] as [string, Target, Partial<TlsOptions>][]) {
    const ms: number[] = []
    const tun: number[] = []
    for (let i = 0; i < job.handshakes; i++) {
      const r = await dial(target, { roots, ...opts }).catch((e) => e as Error)
      if (r instanceof Error) {
        hs[name] = `failed: ${r.message}`
        break
      }
      ms.push(r.handshakeMs)
      tun.push(r.tunnelMs)
      r.sock.close()
    }
    if (ms.length) hs[name] = { n: ms.length, medianMs: round(median(ms)), minMs: round(Math.min(...ms)), maxMs: round(Math.max(...ms)), tunnelMedianMs: round(median(tun)) }
  }
  out.handshake = hs

  // 4. Bulk throughput per cipher suite: download (server -> worker) and upload.
  const bulk: Record<string, unknown> = {}
  const total = job.bulkMb * 1024 * 1024
  for (const [name, target] of Object.entries(job.bulk)) {
    const d = await dial(target, { roots })
    await d.sock.write(enc.encode(`GET /bulk?bytes=${total} HTTP/1.1\r\nHost: ${target.serverName}\r\nConnection: close\r\n\r\n`))
    const rd = new Reader(d.sock)
    const head = await rd.head()
    let got = 0
    let sum = 0
    let t0 = performance.now()
    await rd.bytes(Number(head.headers['content-length']), (b) => {
      got += b.length
      sum = (sum + b[0]! + b[b.length - 1]!) >>> 0
    })
    const downMs = performance.now() - t0
    d.sock.close()

    const u = await dial(target, { roots })
    const block = new Uint8Array(1 << 20).fill(0x61)
    await u.sock.write(enc.encode(`POST /sink HTTP/1.1\r\nHost: ${target.serverName}\r\nContent-Length: ${total}\r\nConnection: close\r\n\r\n`))
    t0 = performance.now()
    for (let sent = 0; sent < total; sent += block.length) await u.sock.write(block)
    const urd = new Reader(u.sock)
    const uhead = await urd.head() // the server answers only after it has received everything
    const upMs = performance.now() - t0
    let reply = ''
    await urd.bytes(Number(uhead.headers['content-length']), (b) => (reply += dec.decode(b)))
    u.sock.close()
    bulk[name] = { cipherSuite: d.sock.cipherSuite, mb: job.bulkMb, downloadOk: got === total && sum > 0, downloadMBps: round((got / 1048576 / downMs) * 1000), uploadOk: reply === String(total), uploadMBps: round((total / 1048576 / upMs) * 1000) }
  }
  out.bulk = bulk

  // 5. Optional: a real public host with the bundled Mozilla roots. Sends only `HEAD /`.
  if (job.public) {
    try {
      const { sock, handshakeMs } = await dial(job.public, {})
      await sock.write(enc.encode(`HEAD / HTTP/1.1\r\nHost: ${job.public.serverName}\r\nConnection: close\r\n\r\n`))
      const head = await new Reader(sock).head()
      out.public = { ok: true, host: job.public.serverName, status: head.status, protocolVersion: sock.protocolVersion, cipherSuite: sock.cipherSuite, alpn: sock.alpn, handshakeMs: round(handshakeMs) }
      sock.close()
    } catch (e) {
      out.public = { ok: false, host: job.public.serverName, error: String(e) }
    }
  }
  return out
}

/** Informational only: this package does not use WebCrypto. */
async function supports(name: string): Promise<boolean> {
  try {
    await crypto.subtle.generateKey({ name }, false, name === 'X25519' ? ['deriveBits'] : ['sign', 'verify'])
    return true
  } catch {
    return false
  }
}

self.onmessage = (ev: MessageEvent<Job>) => {
  run(ev.data).then(
    (result) => self.postMessage({ result }),
    (e) => self.postMessage({ error: e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e) }),
  )
}
