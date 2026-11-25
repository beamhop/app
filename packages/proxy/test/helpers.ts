// Local targets and helpers for the proxy tests. Everything listens on 127.0.0.1, ephemeral ports.
import { createHash } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { DEFAULT_CONFIG, type ProxyConfig } from '../src/core'
import { startProxy, type ProxyOptions, type RunningProxy } from '../src/node'

export const TOKEN = 'test-token_1'

const cleanups: (() => Promise<unknown> | unknown)[] = []
export function onCleanup(fn: () => Promise<unknown> | unknown): void {
  cleanups.push(fn)
}
export async function runCleanups(): Promise<void> {
  for (const fn of cleanups.splice(0).reverse()) await fn()
}

/** A proxy on an ephemeral port that may reach loopback targets unless overridden. */
export async function proxy(over: Partial<ProxyConfig> = {}, options: ProxyOptions = {}): Promise<RunningProxy> {
  const p = await startProxy({ ...DEFAULT_CONFIG, tokens: [TOKEN], allowPrivate: true, port: 0, connectTimeoutMs: 5000, ...over }, options)
  onCleanup(() => p.close(200))
  return p
}

export function listen(server: net.Server | http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
    onCleanup(() => new Promise((r) => {
      if ('closeAllConnections' in server) server.closeAllConnections()
      server.close(r)
    }))
  })
}

function tcpServer(handler: (sock: net.Socket) => void): Promise<{ port: number; sockets: net.Socket[] }> {
  const sockets: net.Socket[] = []
  const server = net.createServer({ allowHalfOpen: true }, (sock) => {
    sockets.push(sock)
    sock.on('error', () => {})
    handler(sock)
  })
  onCleanup(() => sockets.forEach((s) => s.destroy()))
  return listen(server).then((port) => ({ port, sockets }))
}

/** Echoes bytes; ends its side when the client ends. */
export function echoServer(): Promise<{ port: number; sockets: net.Socket[] }> {
  return tcpServer((sock) => {
    sock.on('data', (d) => sock.write(d))
    sock.on('end', () => sock.end())
  })
}

/** Reads until the client half-closes, then answers `<bytes> <sha256>` and ends. Proves half-close. */
export function digestServer(options: { startPaused?: boolean } = {}): Promise<{ port: number; sockets: net.Socket[]; received: () => number }> {
  let received = 0
  return tcpServer((sock) => {
    const hash = createHash('sha256')
    sock.on('data', (d) => {
      received += d.length
      hash.update(d)
    })
    sock.on('end', () => sock.end(`${received} ${hash.digest('hex')}`))
    if (options.startPaused) sock.pause()
  }).then((s) => ({ ...s, received: () => received }))
}

/** Deterministic test data: `size` bytes in 64 KiB chunks. */
export function* pattern(size: number, chunk = 64 * 1024): Generator<Buffer> {
  let seed = 1
  for (let off = 0; off < size; off += chunk) {
    const b = Buffer.allocUnsafe(Math.min(chunk, size - off))
    for (let i = 0; i < b.length; i += 4096) b.fill((seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff, i, i + 4096)
    b.writeUInt32LE(off >>> 0, 0)
    yield b
  }
}

export function patternDigest(size: number): string {
  const hash = createHash('sha256')
  for (const b of pattern(size)) hash.update(b)
  return hash.digest('hex')
}

/** Sends `size` pattern bytes to each client as fast as the socket takes them, then ends. */
export function sourceServer(size: number): Promise<{ port: number; sockets: net.Socket[] }> {
  return tcpServer((sock) => {
    const gen = pattern(size)
    const pump = (): void => {
      for (;;) {
        const { value, done } = gen.next()
        if (done) return void sock.end()
        if (!sock.write(value)) return void sock.once('drain', pump)
      }
    }
    sock.on('data', () => {})
    pump()
  })
}

/** A port on 127.0.0.1 with nothing listening. */
export async function closedPort(): Promise<number> {
  const server = net.createServer()
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
  await new Promise((r) => server.close(r))
  return port
}

/** Resolves once `read()` has returned the same value on `rounds` consecutive checks. */
export async function settled(read: () => number, rounds = 4, everyMs = 50): Promise<number> {
  let last = read()
  for (let same = 0; same < rounds;) {
    await new Promise((r) => setTimeout(r, everyMs))
    const now = read()
    same = now === last ? same + 1 : 0
    last = now
  }
  return last
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = []
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) parts.push(chunk)
  return Buffer.concat(parts)
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
