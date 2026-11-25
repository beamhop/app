import { test, expect, devices } from '@playwright/test'

const RELAY = 'ws://localhost:7777'

// A minimal ACP agent in POSIX shell (busybox): answers initialize, session/new and session/prompt.
// It runs inside the browser's Linux machine, so its reply proves the whole path: unkernel boots
// in a worker, the harness starts, ACP runs over its pipes, and the answer reaches the room.
const ACP_AGENT = [
  `while IFS= read -r l; do id=$(echo "$l" | sed -n 's/.*"id":\\([^,}]*\\).*/\\1/p');`,
  `case "$l" in`,
  `*'"initialize"'*) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"protocolVersion\\":1,\\"agentCapabilities\\":{},\\"authMethods\\":[]}}";;`,
  `*'"session/new"'*) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"sessionId\\":\\"s1\\"}}";;`,
  `*'"session/prompt"'*) date > last-turn.txt; echo "{\\"jsonrpc\\":\\"2.0\\",\\"method\\":\\"session/update\\",\\"params\\":{\\"sessionId\\":\\"s1\\",\\"update\\":{\\"sessionUpdate\\":\\"agent_message_chunk\\",\\"content\\":{\\"type\\":\\"text\\",\\"text\\":\\"machine pong from $(uname -m)\\"}}}}";`,
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

  // Its owner can open the agent's Linux machine from the room: a terminal in the agent's folder,
  // where the file it wrote during its turn is.
  await page.locator('.person').filter({ hasText: 'Tux' }).getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByText('Custom ACP agent · Linux machine').first()).toBeVisible()
  await page.getByRole('button', { name: 'Open terminal' }).click()
  await expect(page.getByRole('heading', { name: 'Tux · Linux machine' })).toBeVisible()
  const term = page.locator('.machine-terminal')
  await term.click()
  await page.keyboard.type('echo "where=$(pwd)"; ls\n')
  await expect(term.locator('.xterm-rows')).toContainText(/where=\/root\/beamhop\/[0-9a-f]+/, { timeout: 30_000 })
  await expect(term.locator('.xterm-rows')).toContainText('last-turn.txt')
  await page.keyboard.press('Escape')

  // The agent list shows where it runs.
  await page.goto(`./?relay=${encodeURIComponent(RELAY)}#/agents`)
  await expect(page.locator('.list-item').filter({ hasText: 'Custom ACP agent' })).toContainText('Custom ACP agent · Linux machine')
  await expect(page.locator('.list-item').filter({ hasText: 'Custom ACP agent' })).toContainText('Ready')
})

test('on a phone, the machine terminal has keys for arrows, Ctrl and Return', async ({ browser }) => {
  test.setTimeout(180_000)
  const page = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage()
  page.on('pageerror', (e) => console.log('pageerror', e?.message ?? e))
  await page.goto(`./?relay=${encodeURIComponent(RELAY)}#/settings`)
  // The machine reaches the internet through the default Wisp server unless told otherwise.
  await expect(page.getByPlaceholder('wss://wisp.example/')).toHaveValue('wss://kucukkanat-wisp.wasmer.app/')
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  const bar = page.getByRole('toolbar', { name: 'Terminal keys' })
  await expect(bar).toBeVisible()
  const rows = page.locator('.machine-terminal .xterm-rows')
  await expect(rows).toContainText('⇒', { timeout: 120_000 }) // the shell's prompt
  const key = (name: string) => bar.getByRole('button', { name, exact: true }).click()

  // Arrows move the cursor: type "echo abc", go left twice, insert X, Return.
  await page.locator('.machine-terminal').click()
  await page.keyboard.type('echo abc')
  await key('Left')
  await key('Left')
  await page.keyboard.type('X')
  await key('Return')
  await expect(rows).toContainText('aXbc')

  // Ctrl is sticky: Ctrl, then c on the keyboard, interrupts a running command.
  await page.keyboard.type('sleep 60')
  await key('Return')
  await key('Ctrl')
  await expect(bar.getByRole('button', { name: 'Ctrl', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.type('c')
  await expect(bar.getByRole('button', { name: 'Ctrl', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.type('echo after-interrupt')
  await key('Return')
  // xterm draws each line as its own element: count the output lines, not the typed commands.
  const outputLines = rows.locator(':scope > div').filter({ hasText: /^\s*after-interrupt\s*$/ })
  await expect(outputLines).toHaveCount(1, { timeout: 15_000 })

  // Up recalls the previous command.
  await key('Up')
  await key('Return')
  await expect(outputLines).toHaveCount(2, { timeout: 15_000 })
})
