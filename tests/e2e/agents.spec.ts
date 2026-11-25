import { test, expect, type Page } from '@playwright/test'

const RELAY = 'ws://localhost:7777'
const open = (p: Page, hash = '') => p.goto(`./?relay=${encodeURIComponent(RELAY)}#/${hash}`)

test('codex provider routes through the given fetch with ChatGPT credentials', async ({ page }) => {
  await open(page)
  const r = await page.evaluate(async () => {
    const { createFxAgent } = await import(/* @vite-ignore */ '/@id/libfx/browser' as any)
    const seen: any[] = []
    const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1' } })).replace(/=+$/, '')
    const agent = createFxAgent({
      provider: 'codex',
      model: 'gpt-5-codex',
      credentials: async () => ({ accessToken: `x.${payload}.y`, refreshToken: 'r' }),
      fetch: async (url: string, init: any) => {
        seen.push({ url, auth: new Headers(init.headers).get('authorization'), acct: new Headers(init.headers).get('chatgpt-account-id') })
        return new Response(JSON.stringify({ error: { message: 'mock says no' } }), { status: 418, headers: { 'content-type': 'application/json' } })
      },
    })
    const turn = agent.session().prompt('hi')
    for await (const _ of turn) {
    }
    const res = await turn.result
    return { seen, stop: res.stopReason, err: res.error?.message }
  })
  expect(r.seen.some((s: any) => s.url.startsWith('https://chatgpt.com/backend-api/codex/responses') && s.auth?.startsWith('Bearer x.') && s.acct === 'acct_1')).toBe(true)
  expect(['error', 'refused']).toContain(r.stop)
})

test('agent answers mentions it missed while offline, and runs Python', async ({ browser }) => {
  const actx = await browser.newContext()
  let alice = await actx.newPage()
  const bob = await (await browser.newContext()).newPage()
  await open(alice)
  await alice.getByRole('button', { name: 'Hop a Room' }).click()
  await alice.getByPlaceholder('Your name').fill('Alice')
  await alice.getByRole('button', { name: 'Continue' }).click()
  const link = await alice.locator('.copy-box input').first().inputValue()
  const roomId = alice.url().match(/#\/r\/([0-9a-f]+)/)![1]
  await bob.goto(link.replace(/^https?:\/\/[^/]+\/(app\/)?(\?[^#]*)?/, `./?relay=${encodeURIComponent(RELAY)}`))
  await bob.getByPlaceholder('Your name').fill('Bob')
  await bob.getByRole('button', { name: 'Ask to join' }).click()
  await alice.keyboard.press('Escape')
  await alice.locator('.notice').getByRole('button', { name: 'Admit' }).click()
  await expect(bob.getByText('You’re in. Bring your agents.')).toBeVisible({ timeout: 15000 })

  await open(alice, `agents/new/${roomId}`)
  await alice.locator('.field input').first().fill('Helper')
  await alice.getByRole('button', { name: /Other \(OpenAI-compatible\)/ }).click()
  await alice.getByPlaceholder('https://my-server.example/v1').fill('http://localhost:7790/v1')
  await alice.locator('.card').getByRole('button', { name: 'Save' }).click()
  await alice.getByPlaceholder('model id').fill('mock-model')
  await alice.getByRole('button', { name: 'Create & add' }).click()
  await expect(bob.locator('.system-line').getByText(/Helper joined/)).toBeVisible({ timeout: 15000 })

  // Python in the sandbox (Pyodide from the CDN)
  await bob.getByPlaceholder('Message').fill('@Helper use_tool:run_python {"code":"print(6*7)"}')
  await bob.keyboard.press('Enter')
  await expect(bob.locator('.msg.agent').getByText(/tool said: ok/)).toBeVisible({ timeout: 90000 })
  await expect(bob.locator('.msg.agent').filter({ hasText: 'tool said' }).getByText(/42/)).toBeVisible()

  // Alice goes offline; Bob mentions the agent; Alice comes back and the agent catches up
  await alice.close()
  await expect.poll(() => bob.evaluate((rid) => { const s = (window as any).__beamhop; const st = s.client.state(rid); const a = Object.keys(st.agents)[0]; return s.client.onlineAgents(rid).has(a) }, roomId), { timeout: 100000, intervals: [2000] }).toBe(false)
  await bob.getByPlaceholder('Message').fill('@Helper are you there? (sent while offline)')
  await bob.keyboard.press('Enter')
  await bob.waitForTimeout(1000)
  alice = await actx.newPage()
  await open(alice, `r/${roomId}`)
  // the agent's second reply arrives after its owner is back
  await expect(bob.locator('.msg.agent')).toHaveCount(2, { timeout: 40000 })
})

test('gemini (Google account) agent runs in the browser engine, with a tool call', async ({ page }) => {
  let calls = 0
  await page.route('https://cloudcode-pa.googleapis.com/**', async (route) => {
    calls++
    const req = JSON.parse(route.request().postData() ?? '{}').request
    const last = req.contents[req.contents.length - 1]
    const part = last.parts[0].functionResponse
      ? { text: 'The time is ' + last.parts[0].functionResponse.response.result }
      : { functionCall: { name: 'get_time', args: {} }, thoughtSignature: 'sig' }
    const chunk = { response: { candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } } }
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: 'data: ' + JSON.stringify(chunk) + '\r\n\r\n' })
  })
  await open(page)
  const r = await page.evaluate(async () => {
    const { createFxAgent } = await import(/* @vite-ignore */ '/@id/libfx/browser' as any)
    const { makeGeminiFetch } = await import(/* @vite-ignore */ '/src/agents/gemini.ts' as any)
    const agent = createFxAgent({
      provider: { name: 'gemini', baseUrl: 'https://cloudcode-pa.googleapis.com/v1internal', modelDefaults: { contextWindow: 1000000, maxOutputTokens: 8192, supportsToolUse: true } },
      model: 'gemini-2.5-flash',
      fetch: makeGeminiFetch(async () => ({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6, projectId: 'p' })),
      tools: [{ name: 'get_time', description: 'time', inputSchema: { type: 'object', properties: {} }, idempotent: true, execute: async () => 'noon' }],
    })
    const turn = agent.session().prompt('what time is it?')
    let text = ''
    for await (const e of turn) if (e.type === 'text_delta') text += e.delta
    const res = await turn.result
    return { text, stop: res.stopReason, err: res.error?.message ?? null }
  })
  expect(r).toEqual({ text: 'The time is noon', stop: 'end_turn', err: null })
  expect(calls).toBe(2)
})

test('python sandbox: subfolders work and workspaces stay separate', async ({ page }) => {
  await open(page)
  const r = await page.evaluate(async () => {
    const { sandboxFor } = await import(/* @vite-ignore */ '/src/agents/sandbox.ts' as any)
    const a = sandboxFor('test-room-a-' + Date.now())
    const b = sandboxFor('test-room-b-' + Date.now())
    await a.write('notes/plan.md', 'step 1')
    const r1 = await a.runPython("import os\nsecret = 'only-a'\nos.makedirs('out', exist_ok=True)\nopen('out/result.txt', 'w').write(open('notes/plan.md').read() + ' done')\nprint('ok')")
    const r2 = await b.runPython("import os\nprint(sorted(os.listdir('.')))\nprint('secret' in globals())")
    return { r1, r2, aFiles: (await a.list()).map((f: any) => f.path).sort(), bFiles: (await b.list()).map((f: any) => f.path) }
  })
  expect(r.r1.ok).toBe(true)
  expect(r.r1.changed).toEqual({ 'out/result.txt': 'step 1 done' })
  expect(r.aFiles).toEqual(['notes/plan.md', 'out/result.txt'])
  expect(r.r2.stdout).toBe('[]\nFalse\n')
  expect(r.bFiles).toEqual([])
})
