// Bundles the Node proxy into one file: dist/beamhop-proxy.mjs.
import { build } from 'esbuild'
import { chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const outfile = join(here, 'dist/beamhop-proxy.mjs')
await build({
  entryPoints: [join(here, 'src/cli.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Nothing in tsconfig affects the bundle, and not reading it lets the Dockerfile build this
  // package without the repository root.
  tsconfigRaw: '{}',
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
})
await chmod(outfile, 0o755)
console.log('proxy built')
