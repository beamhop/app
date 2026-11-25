import { test, expect } from '@playwright/test'

const RELAY = 'ws://localhost:7777'

test('after picking a provider, its models are listed and searchable', async ({ page }) => {
  await page.goto(`./?relay=${encodeURIComponent(RELAY)}#/`)
  await page.getByRole('button', { name: 'Hop a Room' }).click()
  await page.getByPlaceholder('Your name').fill('Solo')
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByText('Invite your crew.')).toBeVisible()
  await page.keyboard.press('Escape')
  const roomId = page.url().match(/#\/r\/([0-9a-f]+)/)![1]
  await page.goto(`./?relay=${encodeURIComponent(RELAY)}#/agents/new/${roomId}`)
  await page.getByRole('button', { name: /Other \(OpenAI-compatible\)/ }).click()
  await page.getByPlaceholder('https://my-server.example/v1').fill('http://localhost:7790/v1')
  await page.locator('.card').getByRole('button', { name: 'Save' }).click()

  const list = page.getByRole('listbox', { name: 'Models' })
  await expect(list.getByRole('option')).toHaveText(['mock-model', 'mock-model-2'])
  await page.getByLabel('Search models').fill('-2')
  await expect(list.getByRole('option')).toHaveText(['mock-model-2'])
  await list.getByRole('option', { name: 'mock-model-2' }).click()
  await expect(page.locator('.model-current')).toContainText('mock-model-2')
  await expect(list.getByRole('option', { name: 'mock-model-2' })).toHaveAttribute('aria-selected', 'true')

  // an unlisted id can still be used
  await page.getByLabel('Search models').fill('my-own-model')
  await page.getByRole('button', { name: /Use “my-own-model”/ }).click()
  await expect(page.locator('.model-current')).toContainText('my-own-model')
})
