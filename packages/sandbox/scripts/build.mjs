// Builds two things:
//   dist/site/  the static site for a machine origin: machine.html, frame.js, worker.js, esm-transform.js
//   dist/lib/   the library the app imports: index.js (client + protocol + harness registry), ESM
// Images are built separately (scripts/build-image.mjs) and served from the same origin as dist/site.
import { build } from 'esbuild'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const site = join(here, 'dist/site')
const lib = join(here, 'dist/lib')
rmSync(join(here, 'dist'), { recursive: true, force: true })
mkdirSync(site, { recursive: true })
const minify = !process.argv.includes('--no-minify')
const common = { bundle: true, target: 'es2022', logLevel: 'warning', legalComments: 'none', minify }

// The worker: kernel + Node layer + shell. A classic script so it can importScripts() the transformer synchronously.
const shim = join(here, 'src/node/process-shim.ts')
const worker = await build({
  ...common,
  entryPoints: [join(here, 'src/frame/worker.ts')],
  outfile: join(site, 'worker.js'),
  format: 'iife',
  platform: 'browser',
  metafile: true,
  // Identifier names are part of the Node layer's behaviour (class names show up in guest-visible output).
  keepNames: true,
  define: { global: 'globalThis' },
  inject: [join(here, 'src/node/inject-process.ts')],
  plugins: [
    {
      name: 'machine-aliases',
      setup(b) {
        // readable-stream and friends import the `process` package; they get the layer's shim instead.
        b.onResolve({ filter: /^process\/?$/ }, () => ({ path: shim }))
        b.onResolve({ filter: /^node:zlib$/ }, () => ({ path: join(here, 'src/kernel/programs/zlib-for-shell.ts') }))
      },
    },
  ],
})
await build({ ...common, entryPoints: [join(here, 'src/esm/worker-entry.ts')], outfile: join(site, 'esm-transform.js'), format: 'iife', platform: 'browser' })
await build({ ...common, entryPoints: [join(here, 'src/frame/frame.ts')], outfile: join(site, 'frame.js'), format: 'iife', platform: 'browser' })
copyFileSync(join(here, 'src/frame/machine.html'), join(site, 'machine.html'))
await build({ ...common, minify: false, entryPoints: [join(here, 'src/index.ts')], outfile: join(lib, 'index.js'), format: 'esm', platform: 'browser' })

const size = (file) => {
  const data = readFileSync(file)
  return { bytes: data.length, gzip: gzipSync(data).length }
}
const byPackage = {}
for (const [file, info] of Object.entries(worker.metafile.inputs)) {
  const m = file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)
  const key = m ? m[1] : '(this package)'
  byPackage[key] = (byPackage[key] ?? 0) + info.bytes
}
const manifest = {
  site: { 'worker.js': size(join(site, 'worker.js')), 'esm-transform.js': size(join(site, 'esm-transform.js')), 'frame.js': size(join(site, 'frame.js')), 'machine.html': size(join(site, 'machine.html')) },
  lib: { 'index.js': size(join(lib, 'index.js')) },
  workerInputBytesByPackage: Object.fromEntries(Object.entries(byPackage).sort((a, b) => b[1] - a[1])),
}
writeFileSync(join(here, 'dist/build-manifest.json'), JSON.stringify(manifest, null, 1))
const kb = (s) => `${(s.bytes / 1024).toFixed(0)} KB (${(s.gzip / 1024).toFixed(0)} KB gzip)`
console.log(`sandbox built: worker.js ${kb(manifest.site['worker.js'])}, esm-transform.js ${kb(manifest.site['esm-transform.js'])}, frame.js ${kb(manifest.site['frame.js'])}, lib/index.js ${kb(manifest.lib['index.js'])}`)
