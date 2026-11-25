// Downloads the Linux image the browser machine boots (Alpine, about 4 MB) from the GitHub release of
// the pinned unkernel version, checks it against that release's distros.json (size and SHA-256), and
// puts it where the app serves it: packages/app/public/distros/alpine.erofs. Skips the download when
// the file is already there and matches.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'packages/app/package.json'))
const { version } = require('unkernel/package.json')
const name = process.argv[2] ?? 'alpine'
const out = join(root, 'packages/app/public/distros', `${name}.erofs`)
const base = `https://github.com/pithings/unkernel/releases/download/v${version}/`

const sha = (b) => createHash('sha256').update(b).digest('hex')
const get = async (url) => {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
      return Buffer.from(await r.arrayBuffer())
    } catch (e) {
      if (i >= 3) throw new Error(`Couldn't download ${url}: ${e.message}`)
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i))
    }
  }
}

const index = JSON.parse((await get(base + 'distros.json')).toString())
const d = index.distros.find((x) => x.name === name)
if (!d) throw new Error(`${name} is not in unkernel ${version}'s distros.json`)
if (existsSync(out)) {
  const cur = readFileSync(out)
  if (cur.length === d.size && sha(cur) === d.sha256) {
    console.log(`${name}.erofs is up to date (unkernel ${version})`)
    process.exit(0)
  }
}
const bytes = await get(base + d.file)
if (bytes.length !== d.size || sha(bytes) !== d.sha256) throw new Error(`${d.file}: size or SHA-256 doesn't match distros.json`)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, bytes)
console.log(`${name}.erofs: ${(bytes.length / 1048576).toFixed(1)} MB, unkernel ${version}`)
