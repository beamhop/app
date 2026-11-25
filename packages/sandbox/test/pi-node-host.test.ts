// pi, unmodified, on the kernel under Node: the same machine code as in the browser, driven directly.
// Needs the pi image (a build output): `npm run build:image -- pi`. Skipped when it is not there.
// The model is the scripted local mock; the broker below can reach nothing else.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getHarness } from '../src/harness/index.js'
import { decodeImage, type DecodedImage } from '../src/image/format.js'
import { NetError, type NetBroker } from '../src/kernel/net.js'
import { FILE_NAME, FILE_TEXT, FINAL_PREFIX, startMock } from './e2e/mock-model.mjs'
import { bytes, testMachine, text } from './helpers.js'

const imagesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../images')
const manifestFile = path.join(imagesDir, 'images.json')
const manifest: Record<string, { file: string }> = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {}
const imageFile = manifest.pi && path.join(imagesDir, manifest.pi.file)

/** A broker that reaches exactly one local port. */
function localBroker(port: number, counts: { sockets: number; http: number; denied: string[] }): NetBroker {
  const allowed = (host: string, p: number): boolean => (host === '127.0.0.1' || host === 'localhost') && p === port
  return {
    openSocket(host, p, events) {
      if (!allowed(host, p)) {
        counts.denied.push(`${host}:${p}`)
        const opened = Promise.reject(new NetError('policy', 'destination not allowed'))
        opened.catch(() => {})
        return { opened, write() {}, end() {}, close() {} }
      }
      counts.sockets++
      const sock = net.connect(p, '127.0.0.1')
      sock.on('data', (d) => events.data(new Uint8Array(d)))
      sock.on('end', () => events.end())
      sock.on('close', () => events.close())
      sock.on('error', () => {})
      return { opened: new Promise((res, rej) => sock.once('connect', () => res()).once('error', (e) => rej(new NetError('connect', e.message)))), write: (c) => void sock.write(c), end: () => void sock.end(), close: () => void sock.destroy() }
    },
    openHttp(request, events) {
      const url = new URL(request.url)
      const controller = new AbortController()
      if (!allowed(url.hostname, Number(url.port || 80))) {
        counts.denied.push(url.host)
        const response = Promise.reject(new NetError('policy', 'destination not allowed'))
        response.catch(() => {})
        return { response, abort() {} }
      }
      counts.http++
      const response = fetch(request.url, { method: request.method, headers: request.headers, body: request.body as BodyInit | null, signal: controller.signal }).then((res) => {
        void (async () => {
          try {
            for await (const chunk of res.body ?? []) events.body(chunk as Uint8Array)
            events.end()
          } catch (e) {
            events.abort(String(e))
          }
        })()
        return { status: res.status, headers: [...res.headers] as [string, string][] }
      })
      return { response, abort: () => controller.abort() }
    },
  }
}

describe.skipIf(!imageFile)('pi on the kernel under Node', () => {
  let image: DecodedImage
  let mock: Awaited<ReturnType<typeof startMock>>
  beforeAll(async () => {
    image = await decodeImage(fs.readFileSync(imageFile!))
    mock = await startMock({ delayMs: 1 })
  })
  afterAll(() => mock.close())

  for (const netMode of ['tunnel', 'http'] as const) {
    it(`completes a turn (write a file, read it back with bash, final answer) in ${netMode} mode`, async () => {
      mock.log.length = 0
      const counts = { sockets: 0, http: 0, denied: [] as string[] }
      const logs: string[] = []
      const m = testMachine({ net: localBroker(mock.port, counts), netMode, logs })
      const pi = getHarness('pi')
      m.mountImage(pi.mountAt, image)
      const runSpec = pi.headless({ prompt: `Write ${FILE_NAME} then read it back with bash.`, endpoint: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'mock-key', model: 'mock-model' } })
      for (const [file, content] of Object.entries(runSpec.files)) m.kernel.vfs.writeFileDeep(file, bytes(content))
      const proc = m.kernel.spawn({ argv: runSpec.argv, env: { ...m.kernel.env, ...runSpec.env }, cwd: '/work', stdin: runSpec.stdin })
      const [stdout, stderr, status] = await Promise.all([proc.stdout.readAll(), proc.stderr.readAll(), proc.exited])
      expect(text(stderr)).toBe('')
      expect(status).toEqual({ code: 0 })
      expect(text(m.kernel.vfs.readFile('/work/' + FILE_NAME))).toBe(FILE_TEXT)
      expect(text(stdout)).toContain(FINAL_PREFIX + 'hello from the universal sandbox')
      expect(text(stdout)).toContain('lines=1')
      expect(mock.log.filter((e) => e.kind === 'openai').map((e) => e.step)).toEqual([0, 1, 2])
      expect(counts.denied).toEqual([])
      if (netMode === 'tunnel') expect(counts).toMatchObject({ http: 0 })
      else expect(counts).toMatchObject({ sockets: 0, http: 3 })
    }, 60_000)
  }
})
