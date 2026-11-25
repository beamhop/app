import { test, expect, devices, type Page } from '@playwright/test'

const RELAY = 'ws://localhost:7777'
const open = (p: Page, hash = '') => p.goto(`./?relay=${encodeURIComponent(RELAY)}#/${hash}`)

async function swipe(page: Page, from: [number, number], to: [number, number]) {
  const cdp = await page.context().newCDPSession(page)
  const steps = 8
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1] }] })
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps
    const y = from[1] + ((to[1] - from[1]) * i) / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

test('mobile: swipes, pairing, private chat with an agent', async ({ browser }) => {
  const phone = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage()
  phone.on('pageerror', (e) => console.log('phone error', e.message))
  await open(phone)
  // no zoom: viewport meta forbids scaling
  expect(await phone.locator('meta[name=viewport]').getAttribute('content')).toContain('user-scalable=no')
  await phone.getByRole('button', { name: 'Hop a Room' }).click()
  await phone.getByPlaceholder('Your name').fill('Pat')
  await phone.getByRole('button', { name: 'Continue' }).click()
  await expect(phone.getByText('Invite your crew.')).toBeVisible()
  await phone.locator('[aria-label=Close]').click()
  await phone.getByPlaceholder('Message').fill('first!')
  await phone.getByRole('button', { name: 'Send' }).click()
  await expect(phone.locator('.msg').getByText('first!')).toBeVisible()

  // swipe right on a message -> reply
  const box = (await phone.locator('.msg').filter({ hasText: 'first!' }).boundingBox())!
  await swipe(phone, [box.x + 80, box.y + box.height / 2], [box.x + 200, box.y + box.height / 2])
  await expect(phone.getByText(/Replying to Pat/)).toBeVisible()
  await phone.keyboard.press('Escape')

  // swipe left on chat -> people panel; swipe right -> back
  const vp = phone.viewportSize()!
  await swipe(phone, [vp.width - 60, vp.height / 2], [60, vp.height / 2])
  await expect(phone.getByRole('heading', { name: 'People & agents' })).toBeVisible()
  await phone.waitForTimeout(400)
  await swipe(phone, [60, vp.height / 2], [vp.width - 40, vp.height / 2])
  await expect(phone.getByRole('heading', { name: 'People & agents' })).toBeHidden()
  // edge swipe -> room list
  await swipe(phone, [8, vp.height / 2], [vp.width - 40, vp.height / 2])
  await expect(phone.getByText('Rooms', { exact: true })).toBeVisible()

  // private chat with own agent
  await open(phone, 'agents/new')
  await phone.locator('.field input').first().fill('Buddy')
  await phone.getByRole('button', { name: /Other \(OpenAI-compatible\)/ }).click()
  await phone.getByPlaceholder('https://my-server.example/v1').fill('http://localhost:7790/v1')
  await phone.locator('.card').getByRole('button', { name: 'Save' }).click()
  await phone.getByPlaceholder('model id').fill('mock-model')
  await phone.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(phone.getByText('Your agents')).toBeVisible()
  await phone.locator('.list-item').filter({ hasText: 'Buddy' }).click()
  await phone.getByRole('button', { name: 'Chat privately' }).click()
  await phone.getByPlaceholder('Message').fill('secret question')
  await phone.getByRole('button', { name: 'Send' }).click()
  await expect(phone.locator('.msg.agent').getByText('echo: secret question')).toBeVisible({ timeout: 30000 })

  // pair a second device
  await open(phone, 'settings')
  await phone.getByRole('button', { name: 'Add another device' }).click()
  const pairUrl = await phone.locator('.sheet .copy-box input').inputValue()
  const laptop = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage()
  await laptop.goto(pairUrl.replace(/^https?:\/\/[^/]+\/(app\/)?(\?[^#]*)?/, `./?relay=${encodeURIComponent(RELAY)}`))
  await laptop.getByRole('button', { name: 'Pair this device' }).click()
  await expect(phone.getByText('Paired.')).toBeVisible({ timeout: 20000 })
  await expect(laptop.locator('.list-item').filter({ hasText: 'Untitled room' })).toBeVisible({ timeout: 20000 })
  await expect.poll(() => laptop.evaluate(() => (window as any).__beamhop.liveAgents().map((a: any) => a.name)), { timeout: 20000 }).toContain('Buddy')
  await laptop.locator('.list-item').filter({ hasText: 'Untitled room' }).click()
  await expect(laptop.locator('.msg').getByText('first!')).toBeVisible({ timeout: 20000 })
})
