import net from 'node:net'
import tls from 'node:tls'
import { duplexPair, type Duplex } from 'node:stream'
import { once } from 'node:events'
import type { TlsTransport } from '../../src/index'

export interface NodeTransportOptions {
  /** Re-split bytes in both directions into awkward sizes (1 byte up to a few KB), cycling. */
  rechunk?: boolean
}

const ODD = [1, 2, 3, 5, 1, 7, 13, 4096, 31, 16389, 1, 257, 5, 65537, 3, 1021]

/** Adapt any Node duplex (a TCP socket, or one side of an in-memory pair) to a TlsTransport. */
export function nodeTransport(duplex: Duplex, opts: NodeTransportOptions = {}): TlsTransport {
  let i = 0
  const split = (buf: Uint8Array): Uint8Array[] => {
    if (!opts.rechunk) return [buf]
    const out: Uint8Array[] = []
    for (let o = 0; o < buf.length; ) {
      const n = ODD[i++ % ODD.length]!
      out.push(buf.slice(o, o + n))
      o += n
    }
    return out
  }
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      duplex.on('data', (d: Buffer) => {
        for (const part of split(new Uint8Array(d))) c.enqueue(part)
      })
      duplex.on('end', () => {
        try {
          c.close()
        } catch {}
      })
      duplex.on('error', (e) => {
        try {
          c.error(e)
        } catch {}
      })
      duplex.on('close', () => {
        try {
          c.error(new Error('socket closed'))
        } catch {}
      })
    },
  })
  return {
    readable,
    async write(bytes) {
      for (const part of split(bytes)) {
        await new Promise<void>((resolve, reject) => duplex.write(part, (e) => (e ? reject(e) : resolve())))
      }
    },
    end: () => void duplex.end(),
    close: () => void duplex.destroy(),
  }
}

export type Mode = 'memory' | 'tcp'

export interface TestServer {
  port: number
  /** A fresh client-side transport: over loopback TCP, or an in-memory pair. */
  connect(mode: Mode, opts?: NodeTransportOptions): Promise<{ transport: TlsTransport; raw: Duplex; serverRaw?: Duplex }>
  close(): Promise<void>
  /** SNI values seen. */
  sni: (string | false)[]
}

/** A node:tls server on 127.0.0.1. `handler` gets each established TLS socket. */
export async function startTlsServer(options: tls.TlsOptions, handler: (s: tls.TLSSocket) => void): Promise<TestServer> {
  const sni: (string | false)[] = []
  const server = tls.createServer(options, (s) => {
    sni.push((s as tls.TLSSocket & { servername?: string | false }).servername ?? false)
    s.on('error', () => {})
    handler(s)
  })
  server.on('tlsClientError', () => {})
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as net.AddressInfo).port
  const open = new Set<Duplex>()
  return {
    port,
    sni,
    async connect(mode, opts) {
      if (mode === 'tcp') {
        const raw = net.connect(port, '127.0.0.1')
        raw.on('error', () => {})
        open.add(raw)
        await once(raw, 'connect')
        return { transport: nodeTransport(raw, opts), raw }
      }
      const [raw, serverRaw] = duplexPair()
      raw.on('error', () => {})
      serverRaw.on('error', () => {})
      open.add(raw).add(serverRaw)
      server.emit('connection', serverRaw)
      return { transport: nodeTransport(raw, opts), raw, serverRaw }
    },
    async close() {
      for (const s of open) s.destroy()
      server.close()
      await once(server, 'close').catch(() => {})
    },
  }
}

/** A plain TCP server (for servers that do not speak TLS). */
export async function startRawServer(handler: (s: net.Socket) => void): Promise<{ port: number; connect(): Promise<TlsTransport>; close(): void }> {
  const server = net.createServer((s) => {
    s.on('error', () => {})
    handler(s)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as net.AddressInfo).port
  const socks: net.Socket[] = []
  return {
    port,
    async connect() {
      const raw = net.connect(port, '127.0.0.1')
      raw.on('error', () => {})
      socks.push(raw)
      await once(raw, 'connect')
      return nodeTransport(raw)
    },
    close() {
      for (const s of socks) s.destroy()
      server.close()
    },
  }
}

export async function readAll(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const r = readable.getReader()
  for (;;) {
    const { done, value } = await r.read()
    if (done) break
    parts.push(value)
  }
  return Buffer.concat(parts)
}

export async function readN(reader: ReadableStreamDefaultReader<Uint8Array>, n: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let got = 0
  while (got < n) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`stream ended after ${got} of ${n} bytes`)
    parts.push(value)
    got += value.length
  }
  return Buffer.concat(parts)
}
