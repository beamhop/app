// What the Beamhop app imports to run a machine: it embeds the machine frame, performs the handshake, and turns
// the wire protocol into typed async methods. It also answers the machine's network requests by calling the
// `net` object the app provides, and watches the machine's heartbeat.
//
// Browser-only, no Node dependencies. One Machine per iframe; dispose() removes the frame and with it the
// worker, every process and (until storage exists) every file.
import { type AppRequest, type AppResults, type Bytes, type FsStat, MACHINE_PROTOCOL, type MachineEvent, type MachineHello, type MachineInit, type NetEvent, type NetRequest, type NetResults } from './protocol.js'
import { Channel, compact, RpcError } from './rpc.js'

export { RpcError as MachineError } from './rpc.js'
export type { FsStat } from './protocol.js'

// ---------------------------------------------------------------- the network the app provides

/** Throw this (or any Error with a string `code`) from MachineNet methods; the code reaches the program inside the machine. */
export class NetFailure extends Error {
  constructor(
    /** Proxy codes: auth, policy, dns, connect, timeout, limit. */
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'NetFailure'
  }
}

export interface NetSocketEvents {
  data(chunk: Uint8Array): void
  /** The remote side finished sending. */
  end(): void
  /** The connection is gone; pass a message if it did not close cleanly. */
  close(error?: string): void
}
export interface NetSocket {
  write(chunk: Uint8Array): void
  /** Half-close: the machine will send no more. */
  end(): void
  close(): void
}
export interface NetHttpRequest {
  url: string
  method: string
  headers: [string, string][]
  /** The whole request body (the machine buffers request bodies), or null. */
  body: Uint8Array | null
  /** Aborted when the machine gives up on the exchange. */
  signal: AbortSignal
}
export interface NetHttpResponse {
  status: number
  headers: [string, string][]
  /** Must be the decoded body: if the transport undid a content-encoding, that is what the machine expects. */
  body: ReadableStream<Uint8Array> | null
}

/**
 * The machine has no network of its own. The app implements this against a proxy (tunnel mode for openSocket,
 * plain mode or a direct CORS fetch for openHttp) and decides what a machine may reach.
 */
export interface MachineNet {
  /** Open a TCP connection. Resolve once connected; reject with a NetFailure otherwise. */
  openSocket(destination: { host: string; port: number }, events: NetSocketEvents): Promise<NetSocket>
  /** Perform one HTTP exchange. Redirects must not be followed; the machine handles them. */
  openHttp(request: NetHttpRequest): Promise<NetHttpResponse>
}

// ---------------------------------------------------------------- the machine

export interface MachineOptions {
  /** URL of machine.html on the machine origin (one origin per workspace). */
  frameUrl: string
  /** Where the (invisible) iframe is attached. */
  container: HTMLElement
  net: MachineNet
  /** The machine asked for a URL to be opened in a real tab (login pages). The app decides whether to. */
  onOpenUrl?: (url: string) => void
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
  /**
   * Watchdog. The machine is single-threaded: a program stuck in synchronous code freezes all of it. When no
   * heartbeat arrives for `timeoutMs` (default 5000) `onUnresponsive` is called once; if heartbeats come back,
   * `onResponsive`. The usual reaction to a machine that stays frozen is dispose() and a new machine.
   */
  watchdog?: { timeoutMs?: number; onUnresponsive?: (info: { silentMs: number; phase: 'handshake' | 'running' }) => void; onResponsive?: () => void }
}

export interface BootOptions {
  workspaceId: string
  env?: Record<string, string>
  /** How the machine's sockets leave it: 'tunnel' (default) uses openSocket, 'http' uses openHttp only. */
  net?: 'tunnel' | 'http' | 'none'
}
export interface SpawnOptions {
  env?: Record<string, string>
  cwd?: string
  /** 'none' gives the process an already-closed stdin. Default 'pipe'. */
  stdin?: 'pipe' | 'none'
}
export interface ExitInfo {
  code: number
  signal?: string
}
export interface MachineProcess {
  readonly pid: number
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  /** Resolves when the process has exited and all of its output has been delivered. Rejects if the machine is disposed first. */
  readonly exit: Promise<ExitInfo>
  write(data: Uint8Array | string): Promise<void>
  /** Close the process's stdin. */
  end(): Promise<void>
  kill(signal?: string): Promise<void>
}
export interface MachineFs {
  read(path: string): Promise<Uint8Array>
  readText(path: string): Promise<string>
  /** Creates parent directories as needed. */
  write(path: string, data: Uint8Array | string, mode?: number): Promise<void>
  list(path: string): Promise<{ name: string; type: FsStat['type'] }[]>
  /** null when the path does not exist. */
  stat(path: string): Promise<FsStat | null>
  remove(path: string, options?: { recursive?: boolean }): Promise<void>
  /** Like mkdir -p. */
  mkdir(path: string): Promise<void>
}
export interface Machine {
  /** Resolves when the frame has loaded and the handshake is done. Every method waits for it by itself. */
  readonly ready: Promise<void>
  readonly status: 'starting' | 'running' | 'unresponsive' | 'disposed'
  boot(options: BootOptions): Promise<void>
  /** Mount a read-only image at a path. `source` is a URL on the machine origin (relative URLs resolve against the frame), or the image bytes. */
  mount(at: string, source: string | ArrayBuffer): Promise<{ files: number; bytes: number }>
  spawn(argv: string[], options?: SpawnOptions): Promise<MachineProcess>
  readonly fs: MachineFs
  onOpenUrl: ((url: string) => void) | null
  dispose(): void
}

const WATCHDOG_DEFAULT_MS = 5000
const encoder = new TextEncoder()
const toBytes = (data: Uint8Array | string): Uint8Array<ArrayBuffer> => (typeof data === 'string' ? encoder.encode(data) : (data.slice() as Uint8Array<ArrayBuffer>))

interface ProcessState {
  out: ReadableStreamDefaultController<Uint8Array>
  err: ReadableStreamDefaultController<Uint8Array>
  resolve(info: ExitInfo): void
  reject(error: Error): void
}

export function createMachine(options: MachineOptions): Machine {
  const frameOrigin = new URL(options.frameUrl, location.href).origin
  const iframe = document.createElement('iframe')
  iframe.src = options.frameUrl
  // The frame needs scripts and its own origin (workers, and storage later); nothing else: no popups, no top navigation.
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.title = 'Beamhop machine'
  iframe.style.cssText = 'display:none;width:0;height:0;border:0'

  let status: Machine['status'] = 'starting'
  let channel: Channel | null = null
  let lastBeat = performance.now()
  let lastTick = performance.now()
  const processes = new Map<number, ProcessState>()
  /** Events for a pid can arrive before spawn()'s own continuation has registered it; they wait here. */
  const early = new Map<number, MachineEvent[]>()
  const sockets = new Map<number, Promise<NetSocket | null>>()
  const httpBodies = new Map<number, { chunks: Uint8Array[]; done(): void }>()
  const httpAborts = new Map<number, AbortController>()

  let resolveReady!: () => void
  let rejectReady!: (e: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  ready.catch(() => {})

  // ---- handshake ----
  const onWindowMessage = (ev: MessageEvent<Partial<MachineHello> | null>): void => {
    if (ev.source !== iframe.contentWindow || ev.origin !== frameOrigin || channel) return
    const hello = ev.data
    if (!hello || hello.bh !== 'machine-hello') return
    if (hello.v !== MACHINE_PROTOCOL) {
      rejectReady(new RpcError('protocol', `machine frame speaks protocol ${String(hello.v)}, this client speaks ${MACHINE_PROTOCOL}`))
      return
    }
    const { port1, port2 } = new MessageChannel()
    channel = new Channel(port1, { request: (req) => handleNetRequest(req as NetRequest), event: (event) => handleEvent(event as MachineEvent | NetEvent) })
    iframe.contentWindow!.postMessage({ bh: 'machine-init', v: MACHINE_PROTOCOL, port: port2 } satisfies MachineInit, frameOrigin, [port2])
    lastBeat = performance.now()
    const late = status === 'unresponsive' // the watchdog gave up on the handshake before the frame had loaded
    status = 'running'
    if (late) options.watchdog?.onResponsive?.()
    resolveReady()
  }
  addEventListener('message', onWindowMessage)
  options.container.appendChild(iframe)

  // ---- watchdog ----
  const timeoutMs = options.watchdog?.timeoutMs ?? WATCHDOG_DEFAULT_MS
  const tickMs = Math.max(50, Math.min(1000, timeoutMs / 4))
  const watchdog = setInterval(() => {
    const now = performance.now()
    // If this page itself was suspended (background tab, device sleep), its own ticks stopped too: start counting afresh.
    if (now - lastTick > tickMs * 4) lastBeat = now
    lastTick = now
    if ((status === 'running' || status === 'starting') && now - lastBeat > timeoutMs) {
      const phase = status === 'starting' ? 'handshake' : 'running'
      status = 'unresponsive'
      options.watchdog?.onUnresponsive?.({ silentMs: Math.round(now - lastBeat), phase })
    }
  }, tickMs)

  // ---- events from the machine ----
  function handleEvent(ev: MachineEvent | NetEvent): void {
    switch (ev.ev) {
      case 'heartbeat':
        lastBeat = performance.now()
        if (status === 'unresponsive') {
          status = 'running'
          options.watchdog?.onResponsive?.()
        }
        return
      case 'stdout':
      case 'stderr':
      case 'exit': {
        const p = processes.get(ev.pid)
        if (!p) {
          const list = early.get(ev.pid)
          if (list) list.push(ev)
          else early.set(ev.pid, [ev])
          return
        }
        return deliver(p, ev)
      }
      case 'open-url':
        return (machine.onOpenUrl ?? undefined)?.(ev.url)
      case 'log':
        return options.onLog?.(ev.level, ev.message)
      case 'sock.data':
        return void sockets.get(ev.sid)?.then((s) => s?.write(ev.data))
      case 'sock.end':
        return void sockets.get(ev.sid)?.then((s) => s?.end())
      case 'sock.close': {
        const s = sockets.get(ev.sid)
        sockets.delete(ev.sid)
        return void s?.then((sock) => sock?.close())
      }
      case 'http.body':
        return void httpBodies.get(ev.rid)?.chunks.push(ev.data)
      case 'http.end':
        return httpBodies.get(ev.rid)?.done()
      case 'http.abort':
        return httpAborts.get(ev.rid)?.abort()
    }
  }
  function deliver(p: ProcessState, ev: Extract<MachineEvent, { pid: number }>): void {
    if (ev.ev === 'stdout') p.out.enqueue(ev.data)
    else if (ev.ev === 'stderr') p.err.enqueue(ev.data)
    else {
      processes.delete(ev.pid)
      p.out.close()
      p.err.close()
      p.resolve(ev.signal ? { code: ev.code, signal: ev.signal } : { code: ev.code })
    }
  }

  // ---- the machine's network requests ----
  async function handleNetRequest(req: NetRequest): Promise<NetResults[NetRequest['op']]> {
    const failure = (e: unknown): { ok: false; code: string; message: string } => {
      const err = e as { code?: unknown; message?: unknown }
      return { ok: false, code: typeof err?.code === 'string' ? err.code : 'connect', message: String(err?.message ?? e) }
    }
    if (req.op === 'sock.open') {
      const { sid } = req
      const event = (ev: NetEvent, transfer?: Transferable[]): void => channel?.event(ev, transfer)
      const opening = options.net.openSocket(
        { host: req.host, port: req.port },
        {
          data(chunk) {
            const data = compact(chunk)
            event({ ev: 'sock.data', sid, data }, [data.buffer])
          },
          end: () => event({ ev: 'sock.end', sid }),
          close(error) {
            if (!sockets.delete(sid)) return
            event({ ev: 'sock.close', sid, ...(error ? { error } : {}) })
          },
        },
      )
      // Registered before the answer goes out, so data the machine sends right after "ok" finds the socket.
      sockets.set(sid, opening.then((s) => s, () => null))
      try {
        await opening
        return { ok: true }
      } catch (e) {
        sockets.delete(sid)
        return failure(e)
      }
    }
    const { rid } = req
    const abort = new AbortController()
    httpAborts.set(rid, abort)
    try {
      let body: Uint8Array | null = null
      if (req.hasBody) {
        const chunks: Uint8Array[] = []
        await new Promise<void>((done) => {
          httpBodies.set(rid, { chunks, done })
          abort.signal.addEventListener('abort', () => done(), { once: true })
        })
        httpBodies.delete(rid)
        if (abort.signal.aborted) throw new NetFailure('aborted', 'the machine aborted the request')
        body = chunks.length === 1 ? chunks[0] : new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer())
      }
      const res = await options.net.openHttp({ url: req.url, method: req.method, headers: req.headers, body, signal: abort.signal })
      // The response body follows the answer as events; start pumping only after the answer has been posted.
      queueMicrotask(() => void pumpHttpBody(rid, res.body, abort))
      return { ok: true, status: res.status, headers: res.headers }
    } catch (e) {
      httpAborts.delete(rid)
      httpBodies.delete(rid)
      return failure(e)
    }
  }
  async function pumpHttpBody(rid: number, body: ReadableStream<Uint8Array> | null, abort: AbortController): Promise<void> {
    try {
      if (body) {
        const reader = body.getReader()
        abort.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}), { once: true })
        for (;;) {
          const { done, value } = await reader.read()
          if (done || abort.signal.aborted) break
          const data = compact(value)
          channel?.event({ ev: 'http.body', rid, data }, [data.buffer])
        }
      }
      if (!abort.signal.aborted) channel?.event({ ev: 'http.end', rid })
    } catch (e) {
      if (!abort.signal.aborted) channel?.event({ ev: 'http.abort', rid, error: e instanceof Error ? e.message : String(e) })
    } finally {
      httpAborts.delete(rid)
    }
  }

  // ---- requests to the machine ----
  async function call<K extends AppRequest['op']>(req: Extract<AppRequest, { op: K }>, transfer: Transferable[] = []): Promise<AppResults[K]> {
    if (status === 'disposed') throw new RpcError('disposed', 'the machine has been disposed')
    await ready
    if (!channel) throw new RpcError('disposed', 'the machine has been disposed')
    return channel.request<AppResults[K]>(req, transfer)
  }

  const machine: Machine = {
    ready,
    get status() {
      return status
    },
    onOpenUrl: options.onOpenUrl ?? null,
    async boot(boot) {
      await call({ op: 'boot', workspaceId: boot.workspaceId, env: boot.env, net: boot.net })
    },
    mount(at, source) {
      return call({ op: 'mount', at, source }, typeof source === 'string' ? [] : [source])
    },
    async spawn(argv, spawnOptions = {}) {
      const { pid } = await call({ op: 'spawn', argv, env: spawnOptions.env, cwd: spawnOptions.cwd, stdin: spawnOptions.stdin })
      let out!: ReadableStreamDefaultController<Uint8Array>
      let err!: ReadableStreamDefaultController<Uint8Array>
      const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (out = c) })
      const stderr = new ReadableStream<Uint8Array>({ start: (c) => void (err = c) })
      const exit = new Promise<ExitInfo>((resolve, reject) => processes.set(pid, { out, err, resolve, reject }))
      exit.catch(() => {})
      const state = processes.get(pid)!
      for (const ev of early.get(pid) ?? []) deliver(state, ev as Extract<MachineEvent, { pid: number }>)
      early.delete(pid)
      return {
        pid,
        stdout,
        stderr,
        exit,
        async write(data) {
          const bytes = toBytes(data)
          await call({ op: 'stdin', pid, data: bytes }, [bytes.buffer])
        },
        end: () => call({ op: 'stdin', pid, eof: true }),
        kill: (signal) => call({ op: 'kill', pid, signal }),
      }
    },
    fs: {
      read: (path) => call({ op: 'fs.read', path }),
      readText: async (path) => new TextDecoder().decode(await call({ op: 'fs.read', path })),
      async write(path, data, mode) {
        const bytes: Bytes = toBytes(data)
        await call({ op: 'fs.write', path, data: bytes, mode }, [bytes.buffer as ArrayBuffer])
      },
      list: (path) => call({ op: 'fs.list', path }),
      stat: (path) => call({ op: 'fs.stat', path }),
      remove: (path, removeOptions) => call({ op: 'fs.remove', path, recursive: removeOptions?.recursive }),
      mkdir: (path) => call({ op: 'fs.mkdir', path }),
    },
    dispose() {
      if (status === 'disposed') return
      status = 'disposed'
      clearInterval(watchdog)
      removeEventListener('message', onWindowMessage)
      const gone = new RpcError('disposed', 'the machine has been disposed')
      rejectReady(gone)
      channel?.close(gone)
      channel = null
      for (const p of processes.values()) {
        p.out.error(gone)
        p.err.error(gone)
        p.reject(gone)
      }
      processes.clear()
      for (const s of sockets.values()) void s.then((sock) => sock?.close())
      sockets.clear()
      for (const a of httpAborts.values()) a.abort()
      httpAborts.clear()
      iframe.remove()
    },
  }
  return machine
}
