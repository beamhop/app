// Wire contract between the Beamhop app (origin A) and a machine frame (one origin per workspace).
// The app embeds `<machine origin>/machine.html` in an iframe. The frame posts MachineHello to its
// parent; the parent answers with MachineInit and transfers one MessagePort. Everything after that
// travels over the port. The machine has no network of its own: sockets and HTTP go through the app.

export const MACHINE_PROTOCOL = 1

/** Frame → parent window, via postMessage, once the frame script has loaded. */
export interface MachineHello { bh: 'machine-hello'; v: number }
/** Parent → frame, via postMessage, with `port` in the transfer list. */
export interface MachineInit { bh: 'machine-init'; v: number; port: MessagePort }

export type Bytes = Uint8Array

// ---------------------------------------------------------------- app → machine requests

export type AppRequest =
  | { op: 'boot'; workspaceId: string; env?: Record<string, string> }
  /** Mount a read-only image (see image.ts) at a path. `source` is a URL the frame may fetch from its own origin, or bytes. */
  | { op: 'mount'; at: string; source: string | ArrayBuffer }
  | { op: 'spawn'; argv: string[]; env?: Record<string, string>; cwd?: string; stdin?: 'pipe' | 'none' }
  | { op: 'stdin'; pid: number; data?: Bytes; eof?: boolean }
  | { op: 'kill'; pid: number; signal?: string }
  | { op: 'fs.read'; path: string }
  | { op: 'fs.write'; path: string; data: Bytes; mode?: number }
  | { op: 'fs.list'; path: string }
  | { op: 'fs.stat'; path: string }
  | { op: 'fs.remove'; path: string; recursive?: boolean }
  | { op: 'fs.mkdir'; path: string }

export interface FsStat { type: 'file' | 'dir' | 'symlink'; size: number; mtimeMs: number; mode: number }

export interface AppResults {
  boot: { ok: true }
  mount: { files: number; bytes: number }
  spawn: { pid: number }
  stdin: void
  kill: void
  'fs.read': Bytes
  'fs.write': void
  'fs.list': { name: string; type: FsStat['type'] }[]
  'fs.stat': FsStat | null
  'fs.remove': void
  'fs.mkdir': void
}

// ---------------------------------------------------------------- machine → app events

export type MachineEvent =
  | { ev: 'stdout'; pid: number; data: Bytes }
  | { ev: 'stderr'; pid: number; data: Bytes }
  | { ev: 'exit'; pid: number; code: number; signal?: string }
  /** The machine asks the app to open a URL in a real tab (login pages). The app decides. */
  | { ev: 'open-url'; url: string }
  /** Liveness; the app restarts the machine when these stop. */
  | { ev: 'heartbeat'; t: number }
  | { ev: 'log'; level: 'info' | 'warn' | 'error'; message: string }

// ---------------------------------------------------------------- network broker (machine → app requests)

/** Raw TCP through the proxy's tunnel mode. Data flows as events in both directions, keyed by `sid`. */
export type NetRequest =
  | { op: 'sock.open'; sid: number; host: string; port: number }
  /** One HTTP exchange through the proxy's plain mode (or directly, if the app knows the host allows CORS). */
  | { op: 'http.open'; rid: number; url: string; method: string; headers: [string, string][]; hasBody: boolean }

export interface NetResults {
  'sock.open': { ok: true } | { ok: false; code: string; message: string }
  'http.open': { ok: true; status: number; headers: [string, string][] } | { ok: false; code: string; message: string }
}

/** Either direction, after the matching open succeeded. */
export type NetEvent =
  | { ev: 'sock.data'; sid: number; data: Bytes }
  | { ev: 'sock.end'; sid: number }
  | { ev: 'sock.close'; sid: number; error?: string }
  | { ev: 'http.body'; rid: number; data: Bytes }
  | { ev: 'http.end'; rid: number }
  | { ev: 'http.abort'; rid: number; error?: string }

// ---------------------------------------------------------------- envelope

/** Requests carry an id; the other side answers with the same id. Events carry none. */
export type Envelope =
  | { id: number; req: AppRequest | NetRequest }
  | { id: number; res: unknown }
  | { id: number; err: { code: string; message: string } }
  | { event: MachineEvent | NetEvent }
