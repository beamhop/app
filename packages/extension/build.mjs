// Builds the Companion extension for Chromium and Firefox and zips both.
import { mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const version = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version
const out = join(here, 'dist')
rmSync(out, { recursive: true, force: true })

const APP = 'https://beamhop.github.io/app/*'
const LOCAL_CHROME = ['http://localhost:*/*', 'http://127.0.0.1:*/*']
const LOCAL_FIREFOX = ['http://localhost/*', 'http://127.0.0.1/*'] // Firefox patterns can't name a port; this matches every port
const PAGES_RELEASE = '[/^https:\\/\\/beamhop\\.github\\.io\\/app\\//]'
const PAGES_DEV = '[/^https:\\/\\/beamhop\\.github\\.io\\/app\\//, /^http:\\/\\/localhost(:\\d+)?\\//, /^http:\\/\\/127\\.0\\.0\\.1(:\\d+)?\\//]'

const base = (matches, dev) => ({
  manifest_version: 3,
  name: dev ? 'Beamhop Companion (dev)' : 'Beamhop Companion',
  version,
  description: 'Lets Beamhop browser agents use your ChatGPT and GitHub Copilot plans and reach the web. Runs only on Beamhop pages.',
  icons: { 48: 'icon-48.png', 128: 'icon-128.png' },
  permissions: ['tabs', 'webNavigation', 'declarativeNetRequestWithHostAccess'],
  host_permissions: ['<all_urls>'],
  content_scripts: [{ matches, js: ['content.js'], run_at: 'document_start' }],
})
const chromium = (dev) => ({ ...base(dev ? [APP, ...LOCAL_CHROME] : [APP], dev), background: { service_worker: 'background.js' }, minimum_chrome_version: '116' })
const firefox = (dev) => {
  const b = base(dev ? [APP, ...LOCAL_FIREFOX] : [APP], dev)
  return {
    ...b,
    background: { scripts: ['background.js'] },
    permissions: [...b.permissions, 'webRequest', 'webRequestBlocking'],
    browser_specific_settings: { gecko: { id: dev ? 'companion-dev@beamhop.github.io' : 'companion@beamhop.github.io', strict_min_version: '128.0', data_collection_permissions: { required: ['none'] } } },
  }
}
// Only the release builds are zipped for download. The -dev builds are for local development and tests.
const targets = [
  { name: 'chromium', manifest: chromium(false), pages: PAGES_RELEASE, zip: 'beamhop-companion.zip' },
  { name: 'firefox', manifest: firefox(false), pages: PAGES_RELEASE, zip: 'beamhop-companion-firefox.zip' },
  { name: 'chromium-dev', manifest: chromium(true), pages: PAGES_DEV },
  { name: 'firefox-dev', manifest: firefox(true), pages: PAGES_DEV, zip: 'dev-firefox.zip' },
]
for (const t of targets) {
  const dir = join(out, t.name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(t.manifest, null, 2))
  copyFileSync(join(here, 'src', 'content.js'), join(dir, 'content.js'))
  const bg = readFileSync(join(here, 'src', 'background.js'), 'utf8')
  const marker = /const ALLOWED_PAGES = .*\/\*@ALLOWED_PAGES@\*\//
  if (!marker.test(bg)) throw new Error('ALLOWED_PAGES marker missing in background.js')
  writeFileSync(join(dir, 'background.js'), bg.replace(marker, `const ALLOWED_PAGES = ${t.pages}`))
  for (const f of ['icon-48.png', 'icon-128.png']) copyFileSync(join(here, 'static', f), join(dir, f))
  if (t.zip) execFileSync('zip', ['-qr', join(out, t.zip), '.'], { cwd: dir })
}
console.log('extension built', version)
