// The `process` object of one Node process, its stdio, and the liveness tracker that decides when the
// "event loop" is empty. Backed by a kernel Process: stdio are its pipes, exit is its exit.
import { KernelError } from '../kernel/errors.js'
import type { Kernel } from '../kernel/kernel.js'
import { resolve as resolvePath } from '../kernel/path.js'
import { type Process, SIGNALS, signalName } from '../kernel/process.js'
import { createTimers } from './timers.js'
import type { Dyn, ProcessCore, Track } from './types.js'
import { BufferPkg as Buffer } from './vendor.js'

/**
 * Thrown by process.exit(). JavaScript cannot abandon a running stack, so exit raises this sentinel and marks
 * the process dead; guest code that catches it keeps running until it next yields, but its output is dropped.
 */
export class ProcessExit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
    this.name = 'ProcessExit'
  }
}

export const NODE_VERSION = '22.12.0'
export const EXEC_PATH = '/usr/local/bin/node'
/** Idle checks before an empty loop ends the process, and their spacing. Work that holds no handle gets this long. */
const IDLE_CHECKS = 3
const IDLE_CHECK_MS = 15

interface Deps {
  EventEmitter: Dyn
  stream: Dyn
  kernel: Kernel
  kproc: Process
  argv: string[]
  track: Track
  getBuiltin(id: string): Dyn
}

const hostPerformance = performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }

export function createProcess({ EventEmitter, stream, kernel, kproc, argv, track, getBuiltin }: Deps): ProcessCore {
  const process: Dyn = new EventEmitter()
  process.setMaxListeners(100)
  let exited = false
  let mainStarted = false

  // ---- liveness: ref-counted handles (timers, sockets, children, pending requests) ----
  let handles = 0
  let idleChecks = 0
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleIdleCheck = (): void => {
    if (exited || idleTimer || !mainStarted) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (exited) return
      if (handles > 0) {
        idleChecks = 0
        return
      }
      if (++idleChecks < IDLE_CHECKS) return scheduleIdleCheck()
      try {
        process.emit('beforeExit', process.exitCode ?? 0)
      } catch (e) {
        uncaught(e)
      }
      if (handles > 0) {
        idleChecks = 0
        return
      }
      doExit(process.exitCode ?? 0)
    }, IDLE_CHECK_MS)
  }
  const live = {
    ref(): void {
      handles++
      idleChecks = 0
    },
    unref(): void {
      handles = Math.max(0, handles - 1)
      if (handles === 0) scheduleIdleCheck()
    },
    get handles(): number {
      return handles
    },
    start(): void {
      mainStarted = true
      scheduleIdleCheck()
    },
  }

  function markDead(): void {
    exited = true
    if (idleTimer) clearTimeout(idleTimer)
    timers.stopAll()
  }
  function doExit(code: number): void {
    if (exited) return
    process.exitCode = code
    try {
      process.emit('exit', code)
    } catch (e) {
      if (!(e instanceof ProcessExit)) kernel.log('error', `node[${kproc.pid}]: error in 'exit' listener: ${String(e)}`)
    }
    markDead()
    kproc.finish({ code: Number(process.exitCode ?? code) || 0 })
  }
  function uncaught(e: unknown): void {
    if (e instanceof ProcessExit || exited) return
    if (process.listenerCount('uncaughtException') > 0) {
      try {
        process.emit('uncaughtException', e, 'uncaughtException')
      } catch (e2) {
        if (!(e2 instanceof ProcessExit)) kernel.log('error', `node[${kproc.pid}]: error in 'uncaughtException' listener: ${String(e2)}`)
      }
      return
    }
    const err = e as { stack?: string } | null
    kproc.stderr.write(new TextEncoder().encode(`Uncaught ${(err && err.stack) || String(e)}\n`))
    doExit(1)
  }
  function unhandledRejection(reason: unknown, promise: unknown): void {
    if (reason instanceof ProcessExit || exited) return
    if (process.listenerCount('unhandledRejection') > 0) {
      try {
        process.emit('unhandledRejection', reason, promise)
      } catch (e2) {
        if (!(e2 instanceof ProcessExit)) kernel.log('error', `node[${kproc.pid}]: error in 'unhandledRejection' listener: ${String(e2)}`)
      }
      return
    }
    uncaught(reason)
  }

  const timers = createTimers({ live, exited: () => exited, onError: uncaught })

  // The kernel ended the process from outside (kill): nothing more may run or be written.
  kproc.terminated.addEventListener('abort', markDead, { once: true })
  // Signals with a listener are delivered to it, as in Node; without one the kernel terminates the process.
  kproc.signalHandler = (signal) => {
    if (exited || process.listenerCount(signal) === 0) return false
    setTimeout(() => {
      try {
        process.emit(signal, signal, SIGNALS[signal])
      } catch (e) {
        uncaught(e)
      }
    }, 0)
    return true
  }

  // ---- stdio ----
  const mkOut = (fd: number, pipe: Process['stdout']): Dyn => {
    const w = new stream.Writable({
      decodeStrings: false,
      write(chunk: Dyn, encoding: string, cb: (e?: Error | null) => void) {
        if (exited) track('output written after exit (dropped)')
        else pipe.write(typeof chunk === 'string' ? new Uint8Array(Buffer.from(chunk, encoding === 'buffer' ? 'utf8' : encoding)) : new Uint8Array(chunk))
        cb()
      },
    })
    w.fd = fd
    w.isTTY = false
    w._isStdio = true
    w.destroySoon = w.destroy
    w._destroy = (err: Error | null, cb: (e: Error | null) => void) => cb(err)
    w.getColorDepth = () => 1
    w.hasColors = () => false
    w.getWindowSize = () => [80, 24]
    w.ref = () => w
    w.unref = () => w
    return w
  }
  const stdout = mkOut(1, kproc.stdout)
  const stderr = mkOut(2, kproc.stderr)

  // stdin keeps the process alive while it is being read and has not ended, as a pipe does in Node.
  let stdinHeld = false
  let stdinEnded = false
  let stdinWanted = true
  let stdinStarted = false
  let stdinLeftover: Uint8Array | null = null
  const holdStdin = (want: boolean): void => {
    const hold = want && stdinStarted && !stdinEnded && stdinWanted
    if (hold === stdinHeld) return
    stdinHeld = hold
    if (hold) live.ref()
    else live.unref()
  }
  const stdin = new stream.Readable({
    read() {
      if (stdinStarted) return
      stdinStarted = true
      holdStdin(true)
      kproc.stdin.pipeTo((chunk) => {
        if (exited) return
        if (chunk) stdin.push(Buffer.from(chunk))
        else {
          stdinEnded = true
          holdStdin(false)
          stdin.push(null)
        }
      })
    },
  })
  stdin.fd = 0
  stdin.isTTY = false
  stdin.setRawMode = () => stdin
  stdin.ref = () => ((stdinWanted = true), holdStdin(true), stdin)
  stdin.unref = () => ((stdinWanted = false), holdStdin(false), stdin)
  stdin.on('pause', () => holdStdin(false))
  stdin.on('resume', () => holdStdin(true))

  const startTime = hostPerformance.now()
  const mem = () => hostPerformance.memory ?? { usedJSHeapSize: 0, totalJSHeapSize: 0 }
  const exit = (code?: number): never => {
    const c = code ?? process.exitCode ?? 0
    doExit(c)
    throw new ProcessExit(c)
  }
  Object.assign(process, {
    title: 'node',
    pid: kproc.pid,
    ppid: kproc.ppid,
    platform: 'linux',
    arch: 'x64',
    version: 'v' + NODE_VERSION,
    versions: { node: NODE_VERSION, v8: '12.4.254.21-node.21', uv: '1.49.2', modules: '127', openssl: '3.0.15', zlib: '1.3.0.1-motley', undici: '6.21.0', ares: '1.34.3', napi: '9' },
    release: { name: 'node', lts: 'Jod' },
    argv,
    argv0: 'node',
    execArgv: [],
    execPath: EXEC_PATH,
    env: kproc.env,
    exitCode: undefined,
    config: { variables: {}, target_defaults: {} },
    features: { inspector: false, ipv6: true, tls: true, typescript: false, require_module: true },
    allowedNodeEnvironmentFlags: new Set(),
    browser: false, // readable-stream and others check this
    stdout,
    stderr,
    stdin,
    cwd: () => kproc.cwd,
    chdir: (dir: string) => {
      const target = resolvePath(kproc.cwd, String(dir))
      if (kernel.vfs.kindOf(target) !== 'dir') throw new KernelError('ENOENT', 'chdir', String(dir))
      kproc.cwd = target
    },
    umask: () => 0o22,
    uptime: () => (hostPerformance.now() - startTime) / 1000,
    hrtime: Object.assign(
      (prev?: [number, number]) => {
        const t = hostPerformance.now()
        let s = Math.floor(t / 1000)
        let n = Math.floor((t % 1000) * 1e6)
        if (prev) {
          s -= prev[0]
          n -= prev[1]
          if (n < 0) {
            s--
            n += 1e9
          }
        }
        return [s, n]
      },
      { bigint: () => BigInt(Math.floor(hostPerformance.now() * 1e6)) },
    ),
    nextTick: (fn: Dyn, ...args: Dyn[]) =>
      queueMicrotask(() => {
        if (exited) return
        try {
          fn(...args)
        } catch (e) {
          uncaught(e)
        }
      }),
    memoryUsage: Object.assign(() => ({ rss: mem().totalJSHeapSize, heapTotal: mem().totalJSHeapSize, heapUsed: mem().usedJSHeapSize, external: 0, arrayBuffers: 0 }), { rss: () => mem().totalJSHeapSize }),
    cpuUsage: () => ({ user: Math.floor(hostPerformance.now() * 1000), system: 0 }),
    resourceUsage: () => ({ userCPUTime: 0, systemCPUTime: 0, maxRSS: 0 }),
    constrainedMemory: () => 0,
    availableMemory: () => 2 ** 31,
    getuid: () => 1000,
    geteuid: () => 1000,
    getgid: () => 1000,
    getegid: () => 1000,
    getgroups: () => [1000],
    kill: (pid: number, signal?: string | number) => {
      track('process.kill', `${pid} ${String(signal)}`)
      if (signal === 0) {
        if (pid !== kproc.pid && !kernel.get(pid)) throw new KernelError('ESRCH', 'kill')
        return true
      }
      // Signalling oneself with a listener installed runs the listener; anything else is the kernel's business.
      if (pid === kproc.pid && process.listenerCount(signalName(signal)) > 0 && signalName(signal) !== 'SIGKILL') process.emit(signalName(signal), signalName(signal))
      else kernel.kill(pid, signal)
      return true
    },
    exit,
    reallyExit: exit,
    abort: () => exit(134),
    emitWarning: (w: Dyn) => track('process.emitWarning', String((w && w.message) || w).slice(0, 200)),
    binding: (name: string) => {
      track('process.binding', name)
      throw new Error('process.binding is not supported in the emulation layer: ' + name)
    },
    dlopen: () => {
      track('process.dlopen')
      throw new Error('process.dlopen is not supported in the emulation layer')
    },
    setUncaughtExceptionCaptureCallback: () => {},
    hasUncaughtExceptionCaptureCallback: () => false,
    setSourceMapsEnabled: () => {},
    sourceMapsEnabled: false,
    getActiveResourcesInfo: () => [],
    _getActiveHandles: () => [],
    _getActiveRequests: () => [],
    report: { getReport: () => ({ header: { glibcVersionRuntime: '2.39' }, sharedObjects: [] }), writeReport: () => '' },
    channel: undefined,
    connected: false,
    noDeprecation: true,
    getBuiltinModule: (id: string) => getBuiltin(id),
    loadEnvFile: () => {},
    mainModule: undefined,
  })

  return {
    process,
    kernel,
    kproc,
    live,
    timers,
    track,
    get exited() {
      return exited
    },
    exit: doExit,
    uncaught,
    unhandledRejection,
    readStdinSync(target) {
      const chunk = stdinLeftover ?? kproc.stdin.tryRead()
      stdinLeftover = null
      if (!chunk) {
        if (kproc.stdin.readableEnded) return 0
        throw Object.assign(new Error('EAGAIN: resource temporarily unavailable, read'), { code: 'EAGAIN', errno: -11, syscall: 'read' })
      }
      const n = Math.min(chunk.byteLength, target.byteLength)
      target.set(chunk.subarray(0, n))
      if (n < chunk.byteLength) stdinLeftover = chunk.subarray(n)
      return n
    },
  }
}
