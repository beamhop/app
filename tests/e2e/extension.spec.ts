import { test, expect, chromium } from '@playwright/test'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

test('companion extension: detection and cross-origin streaming fetch', async () => {
  // A server that sends no CORS headers: pages can't read it, the extension can.
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-origin-seen': String(req.headers.origin ?? 'none') })
      for (const part of ['one ', 'two ', 'three ', 'body=' + body]) {
        res.write(part)
        await new Promise((r) => setTimeout(r, 30))
      }
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(7795, r))
  const ext = path.resolve('packages/extension/dist/chromium')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-ext-'))
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  })
  try {
    const page = await ctx.newPage()
    await page.goto('http://localhost:5173/?relay=ws%3A%2F%2Flocalhost%3A7777#/')
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.beamhopCompanion ?? null), { timeout: 15000 }).toBe('0.1.0')
    // direct fetch is blocked by CORS
    const direct = await page.evaluate(() => fetch('http://localhost:7795/x', { method: 'POST', body: 'hi' }).then(() => 'ok', (e) => 'blocked'))
    expect(direct).toBe('blocked')
    const r = await page.evaluate(async () => {
      const res = await (window as any).__beamhopExt.extFetch('http://localhost:7795/x', { method: 'POST', body: 'hi', headers: { 'content-type': 'text/plain' } })
      const reader = res.body.getReader()
      let chunks = 0
      let text = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        chunks++
        text += new TextDecoder().decode(value)
      }
      return { status: res.status, text, chunks, origin: res.headers.get('x-origin-seen') }
    })
    expect(r.status).toBe(200)
    expect(r.text).toBe('one two three body=hi')
    expect(r.chunks).toBeGreaterThan(1)
    expect(r.origin).toBe('none')
    expect(await page.evaluate(() => (window as any).__beamhop.hasExtension)).toBe(true)
  } finally {
    await ctx.close()
    server.close()
  }
})
