// Shared types for the Node layer.
import type { Kernel } from '../kernel/kernel.js'
import type { Process } from '../kernel/process.js'

/**
 * A dynamically typed value. The Node layer is an emulation of an untyped API, called by untyped guest code and
 * built on polyfill packages without usable types, so the values that cross those boundaries are `any` by nature.
 * `Dyn` marks exactly those places; code that stays inside this package (kernel, frame, client, image) does not use it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Dyn = any

/** Records the use of an API that is emulated loosely or not at all; surfaced as machine log events. */
export type Track = (name: string, detail?: string) => void

/** Reference counting that stands in for libuv's "is the event loop still alive". */
export interface Liveness {
  ref(): void
  unref(): void
  readonly handles: number
  /** Called once the main module has started; from then on an idle loop ends the process. */
  start(): void
}

export interface NodeTimers {
  setTimeout(fn: Dyn, ms?: number, ...args: Dyn[]): Dyn
  setInterval(fn: Dyn, ms?: number, ...args: Dyn[]): Dyn
  setImmediate(fn: Dyn, ...args: Dyn[]): Dyn
  clearTimeout(t: Dyn): void
  clearInterval(t: Dyn): void
  clearImmediate(t: Dyn): void
}

/** The per-process core every other Node module hangs off. */
export interface ProcessCore {
  /** The guest-visible `process` object. */
  process: Dyn
  kernel: Kernel
  kproc: Process
  live: Liveness
  timers: NodeTimers
  track: Track
  readonly exited: boolean
  exit(code: number): void
  /** Route an error that nothing caught: 'uncaughtException' listeners, or print and exit 1. */
  uncaught(error: unknown): void
  unhandledRejection(reason: unknown, promise: unknown): void
  /** Non-blocking read of buffered stdin for fs.readSync(0). Returns 0 at end of input. */
  readStdinSync(target: Uint8Array): number
}
