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

/** A TLS client connection layered on a raw socket. Not implemented yet; see NetBroker.connectTls. */
export interface TlsOptions {
  servername: string
  alpnProtocols?: string[]
}

export interface NetBroker {
  openSocket(host: string, port: number, events: SocketEvents): SocketChannel
  openHttp(request: HttpRequestInit, events: HttpResponseEvents): HttpExchange
  /**
   * TODO(tls): wrap a tunnel socket in TLS inside the machine. Until a broker provides this hook, `tls.connect`
   * and `https:` requests fail in tunnel mode with ERR_TLS_NOT_AVAILABLE. In http mode the proxy terminates TLS.
   */
  connectTls?(channel: SocketChannel, options: TlsOptions, events: SocketEvents): SocketChannel
}

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
