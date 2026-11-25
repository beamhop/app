// Bundles the bridge into one file for `npx github:beamhop/app#dist`.
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
await build({
  entryPoints: [join(here, 'src/cli.ts')],
  outfile: join(here, 'dist/beamhop-agent.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
})
console.log('bridge built')
