// Browser end-to-end test: @beamhop/tls in a dedicated worker in headless Chromium, over a
// WebSocket to the test relay (relay.mjs), to local node:tls HTTPS servers with a throwaway CA.
//
//   npm run e2e            local servers only
//   npm run e2e:public     additionally handshake with a real public host (BH_TLS_PUBLIC=1;
//                          host via BH_TLS_PUBLIC_HOST, default example.com) using the bundled
//                          Mozilla roots. Needs direct outbound TCP from this machine.
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import { once } from 'node:events'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { startRelay } from './relay.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const out = here + '.out/'
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// --- build: worker bundle (with the Mozilla roots as a lazily loaded chunk) and the cert helper
await build({ entryPoints: { worker: here + 'worker.ts' }, bundle: true, splitting: true, format: 'esm', target: 'es2022', outdir: out, logLevel: 'warning' })
await build({ entryPoints: [here + '../test/helpers/certs.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: out + 'certs.mjs', logLevel: 'warning' })
const { issue } = await import(pathToFileURL(out + 'certs.mjs').href)

// --- throwaway PKI (in memory only)
const NAME = 'e2e.beamhop.example'
const ca = await issue({ cn: 'Beamhop E2E Root', ca: true })
const ecdsa = await issue({ cn: NAME, issuer: ca })
const rsaInt = await issue({ cn: 'Beamhop E2E RSA Intermediate', ca: true, alg: 'rsa', issuer: ca })
const rsa = await issue({ cn: NAME, issuer: rsaInt, alg: 'rsa' })

// --- local HTTPS servers
const filler = Buffer.alloc(1 << 20, 0x62)
function app(req, res) {
  const url = new URL(req.url, 'https://x')
  if (url.pathname === '/stream') {
    // no Content-Length => chunked; five chunks, 80 ms apart
    let i = 0
    res.writeHead(200, { 'content-type': 'text/plain' })
    const tick = () => {
      res.write(`part ${i}\n`)
      if (++i < 5) setTimeout(tick, 80)
      else res.end()
    }
    tick()
  } else if (url.pathname === '/bulk') {
    let left = Number(url.searchParams.get('bytes'))
    res.writeHead(200, { 'content-length': left })
    const pump = () => {
      while (left > 0) {
        const n = Math.min(left, filler.length)
        left -= n
        if (!res.write(n === filler.length ? filler : filler.subarray(0, n))) return res.once('drain', pump)
      }
      res.end()
    }
    pump()
  } else if (url.pathname === '/sink') {
    let n = 0
    req.on('data', (d) => (n += d.length))
    req.on('end', () => res.end(String(n)))
  } else {
    res.writeHead(404).end()
  }
}
const servers = []
async function serve(cert, extra = {}) {
  const s = https.createServer({ key: cert.key, cert: cert.chain ?? cert.pem, ALPNProtocols: ['http/1.1'], honorCipherOrder: false, ...extra }, app)
  s.listen(0, '127.0.0.1')
  await once(s, 'listening')
  servers.push(s)
  return s.address().port
}
const mainPort = await serve(ecdsa)
const rsaPort = await serve({ key: rsa.key, chain: rsa.pem + rsaInt.pem })
const aes128Port = await serve(ecdsa, { ciphers: 'TLS_AES_128_GCM_SHA256', minVersion: 'TLSv1.3' })
const aes256Port = await serve(ecdsa, { ciphers: 'TLS_AES_256_GCM_SHA384', minVersion: 'TLSv1.3' })

const publicHost = process.env.BH_TLS_PUBLIC ? (process.env.BH_TLS_PUBLIC_HOST ?? 'example.com') : undefined
const allow = [mainPort, rsaPort, aes128Port, aes256Port].map((p) => `127.0.0.1:${p}`)
if (publicHost) allow.push(`${publicHost}:443`)
const relay = await startRelay({ allow })

// --- static page server: deliberately NO COOP/COEP headers (not cross-origin isolated)
const wasm = readFileSync(here + '../src/generated/beamhop_tls_wasm_bg.wasm')
const page = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  if (path === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>tls e2e</title>')
  if (path === '/tls.wasm') return res.writeHead(200, { 'content-type': 'application/wasm' }).end(wasm)
  if (/^\/[\w.-]+\.js$/.test(path)) {
    try {
      return res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(out + path.slice(1)))
    } catch {}
  }
  res.writeHead(404).end()
})
page.listen(0, '127.0.0.1')
await once(page, 'listening')

const { chromium } = await import('playwright')
const browser = await chromium.launch()
let result
try {
  const tab = await browser.newPage()
  tab.on('console', (m) => console.log('[browser]', m.text()))
  tab.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await tab.goto(`http://127.0.0.1:${page.address().port}/`)
  const target = (port) => ({ relay: `ws://127.0.0.1:${relay.port}`, host: '127.0.0.1', port, serverName: NAME })
  const job = {
    target: target(mainPort),
    rsa: target(rsaPort),
    bulk: { chacha20poly1305: target(mainPort), aes128gcm: target(aes128Port), aes256gcm: target(aes256Port) },
    caPem: ca.pem,
    bulkMb: Number(process.env.BH_TLS_BULK_MB ?? 32),
    handshakes: Number(process.env.BH_TLS_HANDSHAKES ?? 20),
    public: publicHost ? { relay: `ws://127.0.0.1:${relay.port}`, host: publicHost, port: 443, serverName: publicHost } : undefined,
  }
  const reply = await tab.evaluate(
    (job) =>
      new Promise((resolve) => {
        const w = new Worker('/worker.js', { type: 'module' })
        w.onmessage = (ev) => resolve({ ...ev.data, pageIsolated: self.crossOriginIsolated })
        w.onerror = (ev) => resolve({ error: `worker error: ${ev.message}` })
        w.postMessage(job)
      }),
    job,
  )
  if (reply.error) throw new Error(reply.error)
  result = reply.result
  result.browser = `${browser.browserType().name()} ${browser.version()}`
  result.pageCrossOriginIsolated = reply.pageIsolated
} finally {
  await browser.close()
  relay.close()
  page.close()
  for (const s of servers) {
    s.close()
    s.closeAllConnections()
  }
}

console.log(JSON.stringify(result, null, 2))

assert.equal(result.isWorker, true, 'ran in a dedicated worker')
assert.equal(result.crossOriginIsolated, false, 'worker is not cross-origin isolated')
assert.equal(result.pageCrossOriginIsolated, false, 'page is not cross-origin isolated')
assert.equal(result.sharedArrayBuffer, false, 'SharedArrayBuffer is not available')
assert.equal(result.alpn, 'http/1.1')
assert.equal(result.protocolVersion, 'TLSv1.3')
assert.equal(result.stream.status, 200)
assert.equal(result.stream.transferEncoding, 'chunked')
assert.deepEqual(result.stream.arrivals.map((a) => a.text), [0, 1, 2, 3, 4].map((i) => `part ${i}\n`))
assert.ok(result.stream.arrivals[4].at - result.stream.arrivals[0].at > 200, 'chunks arrived over time, not in one piece at the end')
assert.equal(result.cleanClose, true, 'response ended with close_notify')
assert.deepEqual(result.rejects, { mozillaRootsVsTestCa: 'cert-untrusted', wrongName: 'cert-name-mismatch', tls12Only: 'ok' })
assert.ok(result.mozillaRoots.count > 100)
for (const [name, h] of Object.entries(result.handshake)) assert.equal(typeof h, 'object', `handshake ${name}: ${h}`)
for (const [name, b] of Object.entries(result.bulk)) assert.ok(b.downloadOk && b.uploadOk, `bulk ${name}`)
assert.equal(result.bulk.chacha20poly1305.cipherSuite, 'TLS13_CHACHA20_POLY1305_SHA256')
assert.equal(result.bulk.aes128gcm.cipherSuite, 'TLS13_AES_128_GCM_SHA256')
if (publicHost) {
  if (!result.public.ok) {
    console.error(`\nPUBLIC HOST TEST FAILED (${publicHost}): ${result.public.error}`)
    process.exit(2)
  }
  assert.ok(result.public.status >= 200 && result.public.status < 500)
  console.log(`\npublic host ${publicHost}: OK`)
} else console.log('\npublic host test: skipped (set BH_TLS_PUBLIC=1 to run)')
console.log('e2e: all assertions passed')
