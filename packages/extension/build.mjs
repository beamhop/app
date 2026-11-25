// Builds the Companion extension for Chromium and Firefox and zips both.
import { mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const version = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version
const out = join(here, 'dist')
rmSync(out, { recursive: true, force: true })

const base = {
  manifest_version: 3,
  name: 'Beamhop Companion',
  version,
  description: 'Lets Beamhop browser agents use your ChatGPT and GitHub Copilot plans and reach the web. Runs only on Beamhop pages.',
  icons: { 48: 'icon-48.png', 128: 'icon-128.png' },
  permissions: ['tabs', 'webNavigation', 'declarativeNetRequestWithHostAccess'],
  host_permissions: ['<all_urls>'],
  content_scripts: [
    {
      matches: ['https://beamhop.github.io/*', 'http://localhost:*/*', 'http://127.0.0.1:*/*'],
      js: ['content.js'],
      run_at: 'document_start',
    },
  ],
}
const targets = {
  chromium: { ...base, background: { service_worker: 'background.js' }, minimum_chrome_version: '116' },
  firefox: {
    ...base,
    background: { scripts: ['background.js'] },
    browser_specific_settings: { gecko: { id: 'companion@beamhop.github.io', strict_min_version: '128.0' } },
  },
}
for (const [name, manifest] of Object.entries(targets)) {
  const dir = join(out, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  for (const f of ['content.js', 'background.js']) copyFileSync(join(here, 'src', f), join(dir, f))
  for (const f of ['icon-48.png', 'icon-128.png']) copyFileSync(join(here, 'static', f), join(dir, f))
  const zip = join(out, name === 'chromium' ? 'beamhop-companion.zip' : 'beamhop-companion-firefox.zip')
  execFileSync('zip', ['-qr', zip, '.'], { cwd: dir })
}
console.log('extension built', version)
