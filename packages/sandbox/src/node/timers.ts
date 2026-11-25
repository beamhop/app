// Node-style timers (objects with ref/unref/refresh) on top of the host's, tied to a process's liveness count.
import type { Dyn, Liveness, NodeTimers } from './types.js'

interface TimerHost {
  live: Liveness
  exited(): boolean
  onError(error: unknown): void
}

const MAX_DELAY = 2147483647

export function createTimers(host: TimerHost): NodeTimers & { stopAll(): void } {
  const { live } = host
  const active = new Set<{ _stop(): void }>()

  class Timeout {
    private _id: ReturnType<typeof setTimeout> | undefined
    private _refed = true
    private _active = false
    constructor(
      private readonly _fn: Dyn,
      private readonly _ms: number,
      private readonly _args: Dyn[],
      private readonly _repeat: boolean,
    ) {
      this._start()
    }
    private _start(): void {
      this._active = true
      active.add(this)
      if (this._refed) live.ref()
      const run = (): void => {
        if (host.exited()) return
        if (!this._repeat) {
          this._active = false
          active.delete(this)
          if (this._refed) live.unref()
        }
        try {
          this._fn(...this._args)
        } catch (e) {
          host.onError(e)
        }
      }
      this._id = this._repeat ? setInterval(run, this._ms) : setTimeout(run, this._ms)
    }
    _stop(): void {
      if (!this._active) return
      this._active = false
      active.delete(this)
      clearTimeout(this._id) // clearTimeout and clearInterval share one id space
      if (this._refed) live.unref()
    }
    ref(): this {
      if (!this._refed) {
        this._refed = true
        if (this._active) live.ref()
      }
      return this
    }
    unref(): this {
      if (this._refed) {
        this._refed = false
        if (this._active) live.unref()
      }
      return this
    }
    hasRef(): boolean {
      return this._refed
    }
    refresh(): this {
      this._stop()
      this._start()
      return this
    }
    close(): this {
      this._stop()
      return this
    }
    [Symbol.toPrimitive](): number {
      return Number(this._id)
    }
    [Symbol.dispose](): void {
      this._stop()
    }
  }

  // setImmediate must not be clamped to >= 1 ms by the browser, so it hops through a MessageChannel.
  const channel = new MessageChannel()
  let queue: Immediate[] = []
  channel.port1.onmessage = () => {
    const batch = queue
    queue = []
    for (const im of batch) im._run()
  }
  // Under Node an open MessagePort keeps the host process alive; it must not (tests, the bridge).
  ;(channel.port1 as unknown as { unref?: () => void }).unref?.()

  class Immediate {
    private _active = true
    private _refed = true
    constructor(
      private readonly _fn: Dyn,
      private readonly _args: Dyn[],
    ) {
      live.ref()
      active.add(this)
      queue.push(this)
      channel.port2.postMessage(0)
    }
    _run(): void {
      if (!this._active) return
      this._stop()
      if (host.exited()) return
      try {
        this._fn(...this._args)
      } catch (e) {
        host.onError(e)
      }
    }
    _stop(): void {
      if (!this._active) return
      this._active = false
      active.delete(this)
      if (this._refed) live.unref()
    }
    ref(): this {
      if (!this._refed) {
        this._refed = true
        if (this._active) live.ref()
      }
      return this
    }
    unref(): this {
      if (this._refed) {
        this._refed = false
        if (this._active) live.unref()
      }
      return this
    }
    hasRef(): boolean {
      return this._refed
    }
    [Symbol.dispose](): void {
      this._stop()
    }
  }

  const delay = (ms: unknown): number => Math.min(Math.max(1, Number(ms) || 1), MAX_DELAY)
  const clear = (t: Dyn): void => {
    if (t && typeof t._stop === 'function') t._stop()
    else if (t != null) clearTimeout(t)
  }
  return {
    setTimeout: (fn, ms, ...args) => new Timeout(fn, delay(ms), args, false),
    setInterval: (fn, ms, ...args) => new Timeout(fn, delay(ms), args, true),
    setImmediate: (fn, ...args) => new Immediate(fn, args),
    clearTimeout: clear,
    clearInterval: clear,
    clearImmediate: clear,
    /** Cancel everything; used when the process ends. */
    stopAll() {
      for (const t of [...active]) t._stop()
      channel.port1.close()
    },
  }
}
