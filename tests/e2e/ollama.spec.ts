import { test, expect, chromium, type Page } from '@playwright/test'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

const RELAY = 'ws://localhost:7777'
const APP = `http://localhost:5173/?relay=${encodeURIComponent(RELAY)}`

// A stand-in for Ollama that applies its CORS rules (gin-contrib/cors: a disallowed Origin gets a
// 403, and so does its preflight) with this page's origin left out of OLLAMA_ORIGINS. Requests
// without an Origin (the extension strips it) pass, as they do in Ollama. Answers come from the
// repo's mock model server.
function strictOllama(port: number) {
  const server = http.createServer((req, res) => {
    if (req.headers.origin) {
      res.writeHead(403)
      return res.end()
    }
    const up = http.request({ host: '127.0.0.1', port: 7790, path: req.url, method: req.method, headers: { ...req.headers, host: '127.0.0.1:7790' } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    req.pipe(up)
  })
  return new Promise<http.Server>((r) => server.listen(port, () => r(server)))
}

async function ollamaAgentEditor(page: Page, baseUrl: string, roomId?: string) {
  await page.goto(`${APP}#/agents/new${roomId ? `/${roomId}` : ''}`)
  await page.getByRole('button', { name: /Ollama/ }).click()
  const url = page.getByPlaceholder('http://localhost:11434')
  // The card fills in the saved (or default) address once it has loaded; type after that.
  await expect(url).not.toHaveValue('')
  await url.fill(baseUrl)
  await page.locator('.card').getByRole('button', { name: /Save/ }).click()
}

test('Ollama: a server that refuses this page explains OLLAMA_ORIGINS; an unreachable one says so', async ({ browser }) => {
  const server = await strictOllama(7811)
  try {
    const page = await (await browser.newContext()).newPage()
    await ollamaAgentEditor(page, 'http://localhost:7811')
    const err = page.locator('.card .err')
    await expect(err).toContainText('Ollama is running at localhost:7811 but doesn’t allow this page', { timeout: 15_000 })
    await expect(err).toContainText('OLLAMA_ORIGINS=http://localhost:5173')
    await expect(err).toContainText('launchctl setenv OLLAMA_ORIGINS')

    await ollamaAgentEditor(page, 'http://localhost:7899')
    await expect(err).toContainText('Can’t reach Ollama at localhost:7899', { timeout: 15_000 })
  } finally {
    server.close()
  }
})

test('Ollama: with the Companion extension, a server that refuses the page is reached through it', async () => {
  const server = await strictOllama(7812)
  const ext = path.resolve('packages/extension/dist/chromium-dev')
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'bh-ollama-')), {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  })
  try {
    const page = await ctx.newPage()
    await page.goto(`${APP}#/`)
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.beamhopCompanion ?? null), { timeout: 15_000 }).toBeTruthy()
    await page.getByRole('button', { name: 'Hop a Room' }).click()
    await page.getByPlaceholder('Your name').fill('Alice')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.getByText('Invite your crew.')).toBeVisible()
    await page.keyboard.press('Escape')
    const roomId = page.url().match(/#\/r\/([0-9a-f]+)/)![1]

    await ollamaAgentEditor(page, 'http://localhost:7812', roomId)
    await expect(page.locator('.card').getByText('Connected · 2 models')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.card .err')).toHaveCount(0)

    // The agent's own model calls go the same way.
    await page.locator('.field input').first().fill('Llama')
    await page.getByLabel('Search models').fill('mock-model')
    await page.getByLabel('Search models').press('Enter')
    await page.getByRole('button', { name: 'Create & add' }).click()
    await expect(page.locator('.system-line').getByText('Llama joined as your agent')).toBeVisible({ timeout: 15_000 })
    await page.getByPlaceholder('Message').fill('@Llama hello through the extension')
    await page.keyboard.press('Enter')
    await expect(page.locator('.msg.agent .bubble').getByText(/echo:/)).toBeVisible({ timeout: 60_000 })
  } finally {
    await ctx.close()
    server.close()
  }
})
