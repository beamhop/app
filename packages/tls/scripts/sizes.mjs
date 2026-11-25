// Prints the shipped sizes: minified + gzip (and brotli) of the client, the wasm and the root store.
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const pkg = fileURLToPath(new URL('..', import.meta.url))
const r = await build({ entryPoints: { tls: pkg + 'src/index.ts', tunnel: pkg + 'src/tunnel.ts' }, bundle: true, splitting: true, minify: true, format: 'esm', target: 'es2022', outdir: 'out', write: false })
const rows = r.outputFiles.map((f) => {
  const name = f.path.split('/').pop()
  const label = name.startsWith('tls') ? 'client JS (index + wasm glue)' : name.startsWith('tunnel') ? 'tunnel transport JS' : name.startsWith('mozilla-roots') ? 'Mozilla root store chunk (lazy)' : `shared chunk ${name}`
  return [label, Buffer.from(f.contents)]
})
rows.push(['TLS engine wasm', readFileSync(pkg + 'src/generated/beamhop_tls_wasm_bg.wasm')])
for (const [label, buf] of rows) console.log(`${label.padEnd(34)} ${String(buf.length).padStart(8)} B   gzip ${String(gzipSync(buf, { level: 9 }).length).padStart(7)} B   brotli ${String(brotliCompressSync(buf).length).padStart(7)} B`)
