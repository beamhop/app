// The machine's dedicated worker: the kernel, the Node layer and every process run here, on one thread.
// It serves the app's requests (protocol.ts) over the MessagePort the frame page hands in, and reaches the
// network only by asking the app (`sock.*`, `http.*`). It never opens a connection of its own, and the frame's
// CSP (connect-src 'self') would refuse one.
import type { TransformResult } from '../esm/transform.js'
import { decodeImage } from '../image/format.js'
import { type HttpExchange, NetError, type NetBroker, type SocketChannel, type SocketEvents, type HttpResponseEvents } from '../kernel/net.js'
import type { Process } from '../kernel/process.js'
import { createMachine, type Machine } from '../machine.js'
import type { AppRequest, AppResults, FsStat, MachineEvent, NetEvent, NetResults } from '../protocol.js'
import { Channel, compact, RpcError } from '../rpc.js'

declare function importScripts(...urls: string[]): void
const scope = self as unknown as { onmessage: ((ev: MessageEvent) => void) | null; location: Location; __bhEsmTransform?: (source: string, filename: string) => TransformResult }

const HEARTBEAT_MS = 250
/** Output is coalesced per process and sent at most once per task, so a chatty process cannot flood the port. */
const FLUSH_BYTES = 256 * 1024

function start(port: MessagePort): void {
  let machine: Machine | null = null
  const sockets = new Map<number, SocketEvents>()
  const exchanges = new Map<number, HttpResponseEvents>()
  let nextNetId = 1

  const channel = new Channel(port, {
    request: (req) => handle(req as AppRequest),
    event(event) {
      const ev = event as NetEvent
      switch (ev.ev) {
        case 'sock.data':
          return sockets.get(ev.sid)?.data(ev.data)
        case 'sock.end':
          return sockets.get(ev.sid)?.end()
        case 'sock.close': {
          const s = sockets.get(ev.sid)
          sockets.delete(ev.sid)
          return s?.close(ev.error)
        }
        case 'http.body':
          return exchanges.get(ev.rid)?.body(ev.data)
        case 'http.end': {
          const x = exchanges.get(ev.rid)
          exchanges.delete(ev.rid)
          return x?.end()
        }
        case 'http.abort': {
          const x = exchanges.get(ev.rid)
          exchanges.delete(ev.rid)
          return x?.abort(ev.error)
        }
      }
    },
  })
  const emit = (event: MachineEvent, transfer?: Transferable[]): void => channel.event(event, transfer)
  const log = (level: 'info' | 'warn' | 'error', message: string): void => emit({ ev: 'log', level, message })

  // Liveness. The app's watchdog treats a gap in these as a frozen machine: they stop exactly when this thread
  // is stuck in synchronous code, which is the only way a single-threaded kernel can hang.
  setInterval(() => emit({ ev: 'heartbeat', t: Date.now() }), HEARTBEAT_MS)
  emit({ ev: 'heartbeat', t: Date.now() })

  // ---- the network broker: every socket and HTTP exchange is a request to the app ----
  const broker: NetBroker = {
    openSocket(host, portNumber, events): SocketChannel {
      const sid = nextNetId++
      let open = false
      let closed = false
      const opened = channel.request<NetResults['sock.open']>({ op: 'sock.open', sid, host, port: portNumber }).then(
        (res) => {
          if (!res.ok) throw new NetError(res.code, res.message)
          if (closed) return void channel.event({ ev: 'sock.close', sid })
          open = true
          sockets.set(sid, events)
        },
        (e: Error) => {
          throw new NetError('connect', e.message)
        },
      )
      opened.catch(() => {})
      return {
        opened,
        write(chunk) {
          if (!open || closed) return
          const data = compact(chunk)
          channel.event({ ev: 'sock.data', sid, data }, [data.buffer])
        },
        end() {
          if (open && !closed) channel.event({ ev: 'sock.end', sid })
        },
        close() {
          if (closed) return
          closed = true
          sockets.delete(sid)
          if (open) channel.event({ ev: 'sock.close', sid })
        },
      }
    },
    openHttp(request, events): HttpExchange {
      const rid = nextNetId++
      let done = false
      exchanges.set(rid, {
        body: (chunk) => events.body(chunk),
        end() {
          done = true
          events.end()
        },
        abort(error) {
          done = true
          events.abort(error)
        },
      })
      const response = channel.request<NetResults['http.open']>({ op: 'http.open', rid, url: request.url, method: request.method, headers: request.headers, hasBody: request.body !== null }).then(
        (res) => {
          if (!res.ok) throw new NetError(res.code, res.message)
          return { status: res.status, headers: res.headers }
        },
        (e: Error) => {
          throw new NetError('proxy', e.message)
        },
      )
      response.catch(() => {
        done = true
        exchanges.delete(rid)
      })
      if (request.body !== null) {
        const data = compact(request.body)
        channel.event({ ev: 'http.body', rid, data }, [data.buffer])
        channel.event({ ev: 'http.end', rid })
      }
      return {
        response,
        abort() {
          if (done) return
          done = true
          exchanges.delete(rid)
          channel.event({ ev: 'http.abort', rid })
        },
      }
    },
  }

  /** The fallback ES module transformer lives in its own script, loaded synchronously the first time it is needed. */
  let transformLoadMs = 0
  const loadTransformer = (): ((source: string, filename: string) => TransformResult) => {
    if (!scope.__bhEsmTransform) {
      const t = performance.now()
      importScripts(new URL('esm-transform.js', scope.location.href).href)
      transformLoadMs = performance.now() - t
      log('info', `esm-transform loaded in ${transformLoadMs.toFixed(1)} ms`)
    }
    return scope.__bhEsmTransform!
  }

  // ---- process output ----
  function attach(proc: Process): void {
    const pending: Record<'stdout' | 'stderr', Uint8Array[]> = { stdout: [], stderr: [] }
    let bytes = 0
    let scheduled = false
    const flush = (): void => {
      scheduled = false
      for (const stream of ['stdout', 'stderr'] as const) {
        const chunks = pending[stream]
        if (chunks.length === 0) continue
        pending[stream] = []
        const data = chunks.length === 1 ? compact(chunks[0]) : concat(chunks)
        emit({ ev: stream, pid: proc.pid, data }, [data.buffer])
      }
      bytes = 0
    }
    const sink = (stream: 'stdout' | 'stderr') => (chunk: Uint8Array | null) => {
      if (!chunk) return
      pending[stream].push(chunk)
      bytes += chunk.byteLength
      if (bytes >= FLUSH_BYTES) return flush()
      if (!scheduled) {
        scheduled = true
        setTimeout(flush, 0)
      }
    }
    proc.stdout.pipeTo(sink('stdout'))
    proc.stderr.pipeTo(sink('stderr'))
    void proc.exited.then((status) => {
      flush()
      emit({ ev: 'exit', pid: proc.pid, code: status.code, ...(status.signal ? { signal: status.signal } : {}) })
    })
  }

  // ---- requests from the app ----
  const need = (): Machine => {
    if (!machine) throw new RpcError('not-booted', 'the machine has not been booted')
    return machine
  }
  const live = (pid: number): Process => {
    const proc = need().kernel.get(pid)
    if (!proc) throw new RpcError('ESRCH', `no such process: ${pid}`)
    return proc
  }

  // Kernel errors carry `code` and `message`; the channel forwards both to the app as they are.
  async function handle(req: AppRequest): Promise<AppResults[AppRequest['op']]> {
    switch (req.op) {
      case 'boot': {
        if (machine) throw new RpcError('already-booted', 'the machine is already booted')
        machine = createMachine({
          env: { BEAMHOP_WORKSPACE: req.workspaceId, ...req.env },
          net: broker,
          netMode: req.net ?? 'tunnel',
          log,
          openUrl: (url) => emit({ ev: 'open-url', url }),
          loadTransformer,
          onNodeStats: (info) => log('info', 'node-exit ' + JSON.stringify({ pid: info.pid, ...info.loader, transformLoadMs, unusual: info.usage })),
        })
        return { ok: true }
      }
      case 'mount': {
        const m = need()
        let source: ReadableStream<Uint8Array> | ArrayBuffer
        if (typeof req.source === 'string') {
          const url = new URL(req.source, scope.location.href)
          // The machine fetches from its own origin only. Anything else would be a network path around the app.
          if (url.origin !== scope.location.origin) throw new RpcError('policy', `images must come from the machine origin, not ${url.origin}`)
          const res = await fetch(url, { credentials: 'omit' })
          if (!res.ok || !res.body) throw new RpcError('ENOENT', `image fetch failed: ${url.pathname} (HTTP ${res.status})`)
          source = res.body
        } else source = req.source
        return m.mountImage(req.at, await decodeImage(source))
      }
      case 'spawn': {
        const { kernel } = need()
        const proc = kernel.spawn({ argv: req.argv, env: { ...kernel.env, ...req.env }, cwd: req.cwd, stdin: req.stdin ?? 'pipe' })
        attach(proc)
        return { pid: proc.pid }
      }
      case 'stdin': {
        const proc = live(req.pid)
        if (req.data) proc.stdin.write(req.data)
        if (req.eof) proc.stdin.end()
        return
      }
      case 'kill':
        return need().kernel.kill(req.pid, req.signal)
      case 'fs.read':
        // A copy: the stored bytes may be a view of an image, and the result is transferred to the app.
        return need().kernel.vfs.readFile(req.path).slice()
      case 'fs.write':
        return need().kernel.vfs.writeFileDeep(req.path, req.data, { mode: req.mode })
      case 'fs.list':
        return need().kernel.vfs.readdir(req.path).map((e) => ({ name: e.name, type: e.kind }))
      case 'fs.stat': {
        const st = need().kernel.vfs.tryStat(req.path, false)
        return st && ({ type: st.kind, size: st.size, mtimeMs: st.mtimeMs, mode: st.mode } satisfies FsStat)
      }
      case 'fs.remove':
        return need().kernel.vfs.rm(req.path, { recursive: req.recursive })
      case 'fs.mkdir':
        return void need().kernel.vfs.mkdir(req.path, { recursive: true })
    }
  }
}

function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

scope.onmessage = (ev: MessageEvent<{ bh?: string; port?: MessagePort } | null>) => {
  if (ev.data?.bh !== 'machine-port' || !ev.data.port) return
  scope.onmessage = null
  start(ev.data.port)
}
