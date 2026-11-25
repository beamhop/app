const { Builder } = require('selenium-webdriver')
const firefox = require('selenium-webdriver/firefox')
const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
// Usage: FIREFOX_BIN=/path/to/firefox GECKODRIVER=/path/to/geckodriver node tests/firefox/extension.cjs
// (needs the dev server on :5173: npm run dev)
;(async () => {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-origin-seen': String(req.headers.origin ?? 'none') })
      for (const p of ['one ', 'two ', 'body=' + body]) { res.write(p); await new Promise((r) => setTimeout(r, 30)) }
      res.end()
    })
  }).listen(7797)
  const opts = new firefox.Options().setBinary(process.env.FIREFOX_BIN).addArguments('-headless').setAcceptInsecureCerts(true)
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).setFirefoxService(new firefox.ServiceBuilder(process.env.GECKODRIVER)).build()
  try {
    await driver.installAddon(require('node:path').resolve(__dirname, '../../packages/extension/dist/beamhop-companion-firefox.zip'), true)
    await driver.get('http://localhost:5173/?relay=ws%3A%2F%2Flocalhost%3A7777#/')
    let v = null
    for (let i = 0; i < 50 && !v; i++) { v = await driver.executeScript('return document.documentElement.dataset.beamhopCompanion || null'); if (!v) await new Promise((r) => setTimeout(r, 200)) }
    console.log('detected', v)
    await new Promise((r) => setTimeout(r, 1500))
    const direct = await driver.executeAsyncScript('const done = arguments[0]; fetch("http://localhost:7797/x", { method: "POST", body: "hi" }).then(() => done("ok"), () => done("blocked"))')
    console.log('direct fetch', direct)
    const r = await driver.executeAsyncScript(`const done = arguments[0];
      (async () => {
        const res = await window.__beamhopExt.extFetch('http://localhost:7797/x', { method: 'POST', body: 'hi', headers: { 'content-type': 'text/plain' } })
        const reader = res.body.getReader(); let text = '', chunks = 0
        for (;;) { const { value, done: d } = await reader.read(); if (d) break; chunks++; text += new TextDecoder().decode(value) }
        return { status: res.status, text, chunks, origin: res.headers.get('x-origin-seen') }
      })().then(done, (e) => done({ error: String(e) }))`)
    console.log('ext fetch', JSON.stringify(r))
    const fx = require('node:path').resolve(__dirname, '../e2e/fixtures')
    const signin = https.createServer({ key: fs.readFileSync(fx + '/key.pem'), cert: fs.readFileSync(fx + '/cert.pem') }, (q, s2) => { s2.writeHead(302, { location: 'http://localhost:1455/auth/callback?code=ff123' }); s2.end() }).listen(7798)
    const before = (await driver.getAllWindowHandles()).length
    const cap = await driver.executeAsyncScript(`const done = arguments[0];
      window.addEventListener('message', (e) => { if (e.data && e.data.__bh === 'res' && e.data.id === 'c1') done(e.data.kind === 'result' ? e.data.value : 'ERR ' + e.data.message) });
      window.postMessage({ __bh: 'req', id: 'c1', op: 'capture', url: 'https://localhost:7798/authorize', redirectPrefix: 'http://localhost:1455/auth/callback' }, '*')`)
    await new Promise((r) => setTimeout(r, 500))
    console.log('capture', cap, 'tabs', before, '->', (await driver.getAllWindowHandles()).length)
    signin.close()
    console.log('store sees extension', await driver.executeScript('return window.__beamhop && window.__beamhop.hasExtension'))
  } finally {
    await driver.quit()
    server.close()
  }
})().catch((e) => { console.log('FAIL', e.message); process.exit(1) })
