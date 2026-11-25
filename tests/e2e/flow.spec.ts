import { test, expect, type Page } from '@playwright/test'

const RELAY = 'ws://localhost:7777'
const open = (p: Page, hash = '') => p.goto(`./?relay=${encodeURIComponent(RELAY)}#/${hash}`)

test('create room, invite, lobby, admit, chat, browser agent replies', async ({ browser }) => {
  const alice = await (await browser.newContext()).newPage()
  const bob = await (await browser.newContext()).newPage()
  alice.on('pageerror', (e) => console.log('alice error', e.message))
  bob.on('pageerror', (e) => console.log('bob error', e.message))

  await open(alice)
  await alice.getByRole('button', { name: 'Hop a Room' }).click()
  await alice.getByPlaceholder('Your name').fill('Alice')
  await alice.getByRole('button', { name: 'Continue' }).click()
  await expect(alice.getByText('Invite your crew.')).toBeVisible()
  const link = await alice.locator('.copy-box input').first().inputValue()
  expect(link).toContain('#/join/')

  // Bob opens the invite
  await bob.goto(link.replace(/^https?:\/\/[^/]+\/(app\/)?(\?[^#]*)?/, `./?relay=${encodeURIComponent(RELAY)}`))
  await expect(bob.getByText('You’re invited to')).toBeVisible()
  await bob.getByPlaceholder('Your name').fill('Bob')
  await bob.getByRole('button', { name: 'Ask to join' }).click()
  await expect(bob.getByText('Hang tight.')).toBeVisible()

  // Alice admits from the lobby notice
  await alice.keyboard.press('Escape')
  await expect(alice.getByText('Bob wants to join')).toBeVisible({ timeout: 15000 })
  await alice.locator('.notice').getByRole('button', { name: 'Admit' }).click()
  await expect(bob.getByText('You’re in. Bring your agents.')).toBeVisible({ timeout: 15000 })

  // Chat
  await bob.getByPlaceholder('Message').fill('hello alice')
  await bob.keyboard.press('Enter')
  await expect(alice.locator('.msg').getByText('hello alice')).toBeVisible({ timeout: 10000 })

  // Alice creates a browser agent on a local OpenAI-compatible server and adds it to the room
  const roomUrl = alice.url()
  const roomId = roomUrl.match(/#\/r\/([0-9a-f]+)/)![1]
  await alice.goto(`./?relay=${encodeURIComponent(RELAY)}#/agents/new/${roomId}`)
  await alice.locator('.field input').first().fill('Echo')
  await alice.getByRole('button', { name: /Other \(OpenAI-compatible\)/ }).click()
  await alice.getByPlaceholder('https://my-server.example/v1').fill('http://localhost:7790/v1')
  await alice.locator('.card').getByRole('button', { name: 'Save' }).click()
  await alice.getByPlaceholder('model id').fill('mock-model')
  await alice.getByRole('button', { name: 'Create & add' }).click()
  await expect(alice.locator('.system-line').getByText('Echo joined as your agent')).toBeVisible({ timeout: 15000 })

  // Bob mentions the agent; it replies through fx (WebAssembly) in Alice's tab
  await expect(bob.locator('.system-line').getByText(/Echo joined/)).toBeVisible({ timeout: 15000 })
  await bob.getByPlaceholder('Message').fill('@Echo ping from bob')
  await bob.keyboard.press('Enter')
  await expect(bob.locator('.msg.agent').getByText(/echo:/)).toBeVisible({ timeout: 60000 })
  await expect(alice.locator('.msg.agent').getByText(/echo:/)).toBeVisible({ timeout: 10000 })

  // tool use: the agent runs JavaScript in its sandbox
  await bob.getByPlaceholder('Message').fill('@Echo use_tool:run_javascript {"code":"return 6*7"}')
  await bob.keyboard.press('Enter')
  await expect(bob.locator('.msg.agent').getByText(/tool said: ok/)).toBeVisible({ timeout: 60000 })
  await expect(bob.locator('.msg.agent').getByText(/42/)).toBeVisible()

  // reactions & replies
  const msg = alice.locator('.msg').filter({ hasText: 'hello alice' }).first()
  await msg.click({ button: 'right' })
  await alice.locator('.action-sheet .quick button').first().click()
  await expect(bob.locator('.reaction').first()).toBeVisible({ timeout: 10000 })
})
