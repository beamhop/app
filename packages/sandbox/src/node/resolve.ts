// Node's module resolution algorithm (CommonJS and ESM flavours) over a minimal file system view.
// Pure and synchronous: the worker's loader and the image builder's reachability trace share it.
import { dirname, normalize } from '../kernel/path.js'

export interface ResolverFs {
  /** 'file' | 'dir' for an existing path (symlinks followed), null otherwise. */
  kind(path: string): 'file' | 'dir' | null
  readText(path: string): string
  realpath(path: string): string
}

export type Resolution = { builtin: string; file?: undefined } | { file: string; builtin?: undefined }
export type ModuleFormat = 'esm' | 'cjs' | 'json' | 'addon' | 'wasm'

export interface PackageJson {
  name?: string
  type?: string
  main?: string
  exports?: unknown
  imports?: unknown
  [key: string]: unknown
}

export class ResolveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const EXTENSIONS = ['.js', '.json', '.node', '.cjs', '.mjs']
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const join = (dir: string, rel: string): string => normalize(dir + '/' + rel)

export function nodeModulePaths(dir: string): string[] {
  const out: string[] = []
  for (let d = dir; ; d = dirname(d)) {
    if (!d.endsWith('/node_modules')) out.push((d === '/' ? '' : d) + '/node_modules')
    if (d === '/') break
  }
  return out
}

/** One entry of an "exports"/"imports" map, narrowed by conditions. */
function resolveTarget(target: unknown, conditions: string[], match?: string): string | null {
  if (typeof target === 'string') return match != null ? target.replace(/\*/g, match) : target
  if (Array.isArray(target)) {
    for (const t of target) {
      const r = resolveTarget(t, conditions, match)
      if (r) return r
    }
    return null
  }
  if (target && typeof target === 'object') {
    for (const [key, value] of Object.entries(target)) {
      if (key === 'default' || conditions.includes(key)) {
        const r = resolveTarget(value, conditions, match)
        if (r) return r
      }
    }
  }
  return null
}

export function resolveExportsMap(map: unknown, subpath: string, conditions: string[]): string | null {
  // Sugar: a bare target or a conditions object stands for { ".": … }.
  if (typeof map === 'string' || Array.isArray(map) || (map && typeof map === 'object' && !Object.keys(map).some((k) => k.startsWith('.') || k.startsWith('#')))) map = { '.': map }
  const table = map as Record<string, unknown>
  if (own(table, subpath)) return resolveTarget(table[subpath], conditions)
  let best: string | null = null
  let bestMatch = ''
  for (const key of Object.keys(table)) {
    const star = key.indexOf('*')
    if (star === -1) {
      // Legacy directory mapping: "./lib/": "./src/"
      if (key.endsWith('/') && subpath.startsWith(key) && (!best || key.length > best.length)) {
        best = key
        bestMatch = subpath.slice(key.length)
      }
      continue
    }
    const pre = key.slice(0, star)
    const post = key.slice(star + 1)
    if (subpath.startsWith(pre) && subpath.endsWith(post) && subpath.length >= key.length - 1 && (!best || pre.length > best.indexOf('*'))) {
      best = key
      bestMatch = subpath.slice(pre.length, subpath.length - post.length)
    }
  }
  if (!best) return null
  if (best.endsWith('/')) {
    const t = resolveTarget(table[best], conditions)
    return t ? t + bestMatch : null
  }
  return resolveTarget(table[best], conditions, bestMatch)
}

export interface Resolver {
  resolve(spec: string, parent: string | undefined, isImport: boolean, cwd: string): Resolution
  /** How a file is to be loaded. `isPrecompiledEsm` settles ambiguous `.js` files the image builder already classified. */
  formatOf(file: string, isPrecompiledEsm?: boolean): ModuleFormat
  findPackageScope(file: string): { dir: string; pkg: PackageJson } | null
  /** Forget what was read from a package.json (it changed). */
  invalidate(path: string): void
}

export function createResolver(fs: ResolverFs, isBuiltin: (id: string) => boolean): Resolver {
  const pkgCache = new Map<string, PackageJson | null>()
  const formatCache = new Map<string, ModuleFormat>()

  function readPackage(dir: string): PackageJson | null {
    const file = (dir === '/' ? '' : dir) + '/package.json'
    const cached = pkgCache.get(file)
    if (cached !== undefined) return cached
    let pkg: PackageJson | null = null
    if (fs.kind(file) === 'file') {
      try {
        pkg = JSON.parse(fs.readText(file)) as PackageJson
      } catch {
        pkg = {}
      }
    }
    pkgCache.set(file, pkg)
    return pkg
  }
  function findPackageScope(file: string): { dir: string; pkg: PackageJson } | null {
    for (let dir = dirname(file); ; dir = dirname(dir)) {
      const pkg = readPackage(dir)
      if (pkg) return { dir, pkg }
      if (dir === '/' || dir.endsWith('/node_modules')) return null
    }
  }
  const tryFile = (p: string): string | null => {
    if (fs.kind(p) === 'file') return p
    for (const ext of EXTENSIONS) if (fs.kind(p + ext) === 'file') return p + ext
    return null
  }
  const tryDir = (p: string): string | null => {
    if (fs.kind(p) !== 'dir') return null
    const pkg = readPackage(p)
    if (pkg && typeof pkg.main === 'string') {
      const m = tryFile(join(p, pkg.main)) || tryFile(join(p, pkg.main + '/index'))
      if (m) return m
    }
    return tryFile(p + '/index')
  }
  const notFound = (spec: string, parent: string | undefined, extra = ''): ResolveError =>
    new ResolveError('MODULE_NOT_FOUND', `Cannot find module '${spec}'${extra}\nRequire stack:\n- ${parent ?? '<entry>'}`)

  function resolve(spec: string, parent: string | undefined, isImport: boolean, cwd: string): Resolution {
    if (isBuiltin(spec)) return { builtin: spec }
    if (spec.startsWith('node:')) throw new ResolveError('ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${spec}`)
    const conditions = isImport ? ['node', 'import', 'module-sync', 'node-addons'] : ['node', 'require', 'module-sync', 'node-addons']
    if (spec.startsWith('file:')) spec = decodeURIComponent(new URL(spec).pathname)
    const parentDir = parent ? dirname(parent) : cwd
    if (spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
      const abs = spec.startsWith('/') ? normalize(spec) : join(parentDir, spec)
      const r = tryFile(abs) || tryDir(abs)
      if (!r) throw notFound(spec, parent)
      return { file: fs.realpath(r) }
    }
    if (spec.startsWith('#')) {
      const scope = parent ? findPackageScope(parent) : null
      const target = scope && scope.pkg.imports ? resolveExportsMap(scope.pkg.imports, spec, conditions) : null
      if (!scope || !target) throw notFound(spec, parent, ' (package imports)')
      if (!target.startsWith('.')) return resolve(target, parent, isImport, cwd)
      const file = join(scope.dir, target)
      if (fs.kind(file) !== 'file') throw notFound(spec, parent, ` (imports target ${file} missing)`)
      return { file: fs.realpath(file) }
    }
    const parts = spec.split('/')
    const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    const sub = '.' + spec.slice(pkgName.length)
    const candidates: string[] = []
    // A package may import itself by name when it has "exports".
    const scope = parent ? findPackageScope(parent) : null
    if (scope && scope.pkg.name === pkgName && scope.pkg.exports) candidates.push(scope.dir)
    for (const dir of nodeModulePaths(parentDir)) candidates.push(dir + '/' + pkgName)
    for (const pkgDir of candidates) {
      if (fs.kind(pkgDir) !== 'dir') continue
      const pkg = readPackage(pkgDir) ?? {}
      if (pkg.exports != null) {
        const target = resolveExportsMap(pkg.exports, sub, conditions)
        if (!target) throw new ResolveError('ERR_PACKAGE_PATH_NOT_EXPORTED', `Package subpath '${sub}' is not defined by "exports" in ${pkgDir}/package.json (imported from ${parent ?? '<entry>'})`)
        const file = join(pkgDir, target)
        if (fs.kind(file) !== 'file') throw notFound(spec, parent, ` (exports target ${file} missing)`)
        return { file: fs.realpath(file) }
      }
      const abs = sub === '.' ? pkgDir : join(pkgDir, sub)
      const r = (sub === '.' ? null : tryFile(abs)) || tryDir(abs)
      if (r) return { file: fs.realpath(r) }
    }
    throw notFound(spec, parent)
  }

  /**
   * For a `.js` file whose package does not say: Node tries CommonJS first and switches to ESM when the source
   * only parses as a module. Same here: a cheap text test picks candidates, compiling as a function body decides.
   */
  function looksLikeEsm(file: string): boolean {
    const src = fs.readText(file)
    if (!/^\s*(?:import\s*(?:[\w${*]|['"])|export\s*(?:[\w${*]|default\b))/m.test(src)) return false
    try {
      // Compile only; nothing runs. This is why the machine's CSP needs 'unsafe-eval' even before a module is evaluated.
      new Function('exports', 'require', 'module', '__filename', '__dirname', src.startsWith('#!') ? '//' + src : src)
      return false
    } catch (e) {
      return e instanceof SyntaxError
    }
  }
  function formatOf(file: string, isPrecompiledEsm = false): ModuleFormat {
    if (file.endsWith('.mjs')) return 'esm'
    if (file.endsWith('.cjs')) return 'cjs'
    if (file.endsWith('.json')) return 'json'
    if (file.endsWith('.node')) return 'addon'
    if (file.endsWith('.wasm')) return 'wasm'
    const scope = findPackageScope(file)
    if (scope && scope.pkg.type === 'module') return 'esm'
    if (scope && scope.pkg.type === 'commonjs') return 'cjs'
    if (isPrecompiledEsm) return 'esm'
    let format = formatCache.get(file)
    if (!format) {
      format = looksLikeEsm(file) ? 'esm' : 'cjs'
      formatCache.set(file, format)
    }
    return format
  }

  return {
    resolve,
    formatOf,
    findPackageScope,
    invalidate(path) {
      pkgCache.delete(path)
      formatCache.delete(path)
    },
  }
}
