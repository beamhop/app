// The kernel: file system, process table and program registry for one machine. It runs in a single thread
// (a dedicated worker in the browser, the main thread under Node) and needs no SharedArrayBuffer.
import { KernelError } from './errors.js'
import { type NetBroker, type NetMode, type TlsConnector, noNetwork } from './net.js'
import { basename, resolve } from './path.js'
import { type ExitStatus, Process, type Program, SIGNALS, signalName, type SpawnOptions, type SyncRunResult } from './process.js'
import { Vfs } from './vfs.js'

export const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin'
const VIRTUAL = '#!virtual '
const MAX_SHEBANG_DEPTH = 4

export interface KernelOptions {
  vfs?: Vfs
  env?: Record<string, string>
  net?: NetBroker
  netMode?: NetMode
  connectTls?: TlsConnector
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
  openUrl?: (url: string) => void
}

/** The outcome of looking a command up: which program runs it, and with what argv. */
export interface ResolvedCommand {
  program: Program
  /** The executable file that was found. */
  path: string
  argv: string[]
}

export interface KernelEvents {
  spawn?(process: Process): void
  exit?(process: Process, status: ExitStatus): void
}

export class Kernel {
  readonly vfs: Vfs
  /** Environment given to processes that do not bring their own. */
  readonly env: Record<string, string>
  net: NetBroker
  netMode: NetMode
  connectTls: TlsConnector | undefined
  readonly log: (level: 'info' | 'warn' | 'error', message: string) => void
  openUrl: (url: string) => void
  private readonly programs = new Map<string, Program>()
  private readonly processes = new Map<number, Process>()
  private readonly listeners = new Set<KernelEvents>()
  /** Programs that take over a native executable of the same name (a vendored `rg` binary, for example). */
  private nativeFallback: ((name: string) => Program | undefined) | null = null
  private nextPid = 100

  constructor(opts: KernelOptions = {}) {
    this.vfs = opts.vfs ?? new Vfs()
    this.env = { HOME: '/home/user', PATH: DEFAULT_PATH, USER: 'user', SHELL: '/bin/bash', LANG: 'C.UTF-8', TERM: 'dumb', ...opts.env }
    this.net = opts.net ?? noNetwork
    this.netMode = opts.netMode ?? 'none'
    this.connectTls = opts.connectTls
    this.log = opts.log ?? (() => {})
    this.openUrl = opts.openUrl ?? (() => {})
    const enc = new TextEncoder()
    for (const dir of ['/usr/bin', '/usr/local/bin', '/tmp', '/etc', '/dev', '/work', this.env.HOME]) this.vfs.mkdir(dir, { recursive: true })
    if (!this.vfs.exists('/bin')) this.vfs.symlink('usr/bin', '/bin')
    if (!this.vfs.exists('/dev/null')) this.vfs.writeFile('/dev/null', new Uint8Array(0))
    if (!this.vfs.exists('/etc/passwd')) this.vfs.writeFile('/etc/passwd', enc.encode(`${this.env.USER}:x:1000:1000::${this.env.HOME}:/bin/bash\n`))
  }

  // ---------------------------------------------------------------- programs

  /**
   * Register a program kind and publish it under the given absolute paths. Each path gets a small stub file
   * ("#!virtual <kind>") so that PATH lookups, `which` and the shell all find it the way they find any executable.
   */
  install(program: Program, paths: string[] = []): void {
    this.programs.set(program.kind, program)
    const stub = new TextEncoder().encode(`${VIRTUAL}${program.kind}\n`)
    for (const path of paths) this.vfs.writeFileDeep(path, stub.slice(), { mode: 0o755 })
  }
  program(kind: string): Program | undefined {
    return this.programs.get(kind)
  }
  setNativeFallback(fn: (name: string) => Program | undefined): void {
    this.nativeFallback = fn
  }

  /** Find an executable by name on PATH (or by path) without interpreting it. Returns null when there is none. */
  which(command: string, cwd: string, env: Record<string, string>): string | null {
    const isExecutable = (path: string): boolean => {
      const st = this.vfs.tryStat(path)
      return st !== null && st.kind === 'file' && (st.mode & 0o111) !== 0
    }
    if (command.includes('/')) {
      const path = resolve(cwd, command)
      return isExecutable(path) ? path : null
    }
    if (!command) return null
    for (const dir of (env.PATH ?? DEFAULT_PATH).split(':')) {
      if (!dir) continue
      const path = resolve(cwd, dir) + '/' + command
      if (isExecutable(path)) return path
    }
    return null
  }

  /**
   * Decide what runs for `argv`. Throws KernelError ENOENT (nothing by that name), EACCES (not executable)
   * or ENOEXEC (a native binary this machine cannot run).
   */
  resolveCommand(argv: string[], cwd: string, env: Record<string, string>, depth = 0): ResolvedCommand {
    const command = argv[0] ?? ''
    const path = this.which(command, cwd, env)
    if (!path) {
      const direct = command.includes('/') ? this.vfs.tryStat(resolve(cwd, command)) : null
      throw new KernelError(direct && direct.kind === 'file' ? 'EACCES' : 'ENOENT', 'spawn', command)
    }
    const data = this.vfs.readFile(path)
    const head = new TextDecoder().decode(data.subarray(0, 256))
    if (head.startsWith(VIRTUAL)) {
      const kind = head.slice(VIRTUAL.length).split('\n')[0].trim()
      const program = this.programs.get(kind)
      if (!program) throw new KernelError('ENOEXEC', 'spawn', command)
      return { program, path, argv }
    }
    if (head.startsWith('#!')) {
      if (depth >= MAX_SHEBANG_DEPTH) throw new KernelError('ELOOP', 'spawn', command)
      const words = head.slice(2).split('\n')[0].trim().split(/\s+/).filter(Boolean)
      // `#!/usr/bin/env node` looks the interpreter up on PATH; `env -S` splits the rest, which the split above already did.
      const interpreter = basename(words[0] ?? '') === 'env' ? words.slice(1).filter((w) => w !== '-S') : words
      if (interpreter.length === 0) throw new KernelError('ENOEXEC', 'spawn', command)
      return this.resolveCommand([...interpreter, path, ...argv.slice(1)], cwd, env, depth + 1)
    }
    if (isNativeBinary(data)) {
      const program = this.nativeFallback?.(basename(path))
      if (!program) throw new KernelError('ENOEXEC', 'spawn', command)
      return { program, path, argv: [basename(path), ...argv.slice(1)] }
    }
    // A text file with no interpreter line is run by the shell, as execvp does.
    return this.resolveCommand(['sh', path, ...argv.slice(1)], cwd, env, depth + 1)
  }

  // ---------------------------------------------------------------- processes

  /** Start a process. Resolution errors are thrown synchronously; the program itself starts in a microtask. */
  spawn(opts: SpawnOptions): Process {
    const env = { ...(opts.env ?? this.env) }
    const cwd = resolve('/', opts.cwd ?? env.PWD ?? '/work')
    if (this.vfs.kindOf(cwd) !== 'dir') throw new KernelError('ENOENT', 'chdir', cwd)
    const resolved = this.resolveCommand(opts.argv, cwd, env)
    const proc = new Process(this.nextPid++, opts.ppid ?? 1, resolved.path, resolved.argv, env, cwd, resolved.program.kind)
    this.processes.set(proc.pid, proc)
    if (opts.stdin === 'none') proc.stdin.end()
    void proc.exited.then((status) => {
      for (const child of this.processes.values()) if (child.ppid === proc.pid && child.running) this.kill(child.pid, 'SIGHUP')
      this.processes.delete(proc.pid)
      for (const l of this.listeners) l.exit?.(proc, status)
    })
    for (const l of this.listeners) l.spawn?.(proc)
    queueMicrotask(() => {
      if (!proc.running) return
      try {
        resolved.program.start({ kernel: this, process: proc, exit: (code) => proc.finish({ code }) })
      } catch (e) {
        proc.stderr.write(new TextEncoder().encode(`${resolved.argv[0]}: ${e instanceof Error ? e.message : String(e)}\n`))
        proc.finish({ code: 126 })
      }
    })
    return proc
  }

  /** Run a command to completion without yielding, if its program can. Returns undefined when it cannot. */
  runSync(argv: string[], opts: { env?: Record<string, string>; cwd?: string; stdin?: Uint8Array } = {}): SyncRunResult | undefined {
    const env = { ...(opts.env ?? this.env) }
    const cwd = resolve('/', opts.cwd ?? '/work')
    const resolved = this.resolveCommand(argv, cwd, env)
    return resolved.program.runSync?.({ kernel: this, argv: resolved.argv, env, cwd, stdin: opts.stdin ?? new Uint8Array(0) })
  }

  get(pid: number): Process | undefined {
    return this.processes.get(pid)
  }
  list(): Process[] {
    return [...this.processes.values()]
  }

  /**
   * Deliver a signal. SIGKILL always terminates. Other signals go to the program's handler first; if there is
   * none, or it declines, the process is terminated. Signal 0 only tests for existence.
   */
  kill(pid: number, signal: string | number = 'SIGTERM'): void {
    const proc = this.processes.get(pid)
    if (!proc || !proc.running) throw new KernelError('ESRCH', 'kill')
    if (signal === 0) return
    const name = signalName(signal)
    if (name !== 'SIGKILL' && proc.signalHandler?.(name)) return
    proc.finish({ code: 128 + (SIGNALS[name] ?? 15), signal: name })
  }

  on(listener: KernelEvents): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/** ELF, Mach-O (both byte orders, fat) and PE executables. */
export function isNativeBinary(d: Uint8Array): boolean {
  if (d.byteLength < 4) return false
  const magic = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0
  return magic === 0x7f454c46 || magic === 0xcffaedfe || magic === 0xcefaedfe || magic === 0xfeedfacf || magic === 0xfeedface || magic === 0xcafebabe || (d[0] === 0x4d && d[1] === 0x5a)
}
