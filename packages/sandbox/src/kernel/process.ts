// Processes and programs. A process is a table entry with stdio pipes and an exit status; a program is what
// runs inside it. All processes share the kernel's thread, so nothing here can pre-empt a running program:
// signals are delivered between tasks, and a program that never yields cannot be stopped from inside.
import type { Kernel } from './kernel.js'
import { Pipe } from './pipe.js'

export interface ExitStatus {
  /** Exit code. For a process ended by a signal this is 128 + the signal number, as a shell would report it. */
  code: number
  signal?: string
}

export const SIGNALS: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10,
  SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20,
  SIGTTIN: 21, SIGTTOU: 22, SIGWINCH: 28,
}

/** Normalise a signal given by name or number. Unknown values become SIGTERM. */
export function signalName(signal: string | number | undefined): string {
  if (typeof signal === 'number') return Object.keys(SIGNALS).find((k) => SIGNALS[k] === signal) ?? 'SIGTERM'
  return signal && signal in SIGNALS ? signal : 'SIGTERM'
}

export interface SpawnOptions {
  /** argv[0] is the command: a path, or a name looked up on PATH. */
  argv: string[]
  env?: Record<string, string>
  cwd?: string
  ppid?: number
  /** 'none' gives the process an already-ended stdin. Default 'pipe'. */
  stdin?: 'pipe' | 'none'
}

export class Process {
  readonly stdin = new Pipe()
  readonly stdout = new Pipe()
  readonly stderr = new Pipe()
  /** Null while running. */
  status: ExitStatus | null = null
  /** Resolves when the process has exited. Never rejects. */
  readonly exited: Promise<ExitStatus>
  private resolveExit!: (status: ExitStatus) => void
  private readonly abort = new AbortController()
  /** Set by the program; returns true if it handled the signal itself (a Node 'SIGTERM' listener, for example). */
  signalHandler: ((signal: string) => boolean) | null = null

  constructor(
    readonly pid: number,
    readonly ppid: number,
    /** The resolved executable path. */
    readonly path: string,
    readonly argv: string[],
    readonly env: Record<string, string>,
    public cwd: string,
    readonly kind: string,
  ) {
    this.exited = new Promise((resolve) => (this.resolveExit = resolve))
  }

  get running(): boolean {
    return this.status === null
  }
  /** Aborted when the process is terminated from outside, so the program can unwind (cancel I/O, reject suspended stacks). */
  get terminated(): AbortSignal {
    return this.abort.signal
  }

  /** Called by the kernel or the program exactly once; later calls are ignored. */
  finish(status: ExitStatus): void {
    if (this.status) return
    this.status = status
    this.stdin.end()
    this.stdout.end()
    this.stderr.end()
    if (status.signal) this.abort.abort()
    this.resolveExit(status)
  }
}

/** What a program gets when it starts. */
export interface ProcessContext {
  kernel: Kernel
  process: Process
  /** End the process normally. */
  exit(code: number): void
}

/** What a synchronous run gets: no pipes, no waiting. */
export interface SyncRunContext {
  kernel: Kernel
  argv: string[]
  env: Record<string, string>
  cwd: string
  stdin: Uint8Array
}
export interface SyncRunResult {
  code: number
  stdout: Uint8Array
  stderr: Uint8Array
}

/**
 * A kind of executable. `node` and the shell are implemented in JavaScript; wasm programs (WASI + JSPI) are
 * meant to implement this same interface, under the rules their prototype established:
 *  - `start` returns promptly; the program runs as tasks on the shared event loop and calls `ctx.exit`.
 *  - A blocking syscall is a non-waiting "try" (Pipe.tryRead) plus a suspending slow path (Pipe.read).
 *  - On termination (`process.terminated` aborts) the program must unwind every suspended stack by rejecting
 *    its promise; an abandoned suspension is leaked for good.
 *  - `runSync` may only complete when the run never needs to suspend; otherwise it returns undefined and the
 *    caller reports that a synchronous child cannot be emulated.
 */
export interface Program {
  readonly kind: string
  start(ctx: ProcessContext): void
  runSync?(ctx: SyncRunContext): SyncRunResult | undefined
}
