// The envelope layer both ends of the MessagePort share: requests answered by id, and one-way events.
// No DOM or Node dependencies beyond MessagePort itself.
import type { Envelope } from './protocol.js'

export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

/** A Uint8Array that owns its whole buffer, so it can be transferred without dragging a larger buffer along. */
export function compact(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes as Uint8Array<ArrayBuffer>
  return bytes.slice() as Uint8Array<ArrayBuffer>
}

type Req = Extract<Envelope, { req: unknown }>['req']
type Ev = Extract<Envelope, { event: unknown }>['event']

export interface ChannelHandlers {
  /** Answer a request from the other side. Throw an RpcError (or anything with `code`) to answer with an error. */
  request(req: Req): unknown | Promise<unknown>
  event(event: Ev): void
}

export class Channel {
  private nextId = 1
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private closed = false

  constructor(
    private readonly port: MessagePort,
    private readonly handlers: ChannelHandlers,
  ) {
    port.onmessage = (ev: MessageEvent<Envelope>) => this.receive(ev.data)
  }

  request<T>(req: Req, transfer: Transferable[] = []): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError('closed', 'the channel is closed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.port.postMessage({ id, req } satisfies Envelope, transfer)
    })
  }
  event(event: Ev, transfer: Transferable[] = []): void {
    if (!this.closed) this.port.postMessage({ event } satisfies Envelope, transfer)
  }
  /** Stop: pending requests are rejected with `reason`. */
  close(reason: RpcError): void {
    if (this.closed) return
    this.closed = true
    this.port.onmessage = null
    this.port.close()
    for (const p of this.pending.values()) p.reject(reason)
    this.pending.clear()
  }

  private receive(msg: Envelope): void {
    if ('event' in msg) return this.handlers.event(msg.event)
    if ('req' in msg) {
      const { id } = msg
      Promise.resolve()
        .then(() => this.handlers.request(msg.req))
        .then(
          (res) => !this.closed && this.port.postMessage({ id, res } satisfies Envelope, res instanceof Uint8Array ? [res.buffer] : []),
          (e: { code?: unknown; message?: unknown }) => !this.closed && this.port.postMessage({ id, err: { code: typeof e?.code === 'string' ? e.code : 'error', message: String(e?.message ?? e) } } satisfies Envelope),
        )
      return
    }
    const waiting = this.pending.get(msg.id)
    if (!waiting) return
    this.pending.delete(msg.id)
    if ('err' in msg) waiting.reject(new RpcError(msg.err.code, msg.err.message))
    else waiting.resolve(msg.res)
  }
}
