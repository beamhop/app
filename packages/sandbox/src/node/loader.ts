// CommonJS and ES module loader for one Node process.
// CommonJS files run as-is inside the classic function wrapper. ES modules run in System.register form: taken
// from the image's compile cache when the builder precompiled the file, otherwise produced on demand by the
// in-worker transformer (src/esm/transform.ts). This file implements the linking protocol for that form:
// live bindings, cycles, top-level await, dynamic import, import.meta, require(esm), ESM importing CJS/JSON/built-ins.
import { dirname } from '../kernel/path.js'
import type { Vfs } from '../kernel/vfs.js'
import type { TransformResult } from '../esm/transform.js'
import { createResolver, type ModuleFormat, nodeModulePaths, type Resolution, ResolveError } from './resolve.js'
import type { Dyn, ProcessCore } from './types.js'

export type EsmTransform = (source: string, filename: string) => TransformResult

export interface LoaderDeps {
  vfs: Vfs
  core: ProcessCore
  /** Built-in modules by bare name ('fs', 'stream/promises', ...). A function value marked `lazy` is called on first use. */
  builtins: Record<string, Dyn>
  /** Evaluate source text in the global scope and return its completion value (indirect eval). */
  evaluate(code: string, file: string): Dyn
  /** Identifiers every module sees as if they were globals: `process`, `Buffer`, timers, `globalThis`, ... */
  scope: { names: string[]; values: Dyn[] }
  /** Precompiled ES modules from mounted images: absolute source path -> System.register code. */
  esmCache: Map<string, Uint8Array>
  /** Returns the fallback transformer, loading it on first use. Synchronous, so `require()` of an ES module works. */
  loadTransformer(): EsmTransform
}

export interface LoaderStats {
  cjs: number
  esm: number
  json: number
  evalMs: number
  evalBytes: number
  /** ES modules that had no precompiled form and went through the in-worker transformer. */
  transformed: number
  transformMs: number
  transformBytes: number
}

const enum State { New, Linked, Executing, Done, Failed }

interface ModuleRecord {
  kind: 'esm' | 'cjs' | 'builtin'
  file: string
  ns: Dyn
  state: State
  deps: string[]
  depRecs: ModuleRecord[]
  setters: (((ns: Dyn) => void) | undefined)[]
  execute: (() => Dyn) | null
  importers: ((ns: Dyn) => void)[]
  error: unknown
  promise: Promise<void> | null
}

const decoder = new TextDecoder()
const lazy = <T>(fn: () => T): (() => T) & { lazy: true } => Object.assign(fn, { lazy: true as const })
export { lazy as lazyBuiltin }

const fileUrlToPath = (spec: string): string => decodeURIComponent(new URL(spec).pathname)

export function createLoader({ vfs, core, builtins, evaluate, scope, esmCache, loadTransformer }: LoaderDeps) {
  const { process, track } = core
  const cjsCache: Record<string, Dyn> = Object.create(null)
  const esmRecords = new Map<string, ModuleRecord>()
  const synthetic = new Map<string, ModuleRecord>()
  const stats: LoaderStats = { cjs: 0, esm: 0, json: 0, evalMs: 0, evalBytes: 0, transformed: 0, transformMs: 0, transformBytes: 0 }
  const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

  const bare = (id: string): string => (id.startsWith('node:') ? id.slice(5) : id)
  const isBuiltin = (id: string): boolean => has(builtins, bare(id))
  function getBuiltin(id: string): Dyn {
    const name = bare(id)
    if (!has(builtins, name)) return undefined
    let v = builtins[name]
    if (typeof v === 'function' && v.lazy === true) builtins[name] = v = v()
    return v
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
    isBuiltin,
  )
  // A package.json or script rewritten at run time must not be served from a cache.
  const unwatch = vfs.watch((path) => resolver.invalidate(path))
  core.kproc.exited.then(unwatch, unwatch)

  function resolve(spec: string, parent: string | undefined, isImport: boolean): Resolution {
    try {
      return resolver.resolve(spec, parent, isImport, process.cwd())
    } catch (e) {
      if (e instanceof ResolveError) {
        if (e.code === 'ERR_UNKNOWN_BUILTIN_MODULE') track('unknown-builtin', spec)
        throw Object.assign(new Error(e.message), { code: e.code })
      }
      throw e
    }
  }
  const formatOf = (file: string): ModuleFormat => resolver.formatOf(file, esmCache.has(file))

  function timedEval(code: string, file: string): Dyn {
    const t = performance.now()
    try {
      return evaluate(code, file)
    } finally {
      stats.evalMs += performance.now() - t
      stats.evalBytes += code.length
    }
  }
  const scopeParams = scope.names.join(', ')

  // ---------------------------------------------------------------- CommonJS

  class Module {
    id: string
    filename: string
    path: string
    exports: Dyn = {}
    loaded = false
    children: Module[] = []
    parent: Module | null
    paths: string[]
    constructor(id: string, parent?: Module | null) {
      this.id = id
      this.filename = id
      this.path = dirname(id)
      this.parent = parent ?? null
      this.paths = nodeModulePaths(this.path)
    }
    require(spec: string): Dyn {
      return makeRequire(this)(spec)
    }
  }
  let mainModule: Module | null = null

  const dynamicImportFrom = (parentFile: string) => (spec: Dyn) => new Promise<void>((res) => res()).then(() => importModule(String(spec), parentFile))

  function makeRequire(mod: Module): Dyn {
    const require = (spec: Dyn): Dyn => {
      if (typeof spec !== 'string') throw Object.assign(new TypeError('The "id" argument must be of type string. Received ' + typeof spec), { code: 'ERR_INVALID_ARG_TYPE' })
      const r = resolve(spec, mod.filename, false)
      return r.builtin !== undefined ? getBuiltin(r.builtin) : loadFile(r.file, mod)
    }
    require.resolve = Object.assign(
      (spec: string) => {
        const r = resolve(spec, mod.filename, false)
        return r.builtin ?? r.file
      },
      { paths: () => nodeModulePaths(mod.path) },
    )
    require.cache = cjsCache
    require.main = mainModule
    require.extensions = { '.js': () => {}, '.json': () => {}, '.node': () => {} }
    return require
  }

  function loadFile(file: string, parent: Module | null, main?: Module): Dyn {
    const cached = cjsCache[file]
    if (cached) return cached.exports
    const format = formatOf(file)
    if (format === 'esm') {
      const rec = loadEsm(file)
      const pending = execute(rec, new Set())
      if (pending) {
        pending.catch(() => {})
        throw Object.assign(new Error(`require() cannot be used on an ESM graph with top-level await: ${file}`), { code: 'ERR_REQUIRE_ASYNC_MODULE' })
      }
      return 'module.exports' in rec.ns ? rec.ns['module.exports'] : rec.ns
    }
    if (format === 'addon') {
      track('native-addon', file)
      throw Object.assign(new Error(`Cannot load a native addon in the machine: ${file}`), { code: 'ERR_DLOPEN_FAILED' })
    }
    const mod = main ?? new Module(file, parent)
    cjsCache[file] = mod
    if (parent) parent.children.push(mod)
    try {
      if (format === 'json') {
        stats.json++
        mod.exports = JSON.parse(vfs.readText(file))
      } else {
        stats.cjs++
        let src = vfs.readText(file)
        if (src.startsWith('#!')) src = '//' + src
        // The one textual rewrite: `import(` cannot appear in evaluated script text that should reach this loader.
        if (src.includes('import(')) src = src.replace(/(^|[^.\w$])import\s*\(/g, '$1__dynamicImport(')
        const fn = timedEval(`(function (exports, require, module, __filename, __dirname, __dynamicImport, ${scopeParams}) {${src}\n})`, file)
        fn.call(mod.exports, mod.exports, makeRequire(mod), mod, file, dirname(file), dynamicImportFrom(file), ...scope.values)
      }
      mod.loaded = true
    } catch (e) {
      delete cjsCache[file]
      throw e
    }
    return mod.exports
  }

  // ---------------------------------------------------------------- ES modules

  function makeNamespace(): Dyn {
    const ns = Object.create(null)
    Object.defineProperty(ns, Symbol.toStringTag, { value: 'Module' })
    return ns
  }
  /** Namespace for a CommonJS or built-in module: `default` is the exports object, named exports are its properties. */
  function syntheticNamespace(value: Dyn): Dyn {
    const ns = makeNamespace()
    if (value != null && (typeof value === 'object' || typeof value === 'function')) {
      const copy = (key: string): void => {
        if (key === 'default' || key in ns) return
        try {
          ns[key] = value[key]
        } catch {
          // a throwing getter is simply not a named export
        }
      }
      for (const key in value) copy(key)
      // Built-ins whose export object is a function (events, stream) keep statics on non-enumerable or inherited properties.
      for (const key of Object.getOwnPropertyNames(value)) if (!['length', 'name', 'prototype', 'caller', 'arguments'].includes(key)) copy(key)
    }
    ns.default = value
    return ns
  }

  /** System.register source for a file: the image's precompiled form, or the transformer's. */
  const transformed = new Map<string, { mtimeMs: number; size: number; code: string }>()
  /** Source text that exists only in memory (node -e with --input-type=module). */
  const virtual = new Map<string, string>()
  function registerSource(file: string): string {
    const inline = virtual.get(file)
    if (inline !== undefined) return loadTransformer()(inline, file).code
    const precompiled = esmCache.get(file)
    if (precompiled) return decoder.decode(precompiled)
    const st = vfs.stat(file)
    const hit = transformed.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.code
    const source = vfs.readText(file)
    const t = performance.now()
    const { code } = loadTransformer()(source, file)
    stats.transformed++
    stats.transformMs += performance.now() - t
    stats.transformBytes += source.length
    transformed.set(file, { mtimeMs: st.mtimeMs, size: st.size, code })
    return code
  }

  function loadEsm(file: string): ModuleRecord {
    const existing = esmRecords.get(file)
    if (existing) return existing
    stats.esm++
    const code = registerSource(file)
    const rec: ModuleRecord = { kind: 'esm', file, ns: makeNamespace(), state: State.New, deps: [], depRecs: [], setters: [], execute: null, importers: [], error: null, promise: null }
    esmRecords.set(file, rec)
    const url = 'file://' + file
    const meta = {
      url,
      filename: file,
      dirname: dirname(file),
      main: false,
      resolve: (spec: string) => {
        const r = resolve(spec, file, true)
        return r.builtin !== undefined ? 'node:' + bare(r.builtin) : 'file://' + r.file
      },
    }
    const exportFn = (name: Dyn, value?: Dyn): Dyn => {
      if (typeof name === 'object' && name !== null) for (const k of Object.keys(name)) rec.ns[k] = name[k]
      else rec.ns[name] = value
      for (const notify of rec.importers) notify(rec.ns)
      return value
    }
    const context = { id: url, meta, import: (spec: Dyn) => dynamicImportFrom(file)(spec) }
    let declared = false
    const System = {
      register(deps: string[], declare: (exp: Dyn, ctx: Dyn) => { setters?: Dyn[]; execute?: () => Dyn }) {
        declared = true
        rec.deps = deps
        const d = declare(exportFn, context)
        rec.setters = d.setters ?? []
        rec.execute = d.execute ?? (() => {})
      },
    }
    try {
      // `require` is not defined in ES modules; code that needs it calls createRequire.
      const fn = timedEval(`(function (System, ${scopeParams}) {${code}\n})`, file)
      fn.call(undefined, System, ...scope.values)
      if (!declared) throw new Error('ES module code did not call System.register: ' + file)
      rec.state = State.Linked
      rec.depRecs = rec.deps.map((spec, i) => {
        const r = resolve(spec, file, true)
        const dep = r.builtin !== undefined ? builtinRecord(r.builtin) : formatOf(r.file) === 'esm' ? loadEsm(r.file) : cjsRecord(r.file)
        const setter = rec.setters[i]
        if (dep.kind === 'esm' && setter) {
          dep.importers.push(setter)
          setter(dep.ns)
        }
        return dep
      })
    } catch (e) {
      esmRecords.delete(file)
      throw e
    }
    return rec
  }
  function builtinRecord(id: string): ModuleRecord {
    const key = 'builtin:' + bare(id)
    let rec = synthetic.get(key)
    if (!rec) synthetic.set(key, (rec = { kind: 'builtin', file: key, ns: syntheticNamespace(getBuiltin(id)), state: State.Done, deps: [], depRecs: [], setters: [], execute: null, importers: [], error: null, promise: null }))
    return rec
  }
  function cjsRecord(file: string): ModuleRecord {
    let rec = synthetic.get(file)
    if (!rec) synthetic.set(file, (rec = { kind: 'cjs', file, ns: null, state: State.Linked, deps: [], depRecs: [], setters: [], execute: null, importers: [], error: null, promise: null }))
    return rec
  }

  /** Evaluate a module graph depth-first. Returns undefined when it finished synchronously, or a promise (top-level await). */
  function execute(rec: ModuleRecord, stack: Set<ModuleRecord>): Promise<void> | undefined {
    if (rec.state === State.Done) return undefined
    if (rec.state === State.Failed) throw rec.error
    if (rec.kind === 'cjs') {
      rec.ns = syntheticNamespace(loadFile(rec.file, null))
      rec.state = State.Done
      return undefined
    }
    // Already running: a cycle through the current stack continues; anything else waits for the run in progress.
    if (rec.state === State.Executing) return stack.has(rec) ? undefined : (rec.promise ?? undefined)
    rec.state = State.Executing
    stack.add(rec)
    let i = 0
    const fail = (e: unknown): never => {
      rec.state = State.Failed
      rec.error = e
      throw e
    }
    const step = (): Promise<void> | undefined => {
      while (i < rec.depRecs.length) {
        const index = i++
        const dep = rec.depRecs[index]
        const pending = execute(dep, stack)
        const bind = (): void => {
          const setter = rec.setters[index]
          if (setter && dep.ns) setter(dep.ns)
        }
        if (pending) return pending.then(() => (bind(), step()))
        bind()
      }
      const result = rec.execute!.call(undefined)
      if (result && typeof result.then === 'function') return result.then(() => void (rec.state = State.Done))
      rec.state = State.Done
      return undefined
    }
    let pending: Promise<void> | undefined
    try {
      pending = step()
    } catch (e) {
      fail(e)
    }
    if (!pending) return undefined
    rec.promise = pending.then(() => void (rec.promise = null), fail)
    return rec.promise
  }

  function importModule(spec: string, parentFile: string | undefined): Promise<Dyn> {
    const r = resolve(spec, parentFile, true)
    if (r.builtin !== undefined) return Promise.resolve(builtinRecord(r.builtin).ns)
    if (formatOf(r.file) !== 'esm') {
      const rec = cjsRecord(r.file)
      execute(rec, new Set())
      return Promise.resolve(rec.ns)
    }
    const rec = loadEsm(r.file)
    const pending = execute(rec, new Set())
    return pending ? pending.then(() => rec.ns) : Promise.resolve(rec.ns)
  }

  // ---------------------------------------------------------------- node:module

  function createRequire(from: Dyn): Dyn {
    let file = String(from)
    if (file.startsWith('file:')) file = fileUrlToPath(file)
    return makeRequire(new Module(file, null))
  }
  const moduleBuiltin: Dyn = Object.assign(Module, {
    Module,
    createRequire,
    isBuiltin,
    builtinModules: Object.keys(builtins).filter((k) => !k.startsWith('_')),
    enableCompileCache: () => ({ status: 3 /* DISABLED */ }),
    getCompileCacheDir: () => undefined,
    flushCompileCache: () => {},
    constants: { compileCacheStatus: { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 } },
    register: () => track('module.register'),
    registerHooks: () => {
      track('module.registerHooks')
      return { deregister() {} }
    },
    syncBuiltinESMExports: () => {},
    findSourceMap: () => undefined,
    SourceMap: class SourceMap {},
    findPackageJSON: (_spec: Dyn, base: Dyn) => {
      const from = typeof base === 'string' && base.startsWith('file:') ? fileUrlToPath(base) : String(base || process.cwd() + '/x')
      const scope = resolver.findPackageScope(from)
      return scope ? scope.dir + '/package.json' : undefined
    },
    stripTypeScriptTypes: () => {
      throw new Error('module.stripTypeScriptTypes is not available in the emulation layer')
    },
    wrap: (src: string) => `(function (exports, require, module, __filename, __dirname) { ${src}\n});`,
    _cache: cjsCache,
    _extensions: { '.js': () => {}, '.json': () => {}, '.node': () => {} },
    _pathCache: {},
    _nodeModulePaths: nodeModulePaths,
    _resolveFilename: (spec: string, parent?: Module) => {
      const r = resolve(spec, parent?.filename, false)
      return r.builtin ?? r.file
    },
    _load: (spec: string, parent?: Module) => {
      const r = resolve(spec, parent?.filename, false)
      return r.builtin !== undefined ? getBuiltin(r.builtin) : loadFile(r.file, parent ?? null)
    },
    runMain: () => {},
  })

  return {
    stats,
    resolve,
    getBuiltin,
    isBuiltin,
    moduleBuiltin,
    createRequire,
    importModule,
    /** Run a program the way `node file` does. The promise settles when the entry module has been evaluated. */
    runMain(file: string): Promise<void> {
      const real = vfs.realpath(file)
      if (formatOf(real) === 'esm') return importModule(real, undefined).then(() => {})
      mainModule = new Module(real, null)
      mainModule.id = '.'
      process.mainModule = mainModule
      loadFile(real, null, mainModule)
      return Promise.resolve()
    },
    /** Run source text as if it were the file `file` (node -e, a script piped to stdin). Nothing is written to disk. */
    runSource(source: string, file: string, format: 'esm' | 'cjs'): Promise<void> {
      if (format === 'cjs') {
        const mod = new Module(file, null)
        const fn = timedEval(`(function (exports, require, module, __filename, __dirname, __dynamicImport, ${scopeParams}) {${source.replace(/(^|[^.\w$])import\s*\(/g, '$1__dynamicImport(')}\n})`, file)
        fn.call(mod.exports, mod.exports, makeRequire(mod), mod, file, dirname(file), dynamicImportFrom(file), ...scope.values)
        return Promise.resolve()
      }
      virtual.set(file, source)
      const pending = execute(loadEsm(file), new Set())
      return pending ?? Promise.resolve()
    },
  }
}

export type Loader = ReturnType<typeof createLoader>
