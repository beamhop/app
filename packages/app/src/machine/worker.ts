/// <reference lib="webworker" />
// The machine: a Linux kernel (unkernel, compiled to WebAssembly) booted in this dedicated worker,
// so its work never blocks the page. The app drives it through protocol.ts; guest programs see
// only Linux, never this worker's JavaScript, the app's storage or its keys.
import { bundledBoot, createKernel, loadKernelModule, openDataDisk, wispBackend, type KernelHandle, type Pty, type Subprocess } from 'unkernel/web'
import { beamhopProxyBackend } from './net'
import type { BootRequest, OkReply, Reply, Request, WorkerEvent } from './protocol'

declare const self: DedicatedWorkerGlobalScope

let vm: KernelHandle | null = null
let booting: Promise<unknown> | null = null
const ptys = new Map<number, Pty>()
const procs = new Map<number, Subprocess>()
let nextId = 1

const emit = (e: WorkerEvent, transfer: Transferable[] = []) => self.postMessage(e, transfer)
const enc = new TextEncoder()

async function boot(b: BootRequest) {
  emit({ event: 'progress', stage: 'Downloading the kernel' })
  const kernel = await loadKernelModule(b.kernelUrl, { what: 'kernel' } as any)
  const disks = []
  // Installing a harness writes hundreds of megabytes. When the browser can't store that, a full
  // disk turns read-only mid-install, so keep the files in memory instead and say why.
  const MIN_FREE = 3 * 1024 ** 3
  let persist = b.persist && typeof indexedDB !== 'undefined'
  if (persist) {
    const est = await navigator.storage?.estimate?.().catch(() => undefined)
    if (est?.quota !== undefined && est.quota - (est.usage ?? 0) < MIN_FREE) {
      persist = false
      const gb = ((est.quota - (est.usage ?? 0)) / 1024 ** 3).toFixed(1)
      emit({ event: 'storage-error', message: `only ${gb} GB of browser storage is available, so the machine’s files are kept in memory this time` })
    }
  }
  if (persist) {
    emit({ event: 'progress', stage: 'Opening the disk' })
    try {
      disks.push(
        await openDataDisk({
          name: 'beamhop-machine',
          template: bundledBoot(kernel).datadisk!,
          log: (m: string) => emit({ event: 'log', line: m }),
          onError: (e: any) => emit({ event: 'storage-error', message: `${e?.name ?? 'Error'}: ${e?.message || String(e)}` }),
        } as any),
      )
    } catch (e) {
      emit({ event: 'log', line: `persistent disk unavailable: ${(e as Error).message}` })
      disks.push(await openDataDisk({ name: 'beamhop-machine', template: bundledBoot(kernel).datadisk!, mode: 'snapshot', snapshotLimit: 0, log: () => {} }))
    }
  }
  const net =
    b.net.kind === 'wisp' ? wispBackend([b.net.url]) : b.net.kind === 'beamhop' ? beamhopProxyBackend(b.net.url, b.net.token) : undefined
  emit({ event: 'progress', stage: 'Starting Linux' })
  const k = await createKernel({
    kernel,
    distro: b.distroUrl,
    memoryMiB: b.memoryMiB,
    disks,
    ...(net ? { net } : {}),
    onProgress: (p: any) => p?.stage && emit({ event: 'progress', stage: String(p.stage) }),
  } as any)
  k.exited.then((r) => {
    vm = null
    emit({ event: 'exited', reason: r.reason ?? r.kind ?? 'stopped' })
  })
  await k.exec('true')
  if (net) {
    // DHCP finishes shortly after boot; programs started before that can't resolve names.
    emit({ event: 'progress', stage: 'Connecting to the network' })
    await k.exec('sh', ['-c', "for i in $(seq 100); do grep -q '^eth0[[:space:]]*00000000' /proc/net/route && exit 0; sleep 0.1; done; exit 1"], { user: 'root' })
  }
  if (b.extraCa?.trim()) {
    // Trusted by OpenSSL (curl, apk, git) and by Node (npm and the Node harnesses).
    await k.exec('sh', ['-c', 'mkdir -p /usr/local/share/ca-certificates /etc/ssl/certs && cat > /usr/local/share/ca-certificates/beamhop-extra.crt && cat /usr/local/share/ca-certificates/beamhop-extra.crt >> /etc/ssl/certs/ca-certificates.crt'], {
      input: b.extraCa,
      user: 'root',
    })
  }
  vm = k
  emit({ event: 'progress', stage: 'Ready' })
}

async function handle(req: Request): Promise<OkReply> {
  if (req.op === 'boot') {
    if (!vm) await (booting ??= boot(req.boot).finally(() => (booting = null)))
    return { ok: true }
  }
  if (!vm) throw new Error('The machine is not running')
  switch (req.op) {
    case 'exec': {
      const r = await vm.exec('sh', ['-lc', req.cmd], { user: req.user ?? 'root', env: req.env })
      return { ok: true, result: { stdout: String(r.stdout), stderr: String(r.stderr), code: r.exitCode } }
    }
    case 'spawn': {
      const p = await vm.spawn(req.cmd, req.args, { pty: false, user: req.user ?? 'root', env: req.env, cwd: req.cwd } as any)
      const id = nextId++
      procs.set(id, p)
      return { ok: true, result: { proc: id }, stdin: p.stdin as WritableStream<Uint8Array>, stdout: p.stdout, stderr: p.stderr }
    }
    case 'pty': {
      const p = await vm.spawn(undefined, undefined, { cols: req.cols, rows: req.rows, user: req.user ?? 'root', env: req.env })
      const id = nextId++
      ptys.set(id, p)
      ;(async () => {
        const r = p.output.getReader()
        for (;;) {
          const { value, done } = await r.read()
          if (done) break
          emit({ event: 'pty-data', pty: id, data: value }, [value.buffer])
        }
      })().catch(() => {})
      p.ended.then((e) => {
        ptys.delete(id)
        emit({ event: 'pty-exit', pty: id, code: e.type === 'exit' ? e.code : null })
      })
      return { ok: true, result: { pty: id } }
    }
    case 'pty-write':
      await ptys.get(req.pty)?.write(enc.encode(req.data))
      return { ok: true }
    case 'pty-resize':
      ptys.get(req.pty)?.resize(req.cols, req.rows)
      return { ok: true }
    case 'pty-close':
      await ptys.get(req.pty)?.close()
      return { ok: true }
    case 'kill':
      procs.get(req.proc)?.kill()
      return { ok: true }
    case 'sync':
      await vm.sync()
      return { ok: true }
    case 'stop':
      await vm.sync().catch(() => false)
      await vm.stop()
      vm = null
      return { ok: true }
  }
}

self.onmessage = async ({ data }: MessageEvent<Request & { id: number }>) => {
  try {
    const r = await handle(data)
    const transfer = [r.stdin, r.stdout, r.stderr].filter(Boolean) as Transferable[]
    self.postMessage({ ...r, id: data.id }, transfer)
  } catch (e) {
    self.postMessage({ id: data.id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies Reply)
  }
}
