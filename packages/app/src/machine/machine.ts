// The Linux machine in this tab, as the app sees it: one per device, booted on first use in a
// dedicated worker (worker.ts). Coding-agent harnesses are installed and run inside it.
import { HARNESSES, type HarnessId } from '@beamhop/shared'
import kernelUrl from 'unkernel/unkernel.wasm?url'
import { kv } from '../core/kv'
import type { MachineNet, Reply, Request, WorkerEvent } from './protocol'

export interface MachineConfig {
  net: MachineNet
  /** Keep installed harnesses, sign-ins and files across reloads (IndexedDB). */
  persist: boolean
  memoryMiB: number
  /** Extra PEM certificates to trust (networks that inspect TLS). */
  extraCa: string
}

/** The Wisp server the machine uses unless the user picks another relay (Settings → Linux machine). */
export const DEFAULT_WISP_URL = 'wss://kucukkanat-wisp.wasmer.app/'

export const DEFAULT_MACHINE_CONFIG: MachineConfig = { net: { kind: 'wisp', url: DEFAULT_WISP_URL }, persist: true, memoryMiB: 2048, extraCa: '' }

export type MachineState = 'off' | 'booting' | 'ready' | 'error'

export interface Proc {
  stdin: WritableStream<Uint8Array>
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  kill(): void
}

export interface PtyHandle {
  write(data: string): void
  resize(cols: number, rows: number): void
  close(): void
  onData: ((d: Uint8Array) => void) | null
  onExit: ((code: number | null) => void) | null
}

/** The machine runs Debian: the harnesses' native Linux builds need glibc. */
export const DISTRO = 'debian'
const CA_PATH = '/usr/local/share/ca-certificates/beamhop-extra.crt'
const WORK = '/root/beamhop'

/** Can this browser run the machine? It needs WebAssembly JSPI (Chrome/Edge 137+, Firefox 153+, Safari 27+). */
export function machineSupported(): { ok: boolean; why?: string } {
  const W = WebAssembly as any
  if (typeof W.Suspending !== 'function' || typeof W.promising !== 'function')
    return { ok: false, why: 'This browser can’t run the Linux machine yet (it needs WebAssembly JSPI: Chrome or Edge 137+, Firefox 153+, Safari 27+).' }
  if (typeof Worker === 'undefined') return { ok: false, why: 'This browser has no Web Workers.' }
  return { ok: true }
}

export class Machine {
  state: MachineState = 'off'
  stage = ''
  error = ''
  /** Set when saving the machine's disk failed; shown in Settings. */
  storageError = ''
  config: MachineConfig = DEFAULT_MACHINE_CONFIG
  private worker: Worker | null = null
  private pending = new Map<number, (r: Reply) => void>()
  private ptys = new Map<number, PtyHandle>()
  private nextId = 1
  private booting: Promise<void> | null = null
  private listeners = new Set<() => void>()
  /** Harness setups in progress, so two agents don't install the same harness twice at once. */
  private setups = new Map<HarnessId, Promise<void>>()

  async load() {
    this.config = { ...DEFAULT_MACHINE_CONFIG, ...((await kv.get<MachineConfig>('machine:config')) ?? {}) }
  }

  async saveConfig(c: Partial<MachineConfig>) {
    this.config = { ...this.config, ...c }
    await kv.set('machine:config', this.config)
    this.changed()
  }

  onChange(fn: () => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  private changed() {
    for (const fn of this.listeners) fn()
  }

  private call(req: Request): Promise<any> {
    const w = this.worker
    if (!w) return Promise.reject(new Error('The machine is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, (r) => (r.ok ? resolve(r) : reject(new Error(r.error))))
      w.postMessage({ ...req, id })
    })
  }

  /** Boots the machine if it isn't running. */
  ensure(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    return (this.booting ??= this.boot().finally(() => (this.booting = null)))
  }

  private async boot() {
    const sup = machineSupported()
    if (!sup.ok) throw new Error(sup.why)
    this.state = 'booting'
    this.error = ''
    this.storageError = ''
    // Ask the browser not to evict the machine's disk under storage pressure.
    if (this.config.persist) await navigator.storage?.persist?.().catch(() => false)
    this.stage = 'Starting'
    this.changed()
    try {
      if (!this.worker) {
        const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'beamhop-machine' })
        w.onmessage = ({ data }: MessageEvent<Reply | WorkerEvent>) => {
          if ('event' in data) return this.onEvent(data)
          const fn = this.pending.get(data.id)
          this.pending.delete(data.id)
          fn?.(data)
        }
        w.onerror = (e) => {
          this.fail(e.message || 'The machine crashed')
        }
        this.worker = w
      }
      await this.call({
        op: 'boot',
        boot: {
          kernelUrl: new URL(kernelUrl, location.href).href,
          distroUrl: new URL(`distros/${DISTRO}.erofs`, document.baseURI).href,
          net: this.config.net,
          memoryMiB: this.config.memoryMiB,
          persist: this.config.persist,
          extraCa: this.config.extraCa,
        },
      })
      this.state = 'ready'
      this.stage = ''
      this.changed()
    } catch (e: any) {
      this.fail(e?.message ?? String(e))
      throw e
    }
  }

  private fail(msg: string) {
    this.state = 'error'
    this.error = msg
    this.changed()
  }

  private onEvent(e: WorkerEvent) {
    if (e.event === 'progress') {
      this.stage = e.stage
      this.changed()
    } else if (e.event === 'pty-data') this.ptys.get(e.pty)?.onData?.(e.data)
    else if (e.event === 'pty-exit') {
      this.ptys.get(e.pty)?.onExit?.(e.code)
      this.ptys.delete(e.pty)
    } else if (e.event === 'exited') {
      this.state = 'off'
      this.stage = ''
      this.changed()
    } else if (e.event === 'log') console.info('[machine]', e.line)
    else if (e.event === 'storage-error') {
      console.warn('[machine] storage', e.message)
      this.storageError = e.message
      this.changed()
    }
  }

  /** Stops the machine (after flushing its disk). Running agents stop with it. */
  async stop() {
    if (!this.worker) return
    await this.call({ op: 'stop' }).catch(() => {})
    this.worker.terminate()
    this.worker = null
    for (const fn of this.pending.values()) fn({ id: 0, ok: false, error: 'The machine stopped' })
    this.pending.clear()
    this.state = 'off'
    this.changed()
  }

  /** Runs a shell command (as root, login shell) and returns its output. */
  async exec(cmd: string, env?: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number | null }> {
    await this.ensure()
    return (await this.call({ op: 'exec', cmd, env: { ...this.baseEnv(), ...env } })).result
  }

  /** Starts a program with pipes. `cmd` is looked up on the login shell's PATH. */
  async spawn(cmd: string, args: string[], opts: { env?: Record<string, string>; cwd?: string } = {}): Promise<Proc> {
    await this.ensure()
    const r = await this.call({
      op: 'spawn',
      cmd: 'sh',
      args: ['-lc', 'exec "$@"', 'sh', cmd, ...args],
      env: { ...this.baseEnv(), ...opts.env },
      cwd: opts.cwd,
    })
    const proc = r.result.proc as number
    return { stdin: r.stdin, stdout: r.stdout, stderr: r.stderr, kill: () => void this.call({ op: 'kill', proc }).catch(() => {}) }
  }

  /** A login shell on a terminal, for signing in to a harness or looking around. */
  async pty(cols: number, rows: number, env?: Record<string, string>): Promise<PtyHandle> {
    await this.ensure()
    const r = await this.call({ op: 'pty', cols, rows, env: { ...this.baseEnv(), TERM: 'xterm-256color', ...env } })
    const id = r.result.pty as number
    const h: PtyHandle = {
      write: (data) => void this.call({ op: 'pty-write', pty: id, data }).catch(() => {}),
      resize: (c, rw) => void this.call({ op: 'pty-resize', pty: id, cols: c, rows: rw }).catch(() => {}),
      close: () => void this.call({ op: 'pty-close', pty: id }).catch(() => {}),
      onData: null,
      onExit: null,
    }
    this.ptys.set(id, h)
    return h
  }

  private baseEnv(): Record<string, string> {
    const env: Record<string, string> = { HOME: '/root' }
    if (this.config.extraCa.trim()) env.NODE_EXTRA_CA_CERTS = CA_PATH
    return env
  }

  // ---- harnesses

  /** Is `id` installed in this device's machine? (Remembered; checked again before each run.) */
  async harnessReady(id: HarnessId) {
    return !!(await kv.get<boolean>(`machine:ready:${id}`))
  }

  /** Installs a harness in the machine. `onLine` gets progress lines. */
  setupHarness(id: HarnessId, onLine: (l: string) => void = () => {}, customCommand?: string): Promise<void> {
    const cur = this.setups.get(id)
    if (cur) return cur
    const p = (async () => {
      const h = HARNESSES[id]
      if (this.config.net.kind === 'none' && id !== 'custom')
        throw new Error('The machine has no internet connection, so it can’t download the agent. Set a network relay under Settings → Linux machine.')
      onLine('Starting the machine…')
      await this.ensure()
      if (id === 'custom') {
        if (!customCommand?.trim()) throw new Error('Enter the command that starts your ACP agent.')
        await this.writeFile('/root/.beamhop/custom-agent', `#!/bin/sh\n${customCommand}\n`)
      }
      onLine(`Installing ${h.label}… (this downloads the official Linux build and can take a few minutes)`)
      await this.exec(`mkdir -p ${WORK}`)
      for (const step of h.machineSetup) {
        const r = await this.exec(`cd ${WORK} && ${step}`)
        if (r.code !== 0) {
          const tail = (r.stdout + r.stderr)
            .split('\n')
            .filter((l) => l.trim() && !l.startsWith('npm notice'))
            .slice(-8)
            .join('\n')
          throw new Error(`${h.label} didn’t install (${step.split(' ').slice(0, 3).join(' ')} failed).${tail ? `\n${tail}` : ''}`)
        }
      }
      const check = await this.exec(`command -v ${h.acp.cmd} >/dev/null && echo yes`)
      if (!check.stdout.includes('yes')) throw new Error(`${h.label} didn’t install: ${h.acp.cmd} isn’t on the machine’s PATH.`)
      await this.call({ op: 'sync' }).catch(() => {})
      await kv.set(`machine:ready:${id}`, true)
      onLine(`${h.label} is ready.`)
      this.changed()
    })().finally(() => this.setups.delete(id))
    this.setups.set(id, p)
    return p
  }

  async writeFile(path: string, content: string) {
    await this.ensure()
    const dir = path.replace(/\/[^/]*$/, '') || '/'
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(content)))
    const r = await this.exec(`mkdir -p '${dir}' && echo '${b64}' | base64 -d > '${path}' && chmod 700 '${path}'`)
    if (r.code !== 0) throw new Error(`Couldn’t write ${path}: ${r.stderr}`)
  }

  /** The API key a harness reads from its environment, kept on this device only. */
  async harnessKey(id: HarnessId) {
    return (await kv.get<string>(`machine:key:${id}`)) ?? ''
  }
  async setHarnessKey(id: HarnessId, key: string) {
    if (key) await kv.set(`machine:key:${id}`, key)
    else await kv.del(`machine:key:${id}`)
  }

  /** Forget everything in the machine: installed harnesses, sign-ins, files. */
  async reset() {
    await this.stop()
    const { resetDataDisk } = await import('unkernel/web')
    await resetDataDisk({ name: 'beamhop-machine' })
    for (const id of Object.keys(HARNESSES)) await kv.del(`machine:ready:${id}`)
    this.changed()
  }

  /** Working directory for an agent's files. */
  workDir(agentId: string) {
    return `${WORK}/${agentId}`
  }
}

export const machine = new Machine()
