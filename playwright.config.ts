import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: process.env.BH_BASE ?? 'http://localhost:5173', trace: 'off' },
  webServer: [
    { command: 'node tools/e2e-servers.mjs', port: 7790, reuseExistingServer: true },
    { command: 'npm run dev -w @beamhop/app -- --port 5173 --strictPort', port: 5173, reuseExistingServer: true, timeout: 60_000 },
  ],
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 860 } } },
  ],
})
