// @beamhop/tls: a TLS 1.3 / 1.2 client that runs over any byte stream, for use inside a browser
// worker. Protocol and certificate verification are rustls + rustls-webpki + ring compiled to
// wasm (see README.md); this file is the stream plumbing around that engine.
import { RootStore } from './roots'
import { loadWasm } from './wasm'
import type { Conn } from './generated/beamhop_tls_wasm.js'

export { RootStore, type RootStoreInfo } from './roots'
export { initTls, type WasmSource } from './wasm'

/**
 * The byte stream TLS runs over (a TCP connection, typically tunnelled).
 * - `readable`: bytes from the peer, any chunking. Closing it means the peer sent FIN.
 * - `write`: send bytes; a returned promise is awaited before more is written (backpressure).
 * - `end`: half-close (FIN) after everything written so far; reading continues.
 * - `close`: tear down both directions now. Must be safe to call more than once and after `end`.
 */
export interface TlsTransport {
  readonly readable: ReadableStream<Uint8Array>
  write(bytes: Uint8Array): void | Promise<void>
  end(): void
  close(): void
}

export type TlsVersion = 'TLSv1.2' | 'TLSv1.3'

export type TlsErrorCode =
  /** The chain does not lead to a trusted root (includes self-signed leaves). */
  | 'cert-untrusted'
  /** The certificate is not valid for `serverName`. */
  | 'cert-name-mismatch'
  /** A certificate in the chain is past its notAfter. */
  | 'cert-expired'
  /** A certificate in the chain is before its notBefore (often: wrong local clock). */
  | 'cert-not-yet-valid'
  /** Any other certificate failure: bad signature, bad encoding, wrong key usage, unsupported algorithm, ... */
  | 'cert-invalid'
  /** No mutually supported protocol version (peer is TLS <= 1.1, or outside `versions`). */
  | 'protocol-version'
  /** Any other failure before the handshake completed (alerts, garbage, EOF, bad parameters). */
  | 'handshake-failed'
  /** A fatal TLS error after the handshake (bad record, fatal alert from the peer). */
  | 'protocol-error'
  /** The transport ended without a close_notify alert: the data may have been cut short. */
  | 'truncated'
  /** The underlying transport failed (its readable errored or a write rejected). */
  | 'transport'
  /** The socket was closed locally (or aborted), or written to after `end()`/`close()`. */
  | 'closed'

export class TlsError extends Error {
  override readonly name = 'TlsError'
  constructor(
    readonly code: TlsErrorCode,
    message?: string,
    options?: { cause?: unknown },
  ) {
    super(message ? `${code}: ${message}` : code, options)
  }
}

export interface TlsOptions {
  /** DNS name (or IP address literal) to verify the certificate against. Sent as SNI when it is a DNS name. */
  serverName: string
  /** ALPN protocols to offer, most preferred first, e.g. `['http/1.1']`. */
  alpn?: string[]
  /** Trust anchors. Default: the bundled Mozilla set (`RootStore.mozilla()`, loaded lazily). */
  roots?: RootStore
  /** Clock used for certificate validity. Default: `() => new Date()`. */
  now?: () => Date
  /** Protocol versions to allow. Default: both, preferring 1.3. */
  versions?: TlsVersion[]
  /**
   * Set to accept end-of-stream without close_notify as a clean end of `readable`. Only safe
   * when the application protocol frames its own messages (e.g. HTTP with Content-Length or
   * chunked encoding, and the caller checks completeness). Default false.
   */
  allowUncleanEof?: boolean
  /** Aborting rejects a pending `connectTls` with `closed` and closes the transport. Ignored once connected. */
  signal?: AbortSignal
}

export interface TlsSocket {
  /** Decrypted bytes from the peer. Ends when the peer sends close_notify; errors with a
   *  `TlsError` otherwise (`truncated`, `protocol-error`, `transport`, `closed`). Reading drives
   *  the connection: nothing is pulled from the transport unless this stream is being read. */
  readonly readable: ReadableStream<Uint8Array>
  /** Negotiated ALPN protocol, or null if the server selected none. */
  readonly alpn: string | null
  readonly protocolVersion: TlsVersion
  /** IANA name of the negotiated cipher suite, e.g. `TLS13_CHACHA20_POLY1305_SHA256`. */
  readonly cipherSuite: string
  /** Encrypt and send. Resolves when the transport has accepted the bytes. */
  write(bytes: Uint8Array): Promise<void>
  /** Send close_notify and half-close the transport. `readable` stays usable until the peer closes. */
  end(): Promise<void>
  /** Tear down now (best-effort close_notify). A `readable` that has not ended errors with `closed`. */
  close(): void
}

const CLASS_TO_CODE: Record<number, TlsErrorCode> = {
  1: 'cert-untrusted',
  2: 'cert-name-mismatch',
  3: 'cert-expired',
  4: 'cert-not-yet-valid',
  5: 'cert-invalid',
  6: 'protocol-version',
}

/** Plaintext per encrypt call: keeps wasm buffers small and gives the transport regular backpressure points. */
const WRITE_CHUNK = 64 * 1024

function encodeAlpn(alpn: string[]): Uint8Array {
  const enc = new TextEncoder()
  const parts = alpn.map((p) => enc.encode(p))
  const out = new Uint8Array(parts.reduce((n, p) => n + 1 + p.length, 0))
  let o = 0
  for (const p of parts) {
    if (p.length === 0 || p.length > 255) throw new TypeError('invalid ALPN protocol name')
    out[o++] = p.length
    out.set(p, o)
    o += p.length
  }
  return out
}

/**
 * Run a TLS handshake over `transport` and return the encrypted socket. The promise rejects
 * with a `TlsError`; on rejection the transport has been closed.
 */
export async function connectTls(transport: TlsTransport, options: TlsOptions): Promise<TlsSocket> {
  const nowSecs = () => (options.now ? options.now() : new Date()).getTime() / 1000
  const versions = options.versions ?? ['TLSv1.3', 'TLSv1.2']
  const mask = (versions.includes('TLSv1.2') ? 1 : 0) | (versions.includes('TLSv1.3') ? 2 : 0)

  let conn: Conn | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  /** Set once: the first fatal condition. Everything after reports it. */
  let failure: TlsError | undefined
  let destroyed = false

  const destroy = () => {
    if (destroyed) return
    destroyed = true
    conn?.free()
    conn = undefined
    reader?.cancel().catch(() => {})
    try {
      transport.close()
    } catch {}
  }

  // All ciphertext goes through this chain so records reach the transport in the order the
  // engine produced them, whoever triggered them (handshake, write, key update, alert).
  let chain: Promise<void> = Promise.resolve()
  const send = (): Promise<void> => {
    const out = conn?.take_tls()
    if (!out || out.length === 0) return chain
    const next = chain.then(() => {
      if (destroyed) throw failure ?? new TlsError('closed')
      return transport.write(out)
    })
    chain = next.catch(() => {})
    return next
  }

  const engineError = (cls: number, handshaking: boolean): TlsError =>
    new TlsError(CLASS_TO_CODE[cls] ?? (handshaking ? 'handshake-failed' : 'protocol-error'), conn?.err_msg())

  const abort = () => {
    failure ??= new TlsError('closed', 'aborted')
    destroy()
  }

  try {
    if (mask === 0) throw new TlsError('protocol-version', 'no protocol versions enabled')
    options.signal?.throwIfAborted()
    options.signal?.addEventListener('abort', abort)
    const alpnWire = encodeAlpn(options.alpn ?? [])
    const wasm = await loadWasm()
    const roots = (options.roots ?? (await RootStore.mozilla()))._handle(wasm)
    if (destroyed) throw failure
    try {
      conn = new wasm.Conn(roots, options.serverName, alpnWire, mask, nowSecs())
    } catch (e) {
      throw new TlsError('handshake-failed', e instanceof Error ? e.message : String(e))
    }
    reader = transport.readable.getReader()
    await send()
    while (conn.is_handshaking()) {
      const { done, value } = await reader.read()
      if (destroyed) throw failure
      if (done) throw new TlsError('handshake-failed', 'transport closed during handshake')
      const cls = conn.feed(value, nowSecs())
      if (cls !== 0) {
        const err = engineError(cls, true)
        await send().catch(() => {}) // the alert, best effort
        throw err
      }
      await send()
      if (destroyed) throw failure
    }
  } catch (e) {
    const err = failure ?? (e instanceof TlsError ? e : e instanceof TypeError ? e : new TlsError(reader ? 'transport' : 'handshake-failed', e instanceof Error ? e.message : String(e), { cause: e }))
    options.signal?.removeEventListener('abort', abort)
    destroy()
    throw err
  }
  options.signal?.removeEventListener('abort', abort)

  const rd = reader
  const alpnBytes = conn.alpn()
  const alpn = alpnBytes ? new TextDecoder().decode(alpnBytes) : null
  const protocolVersion: TlsVersion = conn.version() === 0x0304 ? 'TLSv1.3' : 'TLSv1.2'
  const cipherSuite = conn.cipher_suite()

  let controller!: ReadableStreamDefaultController<Uint8Array>
  let readDone = false // readable closed or errored
  let writeDone = false // end() called
  /** Application data that arrived in the same flight as the end of the handshake. */
  let pending: Uint8Array | undefined = conn.take_plain()

  const fail = (err: TlsError) => {
    failure ??= err
    if (!readDone) {
      readDone = true
      controller.error(failure)
    }
    destroy()
  }
  const finishRead = () => {
    readDone = true
    controller.close()
    if (writeDone) void chain.then(destroy)
  }

  const readable = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c
      },
      async pull() {
        for (;;) {
          if (readDone) return
          if (pending && pending.length > 0) {
            controller.enqueue(pending)
            pending = undefined
            return
          }
          if (conn?.peer_closed()) return finishRead()
          let res: ReadableStreamReadResult<Uint8Array>
          try {
            res = await rd.read()
          } catch (e) {
            return fail(new TlsError('transport', e instanceof Error ? e.message : String(e), { cause: e }))
          }
          if (readDone || !conn) return
          if (res.done) {
            if (options.allowUncleanEof) return finishRead()
            return fail(new TlsError('truncated', 'transport ended without close_notify'))
          }
          const cls = conn.feed(res.value, nowSecs())
          pending = conn.take_plain()
          send().catch((e) => fail(e instanceof TlsError ? e : new TlsError('transport', String(e), { cause: e })))
          if (cls !== 0) {
            // Records before the bad one were authenticated: deliver them, then error.
            const err = engineError(cls, false)
            if (pending.length > 0) controller.enqueue(pending)
            pending = undefined
            failure ??= err
            // Let the alert go out before tearing down; the next pull reports the error.
            await chain
            if (controller.desiredSize !== null && controller.desiredSize > 0) return fail(err)
            failAfterDrain = err
            return
          }
        }
      },
      cancel() {
        readDone = true
        socket.close()
      },
    },
    { highWaterMark: 0 },
  )
  let failAfterDrain: TlsError | undefined
  // With highWaterMark 0, pull runs once per pending read; wrap it so a deferred error is
  // reported on the read after the last good chunk.
  const src = readable
  const outReadable = failAfterDrainStream()
  function failAfterDrainStream(): ReadableStream<Uint8Array> {
    const r = src.getReader()
    return new ReadableStream<Uint8Array>(
      {
        async pull(c) {
          if (failAfterDrain) {
            const err = failAfterDrain
            failAfterDrain = undefined
            fail(err)
          }
          try {
            const { done, value } = await r.read()
            if (done) c.close()
            else c.enqueue(value)
          } catch (e) {
            c.error(e)
          }
        },
        cancel(reason) {
          return r.cancel(reason)
        },
      },
      { highWaterMark: 0 },
    )
  }

  const socket: TlsSocket = {
    readable: outReadable,
    alpn,
    protocolVersion,
    cipherSuite,
    async write(bytes) {
      for (let off = 0; off < bytes.length || off === 0; off += WRITE_CHUNK) {
        if (!conn || writeDone) throw failure ?? new TlsError('closed')
        if (!conn.write(bytes.subarray(off, off + WRITE_CHUNK))) throw failure ?? new TlsError('closed')
        try {
          await send()
        } catch (e) {
          const err = e instanceof TlsError ? e : new TlsError('transport', e instanceof Error ? e.message : String(e), { cause: e })
          fail(err)
          throw failure ?? err
        }
        if (bytes.length === 0) break
      }
    },
    async end() {
      if (writeDone) return
      if (!conn) throw failure ?? new TlsError('closed')
      writeDone = true
      conn.send_close_notify()
      try {
        await send()
        transport.end()
      } catch (e) {
        const err = e instanceof TlsError ? e : new TlsError('transport', e instanceof Error ? e.message : String(e), { cause: e })
        fail(err)
        throw failure ?? err
      }
      if (readDone) destroy()
    },
    close() {
      if (destroyed) return
      failure ??= new TlsError('closed')
      if (conn && !writeDone) {
        // Best effort: hand close_notify to the transport synchronously if nothing is queued.
        writeDone = true
        conn.send_close_notify()
        const out = conn.take_tls()
        try {
          void Promise.resolve(transport.write(out)).catch(() => {})
        } catch {}
      }
      if (!readDone) {
        readDone = true
        controller.error(failure)
      }
      destroy()
    },
  }
  return socket
}
