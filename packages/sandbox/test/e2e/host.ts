// The e2e host page. It stands in for the Beamhop app: it lives on a different origin than the machine frame,
// and it touches the machine only through the public client (src/client.ts), the protocol types and the harness
// registry. Its `net` is implemented against the test proxy, per packages/proxy/PROTOCOL.md.
import { createMachine, getHarness, type Machine, type MachineNet, type MachineProcess, NetFailure } from '../../src/index.js'

export interface E2eConfig {
  frameUrl: string
  proxyUrl: string
  proxyToken: string
  mockUrl: string
  images: Record<string, string>
  /** Path of each harness's API on the mock. */
  apiBase: Record<string, string>
  prompt: string
}

function proxyNet(cfg: E2eConfig): MachineNet {
  const b64url = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const unb64url = (s: string): string => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))
  return {
    openSocket({ host, port }, events) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${cfg.proxyUrl.replace(/^http/, 'ws')}/v1/tcp?host=${encodeURIComponent(host)}&port=${port}`, ['bh1', 'bh1.' + cfg.proxyToken])
        ws.binaryType = 'arraybuffer'
        let open = false
        ws.onmessage = (ev) => {
          if (typeof ev.data !== 'string') return events.data(new Uint8Array(ev.data as ArrayBuffer))
          const msg = JSON.parse(ev.data) as { ok?: boolean; end?: boolean; code?: string; message?: string }
          if (msg.end) return events.end()
          if (msg.ok === false) return reject(new NetFailure(msg.code ?? 'connect', msg.message ?? 'refused'))
          open = true
          resolve({ write: (chunk) => ws.send(chunk as Uint8Array<ArrayBuffer>), end: () => ws.send(JSON.stringify({ end: true })), close: () => ws.close() })
        }
        ws.onerror = () => !open && reject(new NetFailure('connect', 'tunnel WebSocket failed'))
        ws.onclose = () => (open ? events.close() : reject(new NetFailure('connect', 'tunnel closed before it opened')))
      })
    },
    async openHttp({ url, method, headers, body, signal }) {
      const res = await fetch(`${cfg.proxyUrl}/v1/http`, {
        method,
        headers: { 'x-bh-url': url, 'x-bh-token': cfg.proxyToken, 'x-bh-headers': b64url(JSON.stringify(headers)) },
        body: method === 'GET' || method === 'HEAD' ? undefined : (body as Uint8Array<ArrayBuffer> | null),
        signal,
        cache: 'no-store',
      })
      const error = res.headers.get('x-bh-error')
      if (error) throw new NetFailure(error, ((await res.json()) as { message: string }).message)
      return { status: Number(res.headers.get('x-bh-status') ?? res.status), headers: JSON.parse(unb64url(res.headers.get('x-bh-resp-headers') ?? 'W10')) as [string, string][], body: res.body }
    },
  }
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let out = ''
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out + decoder.decode()
    out += decoder.decode(value, { stream: true })
  }
}
async function finish(proc: MachineProcess): Promise<{ code: number; signal?: string; stdout: string; stderr: string }> {
  const [stdout, stderr, exit] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exit])
  return { ...exit, stdout, stderr }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function open(cfg: E2eConfig, extra: { watchdogMs?: number; logs?: string[]; opened?: string[]; unresponsive?: object[] } = {}): Machine {
  const created = performance.now()
  return createMachine({
    frameUrl: cfg.frameUrl,
    container: document.getElementById('machine')!,
    net: proxyNet(cfg),
    onOpenUrl: (url) => extra.opened?.push(url),
    onLog: (level, message) => extra.logs?.push(`${level}: ${message}`),
    watchdog: { timeoutMs: extra.watchdogMs, onUnresponsive: (info) => extra.unresponsive?.push({ ...info, atMs: performance.now() - created }) },
  })
}

const scenarios = {
  /** A full harness turn, plus probes of what the worker can and cannot do. */
  async turn(cfg: E2eConfig, harnessName: string, netMode: 'tunnel' | 'http') {
    const logs: string[] = []
    const t0 = performance.now()
    const machine = open(cfg, { logs })
    await machine.ready
    const tReady = performance.now() - t0
    await machine.boot({ workspaceId: 'e2e', net: netMode })
    const harness = getHarness(harnessName)
    const mounted = await machine.mount(harness.mountAt, cfg.images[harnessName])
    const tMounted = performance.now() - t0

    // Cold start: first output of the harness in a fresh machine.
    const version = await machine.spawn([harness.command, '--version'], { env: harness.env, stdin: 'none' })
    const versionReader = version.stdout.getReader()
    const firstChunk = await versionReader.read()
    const tFirstOutput = performance.now() - t0
    versionReader.releaseLock()
    const versionResult = await finish(version)
    versionResult.stdout = new TextDecoder().decode(firstChunk.value) + versionResult.stdout

    const run = harness.headless({ prompt: cfg.prompt, endpoint: { baseUrl: cfg.mockUrl + cfg.apiBase[harnessName], apiKey: 'mock-key', model: 'mock-model' } })
    for (const [path, content] of Object.entries(run.files)) await machine.fs.write(path, content)
    const tTurn = performance.now()
    const proc = await machine.spawn(run.argv, { env: run.env, cwd: '/work', stdin: run.stdin })
    const turn = await finish(proc)
    const turnMs = performance.now() - tTurn
    const file = await machine.fs.readText('/work/hello.txt').catch((e: Error) => 'ERROR ' + e.message)
    const stat = await machine.fs.stat('/work/hello.txt')
    const listing = await machine.fs.list('/work')

    // What the worker's realm looks like, and whether it can reach the network on its own (it must not).
    const probe = await finish(
      await machine.spawn(
        ['node', '-e', `
          const real = (0, eval)('this')
          const violations = []
          real.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective + ' ' + e.blockedURI))
          const direct = async (fn) => { try { await fn(); return 'reached' } catch (e) { return 'blocked: ' + (e && e.name) } }
          Promise.all([
            direct(() => real.fetch(${JSON.stringify(cfg.mockUrl + '/v1/models')})),
            fetch('http://example.com/').then((r) => 'reached ' + r.status, (e) => 'refused: ' + ((e.cause && e.cause.message) || e.message)),
          ]).then(([directFetch, outside]) => console.log(JSON.stringify({
            crossOriginIsolated: real.crossOriginIsolated, sharedArrayBuffer: typeof real.SharedArrayBuffer, workerScope: typeof real.WorkerGlobalScope,
            directFetch, violations, outside, guestSeesSelf: typeof self, browserOnly: [/native code/.test(String(real.WebSocket)), typeof real.XMLHttpRequest, typeof real.indexedDB].join(), origin: real.location.origin,
          })))
        `],
        { stdin: 'none' },
      ),
    )
    machine.dispose()
    return { harness: harnessName, netMode, mounted, timings: { readyMs: tReady, mountedMs: tMounted, coldFirstOutputMs: tFirstOutput, turnMs }, version: versionResult, turn, file, stat, listing, probe, logs, pageIsolated: crossOriginIsolated, pageSab: typeof SharedArrayBuffer }
  },

  /** stdin, kill, open-url, and that the machine stays usable afterwards. */
  async processes(cfg: E2eConfig) {
    const opened: string[] = []
    const machine = open(cfg, { opened })
    await machine.boot({ workspaceId: 'e2e', net: 'none' })
    const echo = await machine.spawn(['node', '-e', 'process.stdin.on("data", (d) => process.stdout.write(String(d).toUpperCase())); process.stdin.on("end", () => process.exit(5))'])
    await echo.write('hello ')
    await echo.write(new TextEncoder().encode('machine'))
    await echo.end()
    const echoed = await finish(echo)

    const ticker = await machine.spawn(['node', '-e', 'let n = 0; setInterval(() => console.log("tick " + n++), 20)'], { stdin: 'none' })
    const reader = ticker.stdout.getReader()
    let seen = ''
    while (!seen.includes('tick 2')) seen += new TextDecoder().decode((await reader.read()).value)
    const tKill = performance.now()
    await ticker.kill()
    const exit = await ticker.exit
    const killMs = performance.now() - tKill
    let after = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      after += new TextDecoder().decode(value)
    }
    await sleep(150) // anything the killed process still printed would arrive (and be dropped by the client) by now
    const killUnknown = await machine.spawn(['node', '-e', '0'], { stdin: 'none' }).then((p) => p.exit.then(() => p.kill())).then(() => 'no error', (e: Error & { code?: string }) => e.code ?? e.message)

    const shell = await finish(await machine.spawn(['bash', '-c', 'echo "from $0"; xdg-open https://example.com/login; exit 3'], { stdin: 'none' }))
    const missing = await machine.spawn(['no-such-program']).then(() => 'spawned', (e: Error & { code?: string }) => `${e.code}`)
    await machine.fs.write('/work/a/b/c.txt', 'deep')
    const stillWorks = await machine.fs.readText('/work/a/b/c.txt')
    await machine.fs.remove('/work/a', { recursive: true })
    const removed = await machine.fs.stat('/work/a')
    machine.dispose()
    const afterDispose = await machine.fs.stat('/').then(() => 'answered', (e: Error & { code?: string }) => e.code)
    return { echoed, exit, killMs, ticksAfterKill: after.split('\n').filter(Boolean).length, killUnknown, shell, opened, missing, stillWorks, removed, afterDispose }
  },

  /** A node script that never yields freezes the worker; the client's watchdog must say so. */
  async frozen(cfg: E2eConfig) {
    const unresponsive: { silentMs?: number; phase?: string; atMs?: number }[] = []
    const machine = open(cfg, { watchdogMs: 1000, unresponsive })
    await machine.boot({ workspaceId: 'e2e', net: 'none' })
    const before = machine.status
    const bootedAtMs = unresponsive.length
    const t0 = performance.now()
    await machine.spawn(['node', '-e', 'while (true) {}'], { stdin: 'none' })
    const spawnedMs = performance.now() - t0
    const answered = await Promise.race([machine.fs.stat('/work').then(() => true), sleep(2500).then(() => false)])
    const during = machine.status
    machine.dispose()
    // The app's reaction: a fresh machine.
    const t1 = performance.now()
    const next = open(cfg)
    await next.boot({ workspaceId: 'e2e', net: 'none' })
    const again = await finish(await next.spawn(['node', '-p', '6 * 7'], { stdin: 'none' }))
    const restartMs = performance.now() - t1
    next.dispose()
    return { before, during, unresponsive, answeredWhileFrozen: answered, spawnedMs, falseAlarmsBeforeFreeze: bootedAtMs, again, restartMs }
  },

  /** ES modules written at run time have no precompiled form: the worker loads the transformer and runs them. */
  async esm(cfg: E2eConfig) {
    const logs: string[] = []
    const machine = open(cfg, { logs })
    await machine.boot({ workspaceId: 'e2e', net: 'none' })
    await machine.fs.write('/work/counter.mjs', 'export let count = 0\nexport function inc() { count++ }\nexport default class Box { constructor(v) { this.v = v } }\n')
    await machine.fs.write('/work/main.mjs', [
      "import Box, { count, inc } from './counter.mjs'",
      "import { readFileSync } from 'node:fs'",
      "import * as path from 'node:path'",
      'inc(); inc()',
      "const lazy = await import('./counter.mjs')",
      "const data = await Promise.resolve(readFileSync(new URL('./counter.mjs', import.meta.url), 'utf8').length)",
      "console.log(JSON.stringify({ count, same: lazy.count === count, box: new Box(7).v, data, file: path.basename(import.meta.filename), isolated: globalThis.crossOriginIsolated }))",
    ].join('\n'))
    const counterBytes = (await machine.fs.read('/work/counter.mjs')).length
    const first = await finish(await machine.spawn(['node', 'main.mjs'], { cwd: '/work', stdin: 'none' }))
    // A big module, to measure the transformer: ~1 MB of generated source.
    const big = Array.from({ length: 12000 }, (_, i) => `export function f${i}(a, b) { return a * ${i} + b - (a % ${i + 1}) }`).join('\n') + '\nexport const total = 12000\n'
    await machine.fs.write('/work/big.mjs', big)
    await machine.fs.write('/work/usebig.mjs', "import { f7, total } from './big.mjs'\nconsole.log(f7(3, 4), total)")
    const second = await finish(await machine.spawn(['node', 'usebig.mjs'], { cwd: '/work', stdin: 'none' }))
    const viaShell = await finish(await machine.spawn(['bash', '-c', 'cd /work && node main.mjs | wc -l'], { stdin: 'none' }))
    await sleep(50)
    machine.dispose()
    return { first, second, counterBytes, bigBytes: big.length, viaShell, logs }
  },
}

Object.assign(window, { e2e: scenarios })
declare global {
  interface Window {
    e2e: typeof scenarios
  }
}
