// Messages between the app and the machine worker (worker.ts). The worker owns the unkernel
// kernel; the app talks to it only through these messages and the streams they transfer.

/** How the machine reaches the internet. Browsers cannot open sockets, so a relay carries its TCP. */
export type MachineNet =
  | { kind: 'none' }
  /** A Wisp v1 server (https://github.com/MercuryWorkshop/wisp-protocol). */
  | { kind: 'wisp'; url: string }
  /** A Beamhop proxy in tunnel mode (packages/proxy). TLS stays inside the machine. */
  | { kind: 'beamhop'; url: string; token?: string }

export interface BootRequest {
  kernelUrl: string
  distroUrl: string
  net: MachineNet
  memoryMiB: number
  /** Keep the machine's files in IndexedDB across reloads. */
  persist: boolean
  /** Extra PEM certificates the machine should trust (for networks that inspect TLS). */
  extraCa?: string
}

export type Request =
  | { op: 'boot'; boot: BootRequest }
  | { op: 'exec'; cmd: string; env?: Record<string, string>; user?: string }
  | { op: 'spawn'; cmd: string; args: string[]; env?: Record<string, string>; cwd?: string; user?: string }
  | { op: 'pty'; cols: number; rows: number; env?: Record<string, string>; user?: string }
  | { op: 'pty-write'; pty: number; data: string }
  | { op: 'pty-resize'; pty: number; cols: number; rows: number }
  | { op: 'pty-close'; pty: number }
  | { op: 'kill'; proc: number }
  | { op: 'sync' }
  | { op: 'stop' }

export interface OkReply {
  ok: true
  result?: any
  stdin?: WritableStream<Uint8Array>
  stdout?: ReadableStream<Uint8Array>
  stderr?: ReadableStream<Uint8Array>
}
export type Reply = ({ id: number } & OkReply) | { id: number; ok: false; error: string }

/** Events the worker sends without a request. */
export type WorkerEvent =
  | { event: 'progress'; stage: string }
  | { event: 'pty-data'; pty: number; data: Uint8Array }
  | { event: 'pty-exit'; pty: number; code: number | null }
  | { event: 'exited'; reason: string }
  | { event: 'log'; line: string }
  /** Saving the machine's disk to IndexedDB failed: changes may not survive a reload. */
  | { event: 'storage-error'; message: string }
