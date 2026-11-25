// Assembles the `dist` branch: the web app at the root (served by GitHub Pages),
// the Companion extension zips in extension/, and the bridge for `npx github:beamhop/app#dist`.
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const out = join(root, 'out')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(join(root, 'packages/app/dist'), out, { recursive: true })
mkdirSync(join(out, 'extension'), { recursive: true })
for (const f of ['beamhop-companion.zip', 'beamhop-companion-firefox.zip']) cpSync(join(root, 'packages/extension/dist', f), join(out, 'extension', f))
mkdirSync(join(out, 'bridge'), { recursive: true })
cpSync(join(root, 'packages/bridge/dist/beamhop-agent.mjs'), join(out, 'bridge/beamhop-agent.mjs'))
const version = JSON.parse(readFileSync(join(root, 'packages/bridge/package.json'), 'utf8')).version
writeFileSync(
  join(out, 'package.json'),
  JSON.stringify({ name: 'beamhop-agent', version, private: true, type: 'module', bin: { 'beamhop-agent': 'bridge/beamhop-agent.mjs' }, engines: { node: '>=22.4' } }, null, 2),
)
writeFileSync(join(out, '.nojekyll'), '')
writeFileSync(
  join(out, 'README.md'),
  `# Beamhop build output\n\nGenerated from the main branch by GitHub Actions. Don't edit by hand.\n\n- Web app: served by GitHub Pages from this branch.\n- Companion extension: \`extension/beamhop-companion.zip\` (Chromium), \`extension/beamhop-companion-firefox.zip\`.\n- Bridge: \`npx -y github:beamhop/app#dist "<agent link>" --agent fx\`.\n`,
)
console.log('dist assembled in', out)
