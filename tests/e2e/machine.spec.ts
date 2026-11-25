import { test, expect } from '@playwright/test'

const RELAY = 'ws://localhost:7777'

// A minimal ACP agent in POSIX shell (busybox): answers initialize, session/new and session/prompt.
// It runs inside the browser's Linux machine, so its reply proves the whole path: unkernel boots
// in a worker, the harness starts, ACP runs over its pipes, and the answer reaches the room.
const ACP_AGENT = [
  `while IFS= read -r l; do id=$(echo "$l" | sed -n 's/.*"id":\\([^,}]*\\).*/\\1/p');`,
  `case "$l" in`,
  `*'"initialize"'*) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"protocolVersion\\":1,\\"agentCapabilities\\":{},\\"authMethods\\":[]}}";;`,
  `*'"session/new"'*) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"sessionId\\":\\"s1\\"}}";;`,
  `*'"session/prompt"'*) echo "{\\"jsonrpc\\":\\"2.0\\",\\"method\\":\\"session/update\\",\\"params\\":{\\"sessionId\\":\\"s1\\",\\"update\\":{\\"sessionUpdate\\":\\"agent_message_chunk\\",\\"content\\":{\\"type\\":\\"text\\",\\"text\\":\\"machine pong from $(uname -m)\\"}}}}";`,
  `echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"stopReason\\":\\"end_turn\\"}}";;`,
  `esac; done`,
].join(' ')

test('a harness in the Linux machine in the tab answers in the room', async ({ browser }) => {
  test.setTimeout(240_000)
  const page = await (await browser.newContext()).newPage()
  page.on('pageerror', (e) => console.log('pageerror', e?.message ?? e))
  await page.goto(`./?relay=${encodeURIComponent(RELAY)}#/`)
  await page.getByRole('button', { name: 'Hop a Room' }).click()
  await page.getByPlaceholder('Your name').fill('Alice')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Invite your crew.')).toBeVisible()
  await page.keyboard.press('Escape')
  const roomId = page.url().match(/#\/r\/([0-9a-f]+)/)![1]

  // One flow for every kind of agent: "On my computer" gives the bridge command for the harness.
  await page.goto(`./?relay=${encodeURIComponent(RELAY)}#/agents/new/${roomId}`)
  await page.getByRole('button', { name: /On my computer/ }).click()
  await page.getByRole('button', { name: /^Codex/ }).click()
  await expect(page.locator('.code pre')).toContainText('--agent codex')
  await expect(page.locator('.code pre')).toContainText('#/agent/')

  // The same flow, run in the browser's Linux machine.
  await page.getByRole('button', { name: /Linux machine in this tab/ }).click()
  await page.locator('.field input').first().fill('Tux')
  await page.getByRole('button', { name: /^Custom ACP agent/ }).click()
  await page.getByPlaceholder('my-agent --acp').fill(ACP_AGENT)
  await page.getByRole('button', { name: 'Set up' }).click()
  await expect(page.getByText('Installed in this browser’s Linux machine.')).toBeVisible({ timeout: 120_000 })
  await page.getByRole('button', { name: 'Create & add' }).click()
  await expect(page.locator('.system-line').getByText('Tux joined as your agent')).toBeVisible({ timeout: 15_000 })

  await page.getByPlaceholder('Message').fill('@Tux ping')
  await page.keyboard.press('Enter')
  await expect(page.locator('.msg.agent').getByText('machine pong from aarch64')).toBeVisible({ timeout: 120_000 })

  // A second turn reuses the running harness and its session.
  await page.getByPlaceholder('Message').fill('@Tux again')
  await page.keyboard.press('Enter')
  await expect(page.locator('.msg.agent').getByText('machine pong from aarch64')).toHaveCount(2, { timeout: 60_000 })

  // The agent list shows where it runs.
  await page.goto(`./?relay=${encodeURIComponent(RELAY)}#/agents`)
  await expect(page.locator('.list-item').filter({ hasText: 'Custom ACP agent' })).toContainText('Custom ACP agent · Linux machine')
  await expect(page.locator('.list-item').filter({ hasText: 'Custom ACP agent' })).toContainText('Ready')
})
