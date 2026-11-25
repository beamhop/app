// Minimal types for the Workers TCP socket API (https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/),
// so the package type-checks without @cloudflare/workers-types.
declare module 'cloudflare:sockets' {
  export interface SocketAddress { hostname: string; port: number }
  export interface SocketOptions { secureTransport?: 'off' | 'on' | 'starttls'; allowHalfOpen?: boolean }
  export interface SocketInfo { remoteAddress?: string; localAddress?: string }
  export interface Socket {
    readonly readable: ReadableStream<Uint8Array>
    readonly writable: WritableStream<Uint8Array>
    readonly opened: Promise<SocketInfo>
    readonly closed: Promise<void>
    close(): Promise<void>
    startTls(): Socket
  }
  export function connect(address: string | SocketAddress, options?: SocketOptions): Socket
}
