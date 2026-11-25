// The `node` program: boots one Node process on a kernel process (emulated built-ins, module loader, globals)
// and runs a script the way `node script.js args…` does.
//
// Nothing harness-specific belongs here. Environment variables that make a particular harness behave
// (GEMINI_CLI_NO_RELAUNCH and friends) live with the harness definitions in src/harness.
import type { Program, ProcessContext } from '../kernel/process.js'
import { resolve as resolvePath } from '../kernel/path.js'
import { makeAsyncHooks } from './builtins/async-hooks.js'
import { makeBuffer, makeEvents, makeOs, makePath, makeReadline, makeStream, makeTty, makeUtil, TrackedReadableStream } from './builtins/core.js'
import { makeCrypto } from './builtins/crypto.js'
import { makeMisc } from './builtins/misc.js'
import { makeZlib } from './builtins/zlib.js'
import { createChildProcess } from './child_process.js'
import { createFs } from './fs.js'
import { createFetchSlot, createGuestGlobal, HIDDEN_GLOBALS, removeBrowserOnlyGlobals } from './globals.js'
import { createLoader, type EsmTransform, type Loader } from './loader.js'
import { createNet } from './net/index.js'
import { createProcess, EXEC_PATH, NODE_VERSION, ProcessExit } from './process.js'
import { shimHooks } from './process-shim.js'
import type { Dyn, ProcessCore, Track } from './types.js'
import { assertPkg } from './vendor.js'

export interface NodeProgramOptions {
  /** Precompiled ES modules from mounted images (absolute path -> System.register code). Shared by all processes. */
  esmCache: Map<string, Uint8Array>
  /** Returns the in-worker ES module transformer, loading it on first use. */
  loadTransformer(): EsmTransform
  /** Called when a Node process ends, with what it used. For diagnostics and measurements. */
  onStats?(info: { pid: number; loader: Loader['stats']; usage: Record<string, number> }): void
}

const indirectEval = eval
const evaluate = (code: string, file: string): Dyn => indirectEval(`${code}\n//# sourceURL=file://${file}`)

// ---- errors nothing caught ----
// The platform reports them on the global, with no notion of which program they belong to. They go to the most
// recently started Node process that is still running; with a single harness process that is exact.
const running: ProcessCore[] = []
const current = (): ProcessCore | undefined => running[running.length - 1]
let hooksInstalled = false
function installGlobalHooks(): void {
  if (hooksInstalled) return
  hooksInstalled = true
  removeBrowserOnlyGlobals()
  shimHooks.onError = (error) => current()?.uncaught(error)
  const g = globalThis as Dyn
  if (typeof g.addEventListener === 'function' && typeof g.WorkerGlobalScope !== 'undefined') {
    g.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
      const core = current()
      if (!core && !(ev.reason instanceof ProcessExit)) return
      ev.preventDefault()
      core?.unhandledRejection(ev.reason, ev.promise)
    })
    g.addEventListener('error', (ev: ErrorEvent) => {
      const core = current()
      if (!core && !(ev.error instanceof ProcessExit)) return
      ev.preventDefault()
      core?.uncaught(ev.error ?? new Error(ev.message))
    })
  } else if (typeof g.process?.listeners === 'function') {
    // A Node host (tests, the desktop bridge): put the same routing in front of whatever handlers the host has.
    for (const [event, route] of [
      ['unhandledRejection', (core: ProcessCore, reason: unknown, promise: unknown) => core.unhandledRejection(reason, promise)],
      ['uncaughtException', (core: ProcessCore, error: unknown) => core.uncaught(error)],
    ] as const) {
      const previous: ((...args: unknown[]) => void)[] = g.process.listeners(event)
      g.process.removeAllListeners(event)
      g.process.on(event, (...args: unknown[]) => {
        const core = current()
        if (core) return route(core, args[0], args[1])
        if (args[0] instanceof ProcessExit) return
        for (const listener of previous) listener(...args)
      })
    }
  }
}

interface Invocation {
  script: string | null
  evalSource: string | null
  print: boolean
  inputType: 'module' | 'commonjs'
  args: string[]
  version: boolean
}

/** `node [options] [script] [arguments]`. Options the layer has no use for (V8 flags and the like) are skipped. */
export function parseNodeArgs(args: string[]): Invocation {
  const inv: Invocation = { script: null, evalSource: null, print: false, inputType: 'commonjs', args: [], version: false }
  const takesValue = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--env-file', '--title', '--max-http-header-size'])
  let i = 0
  for (; i < args.length; i++) {
    const a = args[i]
    if (a === '--') {
      i++
      break
    }
    if (!a.startsWith('-') || a === '-') break
    if (a === '-v' || a === '--version') inv.version = true
    else if (a === '-e' || a === '--eval' || a === '-p' || a === '--print' || a === '-pe') {
      inv.evalSource = args[++i] ?? ''
      inv.print = a !== '-e' && a !== '--eval'
    } else if (a.startsWith('--input-type=')) inv.inputType = a.endsWith('module') ? 'module' : 'commonjs'
    else if (takesValue.has(a)) i++
  }
  if (inv.evalSource === null && i < args.length) inv.script = args[i++]
  inv.args = args.slice(i)
  return inv
}

export function createNodeProgram(options: NodeProgramOptions): Program {
  return {
    kind: 'node',
    start(ctx: ProcessContext): void {
      installGlobalHooks()
      const { kernel, process: kproc } = ctx
      const inv = parseNodeArgs(kproc.argv.slice(1))
      if (inv.version) {
        kproc.stdout.write(new TextEncoder().encode(`v${NODE_VERSION}\n`))
        return ctx.exit(0)
      }
      const scriptPath = inv.script !== null ? resolvePath(kproc.cwd, inv.script) : null

      const usage: Record<string, number> = Object.create(null)
      const track: Track = (name) => void (usage[name] = (usage[name] ?? 0) + 1)

      const bufferMod = makeBuffer()
      const { Buffer } = bufferMod
      const EventEmitter = makeEvents()
      const stream = makeStream(Buffer)
      const path = makePath()

      // The loader and the process object refer to each other (process.getBuiltinModule, loader's cwd).
      let loader!: Loader
      const core = createProcess({ EventEmitter, stream, kernel, kproc, argv: [EXEC_PATH, ...(scriptPath ? [scriptPath] : []), ...inv.args], track, getBuiltin: (id) => loader.getBuiltin(id) })
      const { process, timers } = core
      const host: Dyn = globalThis
      const util = makeUtil({ Buffer, process })
      const fs = createFs({ vfs: kernel.vfs, core, stream, EventEmitter })
      const net = createNet({ core, stream, EventEmitter })
      const childProcess = createChildProcess({ core, fs, stream, EventEmitter, util })
      const os = makeOs({ process, host })

      const fetchSlot = createFetchSlot(net.fetch)
      const navigator = { userAgent: `Node.js/${NODE_VERSION.split('.')[0]}`, language: 'en-US', languages: ['en-US'], platform: 'linux', hardwareConcurrency: host.navigator?.hardwareConcurrency || 4 }
      // Per-process globals. `scopeNames` become parameters of every module wrapper; see globals.ts.
      const own: Record<string, Dyn> = {
        process,
        Buffer,
        console: null,
        fetch: null,
        navigator,
        ReadableStream: TrackedReadableStream,
        setTimeout: timers.setTimeout,
        setInterval: timers.setInterval,
        setImmediate: timers.setImmediate,
        clearTimeout: timers.clearTimeout,
        clearInterval: timers.clearInterval,
        clearImmediate: timers.clearImmediate,
      }
      // `globalThis.fetch` reads and writes the slot; the bare identifier `fetch` is the slot's trampoline.
      Object.defineProperty(own, 'fetch', { get: fetchSlot.get, set: fetchSlot.set, enumerable: true, configurable: true })
      const scopeValue = (name: string): Dyn => (name === 'fetch' ? fetchSlot.call : own[name])
      const guestGlobal = createGuestGlobal(own)
      own.global = guestGlobal
      own.globalThis = guestGlobal
      /** Evaluate source text with the process's globals in scope (vm.runInThisContext, node -p). */
      const evaluateInScope = (code: string, file: string): Dyn => {
        const names = Object.keys(own)
        const run = evaluate(`(function (${[...HIDDEN_GLOBALS, ...names].join(', ')}) { return eval(arguments[arguments.length - 1]) })`, file)
        return run(...HIDDEN_GLOBALS.map(() => undefined), ...names.map(scopeValue), code)
      }
      const misc = makeMisc({ Buffer, EventEmitter, stream, util, process, track, host, evaluate: evaluateInScope, timers })
      own.console = misc.console

      const assert = assertPkg
      assert.strict ??= assert
      const readline = makeReadline({ EventEmitter, process, util })
      const builtins: Record<string, Dyn> = {
        assert,
        'assert/strict': assert.strict,
        async_hooks: makeAsyncHooks({ track }),
        buffer: bufferMod,
        child_process: childProcess,
        constants: { ...fs.constants, ...os.constants.signals },
        crypto: makeCrypto({ Buffer, stream, track, host }),
        events: EventEmitter,
        fs,
        'fs/promises': fs.promises,
        http: net.http,
        https: net.https,
        net: net.net,
        os,
        path,
        'path/posix': path,
        'path/win32': path,
        process,
        readline,
        'readline/promises': readline.promises,
        stream,
        'stream/promises': stream.promises,
        tls: net.tls,
        tty: makeTty({ stream }),
        util,
        'util/types': util.types,
        sys: util,
        zlib: makeZlib({ Buffer, stream, track }),
        module: null,
        ...misc,
      }
      const scopeNames = Object.keys(own)
      loader = createLoader({
        vfs: kernel.vfs,
        core,
        builtins,
        evaluate,
        scope: { names: [...HIDDEN_GLOBALS, ...scopeNames], values: [...HIDDEN_GLOBALS.map(() => undefined), ...scopeNames.map(scopeValue)] },
        esmCache: options.esmCache,
        loadTransformer: options.loadTransformer,
      })
      builtins.module = loader.moduleBuiltin

      running.push(core)
      void kproc.exited.then(() => {
        const i = running.indexOf(core)
        if (i !== -1) running.splice(i, 1)
        options.onStats?.({ pid: kproc.pid, loader: loader.stats, usage })
      })

      let main: Promise<void>
      try {
        if (inv.evalSource !== null) {
          const file = resolvePath(kproc.cwd, '[eval]')
          if (inv.print) {
            const value = evaluateInScope(inv.evalSource, file)
            misc.console.log(value)
            main = Promise.resolve()
          } else main = loader.runSource(inv.evalSource, inv.inputType === 'module' ? file + '.mjs' : file, inv.inputType === 'module' ? 'esm' : 'cjs')
        } else if (scriptPath) main = loader.runMain(scriptPath)
        else {
          // `node` with no script reads the program from stdin. There is no REPL.
          main = kproc.stdin.readAll().then((src) => loader.runSource(new TextDecoder().decode(src), resolvePath(kproc.cwd, '[stdin]'), 'cjs'))
        }
      } catch (e) {
        core.uncaught(e)
        main = Promise.resolve()
      }
      main.catch((e) => core.uncaught(e)).finally(() => core.live.start())
    },
  }
}
