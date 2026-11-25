// Image builder (Node only). Installs an npm package into a temporary directory, packs what npm wrote,
// unmodified, into a machine image, and adds the ES module compile cache: every ES module the entry point can
// reach is transformed ahead of time, so the worker never has to parse the harness's megabytes of source twice.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TRANSFORM_FINGERPRINT, transformEsm } from '../esm/transform.js'
import { Vfs } from '../kernel/vfs.js'
import { createResolver } from '../node/resolve.js'
import { encodeImage, imageFileName, type ImageInput } from './format.js'

/** Identifies the transformer build; part of every key in the on-disk transform cache. */
const TRANSFORM_VERSION = createHash('sha256').update(TRANSFORM_FINGERPRINT).digest('hex').slice(0, 12)

/** Not needed at run time and large: source maps and TypeScript declarations. Everything else is packed byte for byte. */
const EXCLUDE = [/\.map$/, /\.d\.[mc]?ts$/, /\.tsbuildinfo$/, /(^|\/)\.package-lock\.json$/]
const MAX_FILE_BYTES = 30 * 1024 * 1024

/** Node built-in module names, so the build-time resolver classifies specifiers as the worker's loader does. */
const BUILTINS = new Set(['assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'dns/promises', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'readline/promises', 'repl', 'stream', 'stream/consumers', 'stream/promises', 'stream/web', 'string_decoder', 'sys', 'timers', 'timers/promises', 'tls', 'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib', 'sqlite', 'test', 'sea'])

export interface BuildImageOptions {
  /** Image name: the output file is "<name>-<hash>.bhi". */
  name: string
  /** npm spec to install, e.g. "@scope/pkg@1.2.3". */
  spec: string
  /** Use an existing directory containing node_modules instead of installing (development aid). */
  fromDir?: string
  outDir: string
  cacheDir: string
  /** Extra entry points besides the package's "bin" scripts, relative to the image root. */
  entries?: string[]
  precompileDirs?: string[]
  precompileExtra?: string[]
  log?: (message: string) => void
}

export interface BuildImageResult {
  name: string
  file: string
  hash: string
  bytes: number
  payloadBytes: number
  files: number
  esmPrecompiled: number
  esmPrecompiledBytes: number
  excludedFiles: number
  transformMs: number
  failedTransforms: { file: string; error: string }[]
  unresolved: { from: string; spec: string }[]
  bin: Record<string, string>
  packageVersion: string
}

/** "@scope/name@1.2.3" -> "@scope/name" */
export function packageNameOf(spec: string): string {
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(0, at) : spec
}

export async function buildImage(opts: BuildImageOptions): Promise<BuildImageResult> {
  const log = opts.log ?? (() => {})
  let root = opts.fromDir
  let temp: string | null = null
  if (!root) {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-image-'))
    root = temp
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'bh-image-' + opts.name, private: true }))
    log(`npm install ${opts.spec}`)
    // Install scripts are skipped: they build native add-ons, which cannot load in the machine anyway.
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', opts.spec], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] })
  }
  try {
    return await pack(root, opts, log)
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true, force: true })
  }
}

async function pack(root: string, opts: BuildImageOptions, log: (m: string) => void): Promise<BuildImageResult> {
  const input: Required<Pick<ImageInput, 'dirs' | 'files' | 'links' | 'esm'>> = { dirs: [], files: [], links: [], esm: [] }
  let excluded = 0
  const walk = (dir: string, rel: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name)
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isSymbolicLink()) input.links.push({ path: r, target: fs.readlinkSync(abs) })
      else if (e.isDirectory()) {
        input.dirs.push(r)
        walk(abs, r)
      } else if (e.isFile()) {
        const st = fs.statSync(abs)
        if (EXCLUDE.some((re) => re.test(r)) || st.size > MAX_FILE_BYTES) {
          excluded++
          continue
        }
        input.files.push({ path: r, data: fs.readFileSync(abs), mode: st.mode & 0o777 })
      }
    }
  }
  if (!fs.existsSync(path.join(root, 'node_modules'))) throw new Error(`${root} has no node_modules`)
  input.dirs.push('node_modules')
  walk(path.join(root, 'node_modules'), 'node_modules')
  if (fs.existsSync(path.join(root, 'package.json'))) input.files.push({ path: 'package.json', data: fs.readFileSync(path.join(root, 'package.json')), mode: 0o644 })

  // The package's executables.
  const pkgName = packageNameOf(opts.spec)
  const pkgDir = 'node_modules/' + pkgName
  const pkg = JSON.parse(fs.readFileSync(path.join(root, pkgDir, 'package.json'), 'utf8')) as { version: string; bin?: string | Record<string, string> }
  const bin: Record<string, string> = {}
  const binField = typeof pkg.bin === 'string' ? { [pkgName.split('/').pop()!]: pkg.bin } : (pkg.bin ?? {})
  for (const [name, target] of Object.entries(binField)) bin[name] = path.posix.join(pkgDir, target)

  // Load the tree into a VFS and resolve with the worker's resolver, so the reachability trace follows
  // exactly the files the loader will ask for.
  const MOUNT = '/image'
  const vfs = new Vfs()
  for (const d of input.dirs) vfs.mkdir(`${MOUNT}/${d}`, { recursive: true })
  for (const f of input.files) vfs.writeFileDeep(`${MOUNT}/${f.path}`, f.data, { mode: f.mode })
  for (const l of input.links) {
    try {
      vfs.symlink(l.target, `${MOUNT}/${l.path}`)
    } catch {
      // a link whose parent was excluded
    }
  }
  const resolver = createResolver(
    {
      kind: (p) => {
        const k = vfs.kindOf(p)
        return k === 'symlink' ? null : k
      },
      readText: (p) => vfs.readText(p),
      realpath: (p) => vfs.realpath(p),
    },
    (id) => BUILTINS.has(id.startsWith('node:') ? id.slice(5) : id),
  )

  fs.mkdirSync(opts.cacheDir, { recursive: true })
  const compiled = new Map<string, Uint8Array>()
  const failed: { file: string; error: string }[] = []
  const unresolved: { from: string; spec: string }[] = []
  let transformMs = 0
  const queue: string[] = []
  const seen = new Set<string>()
  const enqueue = (file: string): void => {
    if (!seen.has(file)) {
      seen.add(file)
      queue.push(file)
    }
  }
  const isScript = (p: string): boolean => /\.m?js$/.test(p)
  for (const entry of [...Object.values(bin), ...(opts.entries ?? [])]) if (vfs.exists(`${MOUNT}/${entry}`)) enqueue(vfs.realpath(`${MOUNT}/${entry}`))
  for (const dir of opts.precompileDirs ?? []) for (const f of input.files) if (f.path.startsWith(dir + '/') && isScript(f.path)) enqueue(`${MOUNT}/${f.path}`)
  for (const source of opts.precompileExtra ?? []) {
    const re = new RegExp(source)
    for (const f of input.files) if (isScript(f.path) && re.test('/' + f.path)) enqueue(`${MOUNT}/${f.path}`)
  }
  while (queue.length > 0) {
    const file = queue.shift()!
    let format: string
    try {
      format = resolver.formatOf(file)
    } catch {
      continue
    }
    if (format !== 'esm') continue
    const source = vfs.readText(file)
    const key = createHash('sha256').update(`${TRANSFORM_VERSION}\0${source}`).digest('hex')
    const cacheFile = path.join(opts.cacheDir, key + '.json')
    let result: { code: string; deps: string[]; dynamicImports: string[] }
    if (fs.existsSync(cacheFile)) result = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    else {
      const t = performance.now()
      try {
        const r = transformEsm(source, file.slice(MOUNT.length + 1))
        result = { code: r.code, deps: r.deps, dynamicImports: r.dynamicImports }
      } catch (e) {
        failed.push({ file: file.slice(MOUNT.length + 1), error: e instanceof Error ? e.message : String(e) })
        continue
      }
      transformMs += performance.now() - t
      fs.writeFileSync(cacheFile, JSON.stringify(result))
    }
    compiled.set(file, new TextEncoder().encode(result.code))
    for (const spec of [...result.deps, ...result.dynamicImports]) {
      try {
        const r = resolver.resolve(spec, file, true, MOUNT)
        if (r.file) enqueue(r.file)
      } catch {
        unresolved.push({ from: file.slice(MOUNT.length + 1), spec })
      }
    }
  }
  let esmBytes = 0
  for (const [file, code] of compiled) {
    input.esm.push({ path: file.slice(MOUNT.length + 1), code })
    esmBytes += code.byteLength
  }

  const meta = { name: opts.name, spec: opts.spec, package: pkgName, version: pkg.version, bin, builtAt: new Date().toISOString(), transformVersion: TRANSFORM_VERSION }
  // The build time is recorded in images.json and kept out of the image, so identical inputs give an identical hash.
  const manifestFile = path.join(opts.outDir, 'images.json')
  fs.mkdirSync(opts.outDir, { recursive: true })
  const manifest: Record<string, BuildImageResult & { builtAt?: string }> = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {}
  const { bytes, hash } = await encodeImage({ meta: { ...meta, builtAt: undefined }, ...input })
  const previous = manifest[opts.name]
  if (previous && previous.hash === hash && fs.existsSync(path.join(opts.outDir, previous.file))) {
    log(`${opts.name}: unchanged (${previous.file})`)
    return previous
  }
  const file = imageFileName(opts.name, hash)
  fs.writeFileSync(path.join(opts.outDir, file), bytes)
  if (previous && previous.file !== file) fs.rmSync(path.join(opts.outDir, previous.file), { force: true })
  const result: BuildImageResult = {
    name: opts.name, file, hash, bytes: bytes.byteLength, payloadBytes: input.files.reduce((n, f) => n + f.data.byteLength, 0) + esmBytes, files: input.files.length,
    esmPrecompiled: compiled.size, esmPrecompiledBytes: esmBytes, excludedFiles: excluded, transformMs: Math.round(transformMs), failedTransforms: failed,
    unresolved: unresolved.slice(0, 50), bin, packageVersion: pkg.version,
  }
  manifest[opts.name] = { ...result, builtAt: meta.builtAt }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1))
  log(`${opts.name}: ${result.files} files, ${(result.payloadBytes / 1e6).toFixed(1)} MB (${(result.bytes / 1e6).toFixed(1)} MB packed), ${result.esmPrecompiled} ES modules precompiled in ${result.transformMs} ms -> ${file}`)
  return result
}
