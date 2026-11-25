// End-to-end test: a host page on http://localhost embeds the built machine frame from http://127.0.0.1 (a
// different origin and a different site), drives it through the public client only, and runs unmodified pi
// against a scripted local model. Usage: node test/e2e/run.mjs [--repeat N] [--headed]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { FILE_NAME, FILE_TEXT, FINAL_PREFIX, startMock } from './mock-model.mjs'
import { startTestProxy } from './test-proxy.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkg = path.resolve(here, '../..')
const args = process.argv.slice(2)
const repeat = Number(args[args.indexOf('--repeat') + 1]) || 1

// ---- build outputs the test needs ----
execFileSync('node', ['scripts/build.mjs'], { cwd: pkg, stdio: 'inherit' })
const manifestFile = path.join(pkg, 'images/images.json')
const haveImage = () => fs.existsSync(manifestFile) && JSON.parse(fs.readFileSync(manifestFile, 'utf8')).pi
if (!haveImage()) {
  console.error('[e2e] no pi image yet: building it (npm install of the pinned pi release, then packing)')
  execFileSync('node', ['scripts/build-image.mjs', 'pi'], { cwd: pkg, stdio: 'inherit' })
}
const images = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
// pi is the harness this test must pass with. gemini is exercised too when its image has been built
// (`npm run build:image -- gemini`); it is larger and not required.
const HARNESSES = [
  { name: 'pi', apiBase: '/v1', kind: 'openai', strict: true },
  { name: 'gemini', apiBase: '', kind: 'gemini', strict: false },
].filter((h) => images[h.name] && fs.existsSync(path.join(pkg, 'images', images[h.name].file)))
const hostBundle = (await build({ entryPoints: [path.join(here, 'host.ts')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, logLevel: 'warning' })).outputFiles[0].contents

// ---- servers ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.bhi': 'application/octet-stream' }
const listen = (handler, host) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, host, () => resolve(s)) })

const appServer = await listen((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  if (p === '/' || p === '/host.html') return res.writeHead(200, { 'content-type': TYPES['.html'] }).end(fs.readFileSync(path.join(here, 'host.html')))
  if (p === '/host.js') return res.writeHead(200, { 'content-type': TYPES['.js'] }).end(hostBundle)
  res.writeHead(404).end()
}, 'localhost')
const appOrigin = `http://localhost:${appServer.address().port}`

// The machine origin: static files, the documented CSP on every response, and no cross-origin isolation headers.
const CSP = `default-src 'none'; script-src 'self' 'unsafe-eval'; worker-src 'self'; connect-src 'self'; frame-ancestors ${appOrigin}; base-uri 'none'; form-action 'none'`
const machineServer = await listen((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const file = p.startsWith('/images/') ? path.join(pkg, 'images', path.basename(p)) : path.join(pkg, 'dist/site', path.basename(p))
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404, { 'content-security-policy': CSP }).end()
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'cache-control': p.startsWith('/images/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'content-length': fs.statSync(file).size,
  })
  fs.createReadStream(file).pipe(res)
}, '127.0.0.1')
const machineOrigin = `http://127.0.0.1:${machineServer.address().port}`

const mock = await startMock({ delayMs: 15 })
if (process.env.E2E_DEBUG) mock.server.on('clientError', (err) => console.error('[mock] clientError', err.code, err.message, JSON.stringify(String(err.rawPacket ?? '').slice(0, 700))))
const proxy = await startTestProxy({ allow: [`127.0.0.1:${mock.port}`] })
const config = {
  frameUrl: `${machineOrigin}/machine.html`,
  proxyUrl: `http://127.0.0.1:${proxy.port}`,
  proxyToken: proxy.token,
  mockUrl: `http://127.0.0.1:${mock.port}`,
  images: Object.fromEntries(HARNESSES.map((h) => [h.name, `images/${images[h.name].file}`])),
  apiBase: Object.fromEntries(HARNESSES.map((h) => [h.name, h.apiBase])),
  prompt: `Write ${FILE_NAME} then read it back with bash.`,
}

// ---- browser ----
const browser = await chromium.launch({ headless: !args.includes('--headed') })
const failures = []
const SCENARIO_TIMEOUT_MS = 60_000
const measurements = []

async function scenario(name, fn) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const pageErrors = []
  const frameHeaders = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && pageErrors.push('console: ' + m.text()))
  page.on('response', (r) => r.url().startsWith(machineOrigin) && frameHeaders.push({ url: r.url(), csp: r.headers()['content-security-policy'], coop: r.headers()['cross-origin-opener-policy'], coep: r.headers()['cross-origin-embedder-policy'] }))
  mock.log.length = 0
  proxy.reset()
  const t = Date.now()
  try {
    await page.goto(appOrigin + '/host.html')
    await page.waitForFunction(() => 'e2e' in window)
    await Promise.race([fn(page, { pageErrors, frameHeaders }), new Promise((_, reject) => setTimeout(() => reject(new Error(`scenario timed out after ${SCENARIO_TIMEOUT_MS} ms`)), SCENARIO_TIMEOUT_MS))])
    console.log(`  ok   ${name} (${Date.now() - t} ms)`)
  } catch (e) {
    failures.push(name)
    console.log(`  FAIL ${name}\n${String(e && e.stack || e).split('\n').map((l) => '       ' + l).join('\n')}`)
    if (pageErrors.length) console.log('       page errors:', pageErrors)
    if (mock.log.length) console.log('       mock saw:', mock.log.map((e) => `${e.method} ${e.path} step=${e.step}`).join(', '))
  } finally {
    await context.close()
  }
}

for (let round = 1; round <= repeat; round++) {
  console.log(`e2e round ${round}/${repeat}: app ${appOrigin}, machine ${machineOrigin}`)

  for (const h of HARNESSES) for (const netMode of ['tunnel', 'http']) {
    await scenario(`${h.name} completes a turn through the broker (${netMode} mode)`, async (page, { pageErrors, frameHeaders }) => {
      const r = await page.evaluate(([cfg, name, mode]) => window.e2e.turn(cfg, name, mode), [config, h.name, netMode])
      // the harness ran
      assert.match(r.version.stdout, /^\d+\.\d+\.\d+/, '--version prints a version')
      // gemini's shell wrapper uses `trap`, which the shell does not have; it reports that on stderr and carries on.
      if (h.strict) assert.equal(r.turn.stderr, '', 'nothing on stderr')
      assert.equal(r.turn.code, 0, 'exited 0: ' + r.turn.stderr.slice(0, 500))
      assert.equal(r.turn.signal, undefined)
      // the file its write tool created exists, with the expected bytes, read back over fs.read
      assert.equal(r.file, FILE_TEXT)
      assert.deepEqual({ type: r.stat.type, size: r.stat.size }, { type: 'file', size: FILE_TEXT.length })
      assert.deepEqual(r.listing, [{ name: FILE_NAME, type: 'file' }])
      // the final answer, which echoes the shell tool's output, arrived on stdout
      assert.ok(r.turn.stdout.includes(FINAL_PREFIX), 'final answer on stdout')
      assert.ok(r.turn.stdout.includes('hello from the universal sandbox'), 'the file content, read back by the shell tool, in the final answer')
      assert.ok(r.turn.stdout.includes('lines=1'), 'shell output in the final answer')
      // the mock saw the three scripted steps, and was reached only through the broker's proxy
      const calls = mock.log.filter((e) => e.kind === h.kind && (h.kind === 'openai' || e.agentRequest))
      assert.deepEqual(calls.map((e) => e.step), [0, 1, 2])
      assert.ok(calls[2].lastToolResult.includes('lines=1'))
      if (netMode === 'tunnel') {
        assert.ok(proxy.stats.tcpConnections >= 1, 'tunnel connections were made')
        assert.equal(proxy.stats.httpRequests, 0, 'no plain-mode requests in tunnel mode')
        assert.ok(mock.log.every((e) => e.via === null), 'requests reached the mock as raw TCP')
      } else {
        assert.equal(proxy.stats.tcpConnections, 0, 'no tunnel connections in http mode')
        assert.equal(proxy.stats.httpRequests, mock.log.length, 'every mock request came through the plain proxy')
        assert.ok(mock.log.every((e) => e.via === 'plain-proxy'))
      }
      // the worker: no cross-origin isolation, no SharedArrayBuffer, no network of its own
      const probe = JSON.parse(r.probe.stdout)
      assert.equal(probe.crossOriginIsolated, false)
      assert.equal(probe.sharedArrayBuffer, 'undefined')
      assert.equal(probe.workerScope, 'function', 'the probe ran in a worker')
      assert.equal(probe.guestSeesSelf, 'undefined')
      assert.equal(probe.origin, machineOrigin)
      assert.match(probe.directFetch, /^blocked/, 'CSP stops the worker fetching the mock directly')
      assert.equal(probe.browserOnly, 'false,undefined,undefined', 'the browser\'s WebSocket, XMLHttpRequest and indexedDB are not available to programs')
      // a destination outside the allow-list is refused by the test proxy, and nothing left the machine for it
      assert.match(probe.outside, /^refused/, 'non-local destination refused: ' + probe.outside)
      assert.deepEqual([...new Set(proxy.stats.denied)], ['example.com:80'])
      assert.equal(r.pageIsolated, false)
      assert.equal(r.pageSab, 'undefined')
      // the frame was served with the documented CSP and without isolation headers, and nothing violated it
      assert.ok(frameHeaders.length >= 3 && frameHeaders.every((h) => h.csp === CSP && !h.coop && !h.coep), 'CSP on every machine-origin response')
      assert.deepEqual(pageErrors.filter((e) => !/Content Security Policy|ERR_BLOCKED_BY_CSP|status of 502/.test(e)), [])
      // node-exit logs, one per Node process: `pi --version`, the turn, the probe. The turn loads the most modules.
      const exits = r.logs.filter((l) => l.includes('node-exit')).map((l) => JSON.parse(l.replace(/^.*?node-exit /, '')))
      const stats = exits.sort((a, b) => b.esm - a.esm)[0]
      assert.equal(stats.transformed, 0, 'every ES module the harness loaded came precompiled from the image')
      measurements.push({ scenario: 'turn', harness: h.name, netMode, ...r.timings, imageFiles: r.mounted.files, esmModulesEvaluated: stats.esm, moduleEvalMs: stats.evalMs, moduleEvalBytes: stats.evalBytes })
    })
  }

  await scenario('stdin, kill, open-url, spawn errors, dispose', async (page) => {
    const r = await page.evaluate((cfg) => window.e2e.processes(cfg), config)
    assert.deepEqual(r.echoed, { code: 5, stdout: 'HELLO MACHINE', stderr: '' })
    assert.deepEqual(r.exit, { code: 143, signal: 'SIGTERM' }, 'killed process reports the signal')
    assert.equal(r.ticksAfterKill, 0, 'no output after the kill was acknowledged')
    assert.equal(r.killUnknown, 'ESRCH')
    assert.deepEqual(r.shell, { code: 3, stdout: 'from bash\n', stderr: '' })
    assert.deepEqual(r.opened, ['https://example.com/login'])
    assert.equal(r.missing, 'ENOENT')
    assert.equal(r.stillWorks, 'deep')
    assert.equal(r.removed, null)
    assert.equal(r.afterDispose, 'disposed')
    measurements.push({ scenario: 'kill', killMs: r.killMs })
  })

  await scenario('a frozen worker is detected by the watchdog; a new machine works', async (page) => {
    const r = await page.evaluate((cfg) => window.e2e.frozen(cfg), config)
    assert.equal(r.before, 'running')
    assert.equal(r.answeredWhileFrozen, false, 'a frozen worker answers nothing')
    assert.equal(r.unresponsive.length, 1, 'onUnresponsive fired exactly once')
    assert.equal(r.unresponsive[0].phase, 'running')
    assert.ok(r.unresponsive[0].silentMs >= 1000 && r.unresponsive[0].silentMs < 2500, `silent for ${r.unresponsive[0].silentMs} ms`)
    assert.equal(r.during, 'unresponsive')
    assert.deepEqual(r.again, { code: 0, stdout: '42\n', stderr: '' })
    assert.equal(r.falseAlarmsBeforeFreeze, 0)
    measurements.push({ scenario: 'frozen', watchdogTimeoutMs: 1000, reportedSilentMs: r.unresponsive[0].silentMs, restartMs: r.restartMs })
  })

  await scenario('ES modules written at run time run through the in-worker transformer', async (page) => {
    const r = await page.evaluate((cfg) => window.e2e.esm(cfg), config)
    assert.equal(r.first.stderr, '')
    assert.deepEqual(JSON.parse(r.first.stdout), { count: 2, same: true, box: 7, data: r.counterBytes, file: 'main.mjs', isolated: false })
    assert.deepEqual(r.second, { code: 0, stdout: '22 12000\n', stderr: '' })
    assert.equal(r.viaShell.stdout.trim(), '1', 'bash can run node on an ES module')
    const load = r.logs.find((l) => l.includes('esm-transform loaded'))
    assert.ok(load, 'the transformer was lazy-loaded')
    assert.equal(r.logs.filter((l) => l.includes('esm-transform loaded')).length, 1, 'and only once')
    const exits = r.logs.filter((l) => l.includes('node-exit')).map((l) => JSON.parse(l.replace(/^.*?node-exit /, '')))
    assert.deepEqual(exits.map((e) => e.transformed), [2, 2, 2])
    measurements.push({ scenario: 'esm', transformLoadMs: Number(/in ([\d.]+) ms/.exec(load)[1]), smallModulesTransformMs: exits[0].transformMs, bigModuleBytes: r.bigBytes, bigModuleTransformMs: exits[1].transformMs })
  })
}

await browser.close()
await Promise.all([mock.close(), proxy.close(), new Promise((r) => appServer.close(r)), new Promise((r) => machineServer.close(r))])
const buildManifest = JSON.parse(fs.readFileSync(path.join(pkg, 'dist/build-manifest.json'), 'utf8'))
fs.mkdirSync(path.join(pkg, 'test-results'), { recursive: true })
fs.writeFileSync(path.join(pkg, 'test-results/e2e.json'), JSON.stringify({ chromium: browser.version(), measurements, bundles: { ...buildManifest.site, ...buildManifest.lib }, images: Object.fromEntries(HARNESSES.map((h) => [h.name, { file: images[h.name].file, bytes: images[h.name].bytes, payloadBytes: images[h.name].payloadBytes, files: images[h.name].files, esmPrecompiled: images[h.name].esmPrecompiled }])) }, null, 1))
console.log(JSON.stringify(measurements.map((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 10) / 10 : v])))))
if (failures.length) {
  console.error(`e2e: ${failures.length} scenario(s) failed`)
  process.exit(1)
}
console.log('e2e: all scenarios passed')
