#!/usr/bin/env node
// Build a machine image from an npm package.
//
//   node scripts/build-image.mjs pi                      a harness from src/harness (pinned spec, known entry)
//   node scripts/build-image.mjs --spec left-pad@1.3.0 --name left-pad
//   options: --out <dir> (default ./images)  --from <dir containing node_modules> (skip npm install)
//
// Images are build outputs: content-addressed "<name>-<hash>.bhi" files plus images.json, never committed.
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const { values, positionals } = parseArgs({ allowPositionals: true, options: { spec: { type: 'string' }, name: { type: 'string' }, out: { type: 'string' }, from: { type: 'string' } } })

// The builder is TypeScript and shares the transformer and resolver with the worker; bundle it for Node on the fly.
const bundle = join(here, '.cache/build-image.mjs')
await build({
  stdin: { contents: `export { buildImage } from './src/image/builder.ts'\nexport { harnesses } from './src/harness/index.ts'`, resolveDir: here, loader: 'ts' },
  outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
})
const { buildImage, harnesses } = await import(pathToFileURL(bundle).href + '?' + Date.now())

const jobs = []
if (values.spec) jobs.push({ name: values.name ?? values.spec.replace(/^@/, '').replace(/[/@].*$/, ''), spec: values.spec })
for (const name of positionals) {
  const h = harnesses[name]
  if (!h) {
    console.error(`unknown harness "${name}" (known: ${Object.keys(harnesses).join(', ')}); use --spec for any npm package`)
    process.exit(2)
  }
  jobs.push({ name: h.image, spec: h.npmSpec, entries: [h.entry], precompileDirs: h.precompileDirs, precompileExtra: h.precompileExtra })
}
if (jobs.length === 0) {
  console.error('usage: build-image.mjs <harness>... | --spec <npm spec> [--name <image name>] [--out <dir>] [--from <dir>]')
  process.exit(2)
}
if (values.from && !existsSync(join(values.from, 'node_modules'))) {
  console.error(`--from ${values.from}: no node_modules there`)
  process.exit(2)
}
for (const job of jobs) {
  const r = await buildImage({ ...job, fromDir: values.from && resolve(values.from), outDir: resolve(values.out ?? join(here, 'images')), cacheDir: join(here, '.cache/esm'), log: (m) => console.error('[image] ' + m) })
  if (r.failedTransforms.length) console.error(`[image] ${r.failedTransforms.length} ES modules could not be precompiled (the worker will transform them on demand, or fail the same way):`, r.failedTransforms.slice(0, 5))
  console.log(JSON.stringify({ name: r.name, file: r.file, hash: r.hash, bytes: r.bytes, payloadBytes: r.payloadBytes, files: r.files, esmPrecompiled: r.esmPrecompiled, transformMs: r.transformMs }))
}
