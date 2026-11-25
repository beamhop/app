// node:child_process on the kernel's process table. `spawn` starts a real kernel process (the shell, a shell
// tool, another Node program); its stdio are the process's pipes.
//
// The event order of a failed spawn is exactly Node's, because process libraries depend on it (execa hangs
// forever without the trailing 'close'): no 'spawn' event, then 'error', stdio destroyed, then 'close'.
//
// Synchronous variants can only run programs that finish without waiting (see Program.runSync). Today that is
// `which`; for anything else they report the command as missing, which is what a caller probing for an optional
// tool should conclude, and the wrong answer for a caller that needed the command's output.
import { KernelError } from '../kernel/errors.js'
import type { Process as KernelProcess } from '../kernel/process.js'
import type { Dyn, ProcessCore } from './types.js'
import { BufferPkg as Buffer } from './vendor.js'

interface Deps {
  core: ProcessCore
  fs: Dyn
  stream: Dyn
  EventEmitter: Dyn
  util: Dyn
}

type StdioKind = 'pipe' | 'inherit' | 'ignore' | 'fd'

const stringEnv = (env: Dyn): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env ?? {})) if (v != null) out[k] = String(v)
  return out
}

export function createChildProcess({ core, fs, stream, EventEmitter, util }: Deps): Dyn {
  const { kernel, kproc, live, process, track } = core

  class ChildProcess extends EventEmitter {
    constructor() {
      super()
      this.pid = undefined
      this.exitCode = null
      this.signalCode = null
      this.killed = false
      this.connected = false
      this.stdin = null
      this.stdout = null
      this.stderr = null
      this.stdio = [null, null, null]
      this._kproc = null as KernelProcess | null
      this._refed = false
    }
    kill(signal: string | number = 'SIGTERM'): boolean {
      const p: KernelProcess | null = this._kproc
      if (!p || !p.running) return false
      try {
        kernel.kill(p.pid, signal)
      } catch {
        return false
      }
      this.killed = true
      return true
    }
    ref(): this {
      if (!this._refed && this._kproc?.running) {
        this._refed = true
        live.ref()
      }
      return this
    }
    unref(): this {
      if (this._refed) {
        this._refed = false
        live.unref()
      }
      return this
    }
    disconnect(): void {}
    send(): boolean {
      return false
    }
    [Symbol.dispose](): void {
      this.kill()
    }
  }

  function spawn(command: Dyn, args?: Dyn, options?: Dyn): Dyn {
    if (!Array.isArray(args)) {
      options = args
      args = []
    }
    options = options || {}
    command = String(command)
    const argv: string[] = options.shell ? [typeof options.shell === 'string' ? options.shell : '/bin/sh', '-c', [command, ...args].join(' ')] : [command, ...args.map(String)]
    const child: Dyn = new ChildProcess()
    child.spawnfile = argv[0]
    child.spawnargs = argv

    let stdio = options.stdio ?? 'pipe'
    if (typeof stdio === 'string') stdio = [stdio, stdio, stdio]
    const fdOf = (v: Dyn): number | null => (typeof v === 'number' ? v : v && typeof v === 'object' && typeof v.fd === 'number' ? v.fd : null)
    const kind = (i: number): StdioKind => {
      const v = stdio[i]
      if (v == null || v === 'pipe' || v === 'overlapped') return 'pipe'
      if (v === 'ignore') return 'ignore'
      const fd = fdOf(v)
      if (fd !== null && fd > 2) return 'fd'
      return 'inherit'
    }
    // A descriptor handed to the child is duplicated now: the parent may close its copy before the child writes.
    const fdWriters = [0, 1, 2].map((i) => (kind(i) === 'fd' ? (fs.__dupForChild(fdOf(stdio[i])) as ((b: Uint8Array) => void) | null) : null))

    let proc: KernelProcess
    try {
      proc = kernel.spawn({ argv, env: stringEnv(options.env ?? process.env), cwd: options.cwd ? String(options.cwd) : process.cwd(), ppid: kproc.pid })
    } catch (e) {
      if (!(e instanceof KernelError)) throw e
      // Node creates the stdio streams even for a failed spawn, and destroys them after 'error'.
      if (kind(0) === 'pipe') child.stdin = new stream.Writable({ write: (_c: Dyn, _e: Dyn, cb: () => void) => cb() })
      if (kind(1) === 'pipe') child.stdout = new stream.Readable({ read() {} })
      if (kind(2) === 'pipe') child.stderr = new stream.Readable({ read() {} })
      child.stdio = [child.stdin, child.stdout, child.stderr]
      const error = Object.assign(new Error(`spawn ${command} ${e.code}`), { code: e.code, errno: e.errno, syscall: 'spawn ' + command, path: command, spawnargs: argv.slice(1) })
      track('child_process.spawn failed', `${command} ${e.code}`)
      live.ref()
      setTimeout(() => {
        if (core.exited) return
        child.emit('error', error)
        for (const s of child.stdio) s?.destroy()
        setTimeout(() => {
          if (!core.exited) child.emit('close', e.errno, null)
          live.unref()
        }, 0)
      }, 0)
      return child
    }

    child.pid = proc.pid
    child._kproc = proc
    child._refed = true
    live.ref()

    if (kind(0) === 'pipe') {
      child.stdin = new stream.Writable({
        write(chunk: Dyn, encoding: string, cb: () => void) {
          proc.stdin.write(typeof chunk === 'string' ? new Uint8Array(Buffer.from(chunk, encoding)) : new Uint8Array(chunk))
          cb()
        },
        final(cb: () => void) {
          proc.stdin.end()
          cb()
        },
      })
    } else proc.stdin.end() // the parent's own stdin cannot be shared; the child sees end of input

    const wire = (i: 1 | 2): Dyn => {
      const pipe = i === 1 ? proc.stdout : proc.stderr
      const mode = kind(i)
      if (mode === 'pipe') {
        const readable = new stream.Readable({ read() {} })
        pipe.pipeTo((chunk) => readable.push(chunk ? Buffer.from(chunk) : null))
        return readable
      }
      const writer = fdWriters[i]
      const parentStream = i === 1 ? process.stdout : process.stderr
      pipe.pipeTo((chunk) => {
        if (!chunk || core.exited) return
        if (mode === 'fd') writer?.(chunk)
        else if (mode === 'inherit') parentStream.write(Buffer.from(chunk))
      })
      return null
    }
    child.stdout = wire(1)
    child.stderr = wire(2)
    child.stdio = [child.stdin, child.stdout, child.stderr]

    setTimeout(() => !core.exited && child.emit('spawn'), 0)
    void proc.exited.then((status) => {
      if (core.exited) return
      child.exitCode = status.signal ? null : status.code
      child.signalCode = status.signal ?? null
      // 'exit' first, then 'close' once the stdio streams have ended, as Node does.
      setTimeout(() => {
        if (core.exited) return
        child.emit('exit', child.exitCode, child.signalCode)
        let closed = false
        const close = (): void => {
          if (closed) return
          closed = true
          if (!core.exited) child.emit('close', child.exitCode, child.signalCode)
          child.unref()
        }
        const streams: Dyn[] = [child.stdout, child.stderr].filter(Boolean)
        const check = (): void => {
          if (streams.every((s) => s.readableEnded || s.destroyed)) close()
        }
        for (const s of streams) {
          s.once('end', check)
          s.once('close', check)
        }
        check()
        // A parent that never reads the child's output must still get 'close'.
        setTimeout(() => {
          if (closed) return
          for (const s of streams) if (!s.readableEnded && s.listenerCount('data') === 0) s.resume()
          setTimeout(close, 50)
        }, 200)
      }, 0)
    })
    if (options.signal) options.signal.addEventListener('abort', () => child.kill(options.killSignal || 'SIGTERM'), { once: true })
    if (options.timeout) setTimeout(() => child.kill(options.killSignal || 'SIGTERM'), options.timeout)
    return child
  }

  function collect(child: Dyn, options: Dyn, cb: Dyn, commandText: string): Dyn {
    const encoding = options.encoding === 'buffer' || options.encoding === null ? null : options.encoding || 'utf8'
    const out: Dyn[] = []
    const err: Dyn[] = []
    child.stdout?.on('data', (d: Dyn) => out.push(d))
    child.stderr?.on('data', (d: Dyn) => err.push(d))
    const finish = (e: Dyn, code?: number | null, signal?: string | null): void => {
      if (!cb) return
      const so = Buffer.concat(out)
      const se = Buffer.concat(err)
      const stdout = encoding ? so.toString(encoding) : so
      const stderr = encoding ? se.toString(encoding) : se
      if (!e && (code !== 0 || signal)) e = Object.assign(new Error(`Command failed: ${commandText}\n${se.toString()}`), { code, killed: child.killed, signal: signal || null, cmd: commandText })
      if (e) Object.assign(e, { stdout, stderr })
      const f = cb
      cb = null
      f(e || null, stdout, stderr)
    }
    child.on('error', (e: Dyn) => finish(e))
    child.on('close', (code: number | null, signal: string | null) => finish(null, code, signal))
    return child
  }
  function exec(command: string, options?: Dyn, cb?: Dyn): Dyn {
    if (typeof options === 'function') {
      cb = options
      options = {}
    }
    options = options || {}
    return collect(spawn('/bin/sh', ['-c', command], { ...options, stdio: 'pipe' }), options, cb, command)
  }
  function execFile(file: string, args?: Dyn, options?: Dyn, cb?: Dyn): Dyn {
    if (typeof args === 'function') {
      cb = args
      args = []
      options = {}
    } else if (!Array.isArray(args)) {
      cb = options
      options = args
      args = []
    }
    if (typeof options === 'function') {
      cb = options
      options = {}
    }
    options = options || {}
    return collect(spawn(file, args, { ...options, stdio: 'pipe' }), options, cb, [file, ...args].join(' '))
  }
  const promisified =
    (fn: Dyn) =>
    (...args: Dyn[]) => {
      let child: Dyn
      const p: Dyn = new Promise((resolve, reject) => {
        child = fn(...args, (e: Dyn, stdout: Dyn, stderr: Dyn) => (e ? reject(e) : resolve({ stdout, stderr })))
      })
      p.child = child
      return p
    }
  ;(exec as Dyn)[util.promisify.custom] = promisified(exec)
  ;(execFile as Dyn)[util.promisify.custom] = promisified(execFile)

  // ---------------------------------------------------------------- synchronous variants

  interface SyncOutcome {
    status: number | null
    stdout: Uint8Array
    stderr: Uint8Array
    error?: Error
  }
  const warned = new Set<string>()
  function runSync(api: string, argv: string[], options: Dyn): SyncOutcome {
    const empty = new Uint8Array(0)
    const text = argv.join(' ')
    const missing = (reason: string): SyncOutcome => ({
      status: null,
      stdout: empty,
      stderr: empty,
      error: Object.assign(new Error(`${api} ${argv[0]} ENOENT${reason}`), { code: 'ENOENT', errno: -2, syscall: `${api} ${argv[0]}`, path: argv[0], spawnargs: argv.slice(1) }),
    })
    track('child_process.' + api, text.slice(0, 120))
    try {
      const input = options?.input == null ? empty : typeof options.input === 'string' ? new Uint8Array(Buffer.from(options.input)) : new Uint8Array(options.input)
      const r = kernel.runSync(argv, { env: stringEnv(options?.env ?? process.env), cwd: options?.cwd ? String(options.cwd) : process.cwd(), stdin: input })
      if (r) return { status: r.code, stdout: r.stdout, stderr: r.stderr }
    } catch (e) {
      if (e instanceof KernelError) return missing('')
      throw e
    }
    if (!warned.has(argv[0])) {
      warned.add(argv[0])
      kernel.log('warn', `node[${kproc.pid}]: ${api}("${text.slice(0, 80)}") cannot run: a synchronous child process cannot wait in a single thread. Reported as ENOENT.`)
    }
    return missing(' (synchronous child processes that need to wait cannot be emulated)')
  }
  const decode = (bytes: Uint8Array, options: Dyn): Dyn => {
    const b = Buffer.from(bytes)
    return options?.encoding && options.encoding !== 'buffer' ? b.toString(options.encoding) : b
  }
  /** A shell command line simple enough to run without a shell: plain words, no quoting or operators. */
  const simpleCommand = (command: string): string[] | null => {
    if (!/^[\w@%+=:,./\s-]+$/.test(command)) return null
    const words = command.trim().split(/\s+/)
    return words[0] === 'command' && words[1] === '-v' ? ['which', ...words.slice(2)] : words
  }
  function spawnSync(command: string, args?: Dyn, options?: Dyn): Dyn {
    if (!Array.isArray(args)) {
      options = args
      args = []
    }
    const argv = options?.shell ? (simpleCommand([command, ...args].join(' ')) ?? ['sh', '-c', [command, ...args].join(' ')]) : [String(command), ...args.map(String)]
    const r = runSync('spawnSync', argv, options)
    const stdout = decode(r.stdout, options)
    const stderr = decode(r.stderr, options)
    return { pid: 0, output: [null, stdout, stderr], stdout, stderr, status: r.status, signal: null, ...(r.error ? { error: r.error } : {}) }
  }
  const throwing = (api: string, argv: string[], options: Dyn): Dyn => {
    const r = runSync(api, argv, options)
    const stdout = decode(r.stdout, options)
    const stderr = decode(r.stderr, options)
    if (r.error) throw Object.assign(r.error, { status: null, signal: null, stdout, stderr, pid: 0, output: [null, stdout, stderr] })
    if (r.status !== 0) throw Object.assign(new Error(`Command failed: ${argv.join(' ')}\n${Buffer.from(r.stderr).toString()}`), { status: r.status, signal: null, stdout, stderr, pid: 0, output: [null, stdout, stderr] })
    return stdout
  }

  return {
    ChildProcess,
    spawn,
    exec,
    execFile,
    fork: (file: Dyn) => {
      track('child_process.fork', String(file))
      throw Object.assign(new Error('child_process.fork is not implemented in the machine (no IPC channel between Node processes)'), { code: 'ERR_NOT_IMPLEMENTED_IN_EMULATION' })
    },
    spawnSync,
    execSync: (command: string, options?: Dyn) => throwing('execSync', simpleCommand(String(command)) ?? ['sh', '-c', String(command)], options),
    execFileSync: (file: string, args?: Dyn, options?: Dyn) => {
      if (!Array.isArray(args)) {
        options = args
        args = []
      }
      return throwing('execFileSync', [String(file), ...args.map(String)], options)
    },
  }
}
