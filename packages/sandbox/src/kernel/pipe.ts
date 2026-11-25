// A one-directional byte channel between two parties in the same thread: process stdio, shell pipelines.
//
// Reads come in two forms, following the rule the JSPI process prototype forced on every blocking call:
// `tryRead()` never waits (the fast path a wasm guest calls as a plain import) and `read()` returns a promise
// (the slow path a guest suspends on). JavaScript consumers usually attach a sink instead and get pushed data.

export type PipeSink = (chunk: Uint8Array | null) => void

export class Pipe {
  private queue: Uint8Array[] = []
  private queued = 0
  private ended = false
  private sink: PipeSink | null = null
  private readWaiters: (() => void)[] = []
  private drainWaiters: (() => void)[] = []
  /** Bytes buffered before `write` reports backpressure. Writes are never refused. */
  readonly highWaterMark: number
  bytesWritten = 0

  constructor(highWaterMark = 1 << 20) {
    this.highWaterMark = highWaterMark
  }

  /** Queue bytes. Returns false when the buffer is above the high-water mark (see `drained`). Writes after end are dropped. */
  write(data: Uint8Array): boolean {
    if (this.ended || data.byteLength === 0) return true
    this.bytesWritten += data.byteLength
    if (this.sink) {
      this.sink(data)
      return true
    }
    this.queue.push(data)
    this.queued += data.byteLength
    this.wake(this.readWaiters)
    return this.queued < this.highWaterMark
  }
  /** Signal end of stream. Buffered data stays readable. */
  end(): void {
    if (this.ended) return
    this.ended = true
    if (this.sink) this.sink(null)
    this.wake(this.readWaiters)
    this.wake(this.drainWaiters)
  }
  get writableEnded(): boolean {
    return this.ended
  }
  /** True once the writer ended and every byte was consumed. */
  get readableEnded(): boolean {
    return this.ended && this.queue.length === 0
  }
  get bufferedBytes(): number {
    return this.queued
  }

  /** A chunk if one is buffered, otherwise null. Check `readableEnded` to tell "empty" from "finished". */
  tryRead(): Uint8Array | null {
    const chunk = this.queue.shift()
    if (!chunk) return null
    this.queued -= chunk.byteLength
    if (this.queued < this.highWaterMark) this.wake(this.drainWaiters)
    return chunk
  }
  /** The next chunk, or null at end of stream. */
  async read(): Promise<Uint8Array | null> {
    for (;;) {
      const chunk = this.tryRead()
      if (chunk) return chunk
      if (this.ended) return null
      await new Promise<void>((resolve) => this.readWaiters.push(resolve))
    }
  }
  /** Resolves when the buffer is below the high-water mark again (cooperative backpressure for writers). */
  drained(): Promise<void> {
    if (this.queued < this.highWaterMark || this.ended) return Promise.resolve()
    return new Promise<void>((resolve) => this.drainWaiters.push(resolve))
  }
  /** Everything until end of stream, as one array. */
  async readAll(): Promise<Uint8Array> {
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const chunk = await this.read()
      if (!chunk) break
      chunks.push(chunk)
      total += chunk.byteLength
    }
    const out = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      out.set(c, at)
      at += c.byteLength
    }
    return out
  }

  /** Switch to push mode: buffered chunks are delivered now, later ones as they are written, then `null` at end. */
  pipeTo(sink: PipeSink): void {
    this.sink = sink
    const pending = this.queue
    this.queue = []
    this.queued = 0
    for (const chunk of pending) sink(chunk)
    if (this.ended) sink(null)
    this.wake(this.drainWaiters)
  }

  private wake(waiters: (() => void)[]): void {
    if (waiters.length === 0) return
    for (const w of waiters.splice(0)) w()
  }
}
