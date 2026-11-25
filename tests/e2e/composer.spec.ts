import { test, expect } from '@playwright/test'

const RELAY = 'ws://localhost:7777'

test('a message typed while an edit awaits slow relays is sent as a new message', async ({ browser }) => {
  const ctx = await browser.newContext()
  // Public relays can take seconds to confirm; delay every OK by 3s.
  await ctx.routeWebSocket(RELAY + '/', (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => server.send(m))
    server.onMessage((m) => (String(m).startsWith('["OK"') ? setTimeout(() => ws.send(m), 3000) : ws.send(m)))
  })
  const page = await ctx.newPage()
  await page.goto(`./?relay=${encodeURIComponent(RELAY)}#/`)
  await page.getByRole('button', { name: 'Hop a Room' }).click()
  await page.getByPlaceholder('Your name').fill('Solo')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Invite your crew.')).toBeVisible()
  await page.keyboard.press('Escape')
  const box = page.getByPlaceholder('Message')

  await box.fill('typo mesage')
  await page.keyboard.press('Enter')
  await page.locator('.msg').filter({ hasText: 'typo mesage' }).click({ button: 'right' })
  await page.locator('.action-sheet').getByRole('button', { name: 'Edit' }).click()
  await expect(box).toHaveValue('typo mesage')
  await box.fill('fixed message')
  await page.keyboard.press('Enter')
  // the composer leaves edit mode at once, not when the relays confirm
  await expect(box).toHaveValue('', { timeout: 1000 })
  await expect(page.getByText('Editing message')).toHaveCount(0)

  await box.fill('a new message')
  await page.keyboard.press('Enter')
  await expect(page.locator('.msg').getByText('a new message')).toBeVisible()
  await expect(page.locator('.msg').getByText('fixed message')).toBeVisible()
  await page.waitForTimeout(4000)
  await expect(page.locator('.msg').getByText('fixed message')).toBeVisible()
  await expect(page.locator('.msg').filter({ hasText: 'a new message' }).getByText('(edited)')).toHaveCount(0)
})
