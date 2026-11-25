// The machine has no network of its own. Everything that leaves goes through a NetBroker, which the frame
// implements over the MessagePort to the app (`sock.*` and `http.*` in protocol.ts). Tests implement it directly.

export type NetMode = 'tunnel' | 'http' | 'none'

export class NetError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'NetError'
  }
}

export interface SocketEvents {
  data(chunk: Uint8Array): void
  /** The remote side finished sending (FIN). */
  end(): void
  /** The connection is gone. `error` is set when it did not close cleanly. */
  close(error?: string): void
}

/** A raw TCP connection through the app's tunnel. */
export interface SocketChannel {
  /** Resolves when the connection is established; rejects with a NetError (code: auth, policy, dns, connect, ...). */
  readonly opened: Promise<void>
  write(chunk: Uint8Array): void
  /** Half-close: no more data from this side. */
  end(): void
  close(): void
}

export interface HttpRequestInit {
  url: string
  method: string
  headers: [string, string][]
  /** The whole request body, or null. Request bodies are buffered by the HTTP bridge. */
  body: Uint8Array | null
}

export interface HttpResponseEvents {
  body(chunk: Uint8Array): void
  end(): void
  abort(error?: string): void
}

/** One HTTP exchange made on the machine's behalf (the proxy's plain mode, or a direct CORS fetch by the app). */
export interface HttpExchange {
  /** Resolves with status and headers; rejects with a NetError. Body events follow. */
  readonly response: Promise<{ status: number; headers: [string, string][] }>
  abort(): void
}

export interface NetBroker {
  openSocket(host: string, port: number, events: SocketEvents): SocketChannel
  openHttp(request: HttpRequestInit, events: HttpResponseEvents): HttpExchange
}

/**
 * TLS hook. TLS for tunnel mode must run inside the machine (the proxy stays blind), and is built separately
 * (`packages/tls`). These two interfaces are structural copies of that package's `TlsTransport` and `TlsSocket`,
 * so its `connectTls` can be passed as a TlsConnector without this package depending on it.
 *
 * TODO(tls): the frame worker does not install a connector yet. Until it does, `tls.connect` and `https:` requests
 * in tunnel mode fail with ERR_TLS_NOT_AVAILABLE. In http mode the proxy terminates TLS, so they work there.
 */
export interface ByteTransport {
  readonly readable: ReadableStream<Uint8Array>
  write(bytes: Uint8Array): void | Promise<void>
  end(): void
  close(): void
}
export interface SecureTransport {
  readonly readable: ReadableStream<Uint8Array>
  readonly alpn?: string | null
  readonly protocolVersion?: string
  readonly cipherSuite?: string
  write(bytes: Uint8Array): Promise<void>
  end(): Promise<void>
  close(): void
}
export type TlsConnector = (transport: ByteTransport, options: { serverName: string; alpn?: string[] }) => Promise<SecureTransport>

/** A broker for a machine that is not connected to anything. */
export const noNetwork: NetBroker = {
  openSocket(host, port) {
    const opened = Promise.reject(new NetError('ENETUNREACH', `connect ENETUNREACH ${host}:${port}`))
    opened.catch(() => {})
    return { opened, write() {}, end() {}, close() {} }
  },
  openHttp(request) {
    const response = Promise.reject(new NetError('ENETUNREACH', `network is disabled: ${request.url}`))
    response.catch(() => {})
    return { response, abort() {} }
  },
}
