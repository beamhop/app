// Client side of the Beamhop proxy tunnel (packages/proxy/PROTOCOL.md, "Tunnel mode"): a raw TCP
// connection carried over a WebSocket, exposed as a TlsTransport. Runs in a worker or window.
import type { TlsTransport } from './index'

export interface TunnelOptions {
  /** Proxy base URL, e.g. `wss://proxy.example` (http/https are mapped to ws/wss). */
  proxy: string
  host: string
  port: number
  /** Access token; omitted for open proxies. */
  token?: string
  signal?: AbortSignal
}

export class TunnelError extends Error {
  override readonly name = 'TunnelError'
  /** Proxy codes (`auth`, `policy`, `dns`, `connect`, `timeout`, `limit`) or `websocket`. */
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
  }
}

/** Pause writes while this much is queued in the WebSocket. */
const HIGH_WATER = 1 << 20

/** Open a tunnel. Resolves once the proxy reports the TCP connection is up. */
export function openTunnel(opts: TunnelOptions): Promise<TlsTransport> {
  const url = new URL('/v1/tcp', opts.proxy.replace(/^http/, 'ws'))
  url.searchParams.set('host', opts.host)
  url.searchParams.set('port', String(opts.port))
  const ws = new WebSocket(url, opts.token ? ['bh1', `bh1.${opts.token}`] : ['bh1'])
  ws.binaryType = 'arraybuffer'

  return new Promise<TlsTransport>((resolve, reject) => {
    let open = false
    let controller!: ReadableStreamDefaultController<Uint8Array>
    let readEnded = false
    const readable = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
      cancel() {
        readEnded = true
        ws.close()
      },
    })
    const endRead = (err?: Error) => {
      if (readEnded) return
      readEnded = true
      if (err) controller.error(err)
      else controller.close()
    }
    const abort = () => {
      ws.close()
      reject(new TunnelError('websocket', 'aborted'))
    }
    opts.signal?.addEventListener('abort', abort, { once: true })
    if (opts.signal?.aborted) abort()

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg: { ok?: boolean; code?: string; message?: string; end?: boolean }
        try {
          msg = JSON.parse(ev.data)
        } catch {
          return
        }
        if (!open) {
          if (msg.ok === true) {
            open = true
            opts.signal?.removeEventListener('abort', abort)
            resolve(transport)
          } else {
            reject(new TunnelError(msg.code ?? 'connect', msg.message ?? 'proxy refused the connection'))
            ws.close()
          }
        } else if (msg.end === true) endRead()
        return
      }
      if (open && !readEnded) controller.enqueue(new Uint8Array(ev.data as ArrayBuffer))
    }
    ws.onerror = () => {
      if (!open) reject(new TunnelError('websocket', 'WebSocket connection failed'))
    }
    ws.onclose = (ev) => {
      if (!open) reject(new TunnelError('websocket', `WebSocket closed before the tunnel opened (${ev.code})`))
      // A close without the {"end":true} half-close is an abrupt teardown, not a clean FIN.
      endRead(new TunnelError('websocket', `tunnel closed (${ev.code})`))
    }

    const transport: TlsTransport = {
      readable,
      async write(bytes) {
        if (ws.readyState !== WebSocket.OPEN) throw new TunnelError('websocket', 'tunnel is closed')
        ws.send(bytes as Uint8Array<ArrayBuffer>)
        while (ws.bufferedAmount > HIGH_WATER && ws.readyState === WebSocket.OPEN) await new Promise((r) => setTimeout(r, 4))
      },
      end() {
        if (ws.readyState === WebSocket.OPEN) ws.send('{"end":true}')
      },
      close() {
        ws.close()
      },
    }
  })
}
