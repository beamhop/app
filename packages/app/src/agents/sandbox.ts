// A per-agent, per-room workspace: an in-memory file system persisted to IndexedDB,
// with JavaScript (fresh Web Worker per run) and Python (Pyodide worker) execution.
import { kv } from '../core/kv'

export type Files = Record<string, string>

const JS_WORKER = `
self.onmessage = async (e) => {
  const { code, files } = e.data
  const out = []
  const changed = {}
  const fmt = (a) => a.map((x) => typeof x === 'string' ? x : (() => { try { return JSON.stringify(x) } catch { return String(x) } })()).join(' ')
  const con = { log: (...a) => out.push(fmt(a)), info: (...a) => out.push(fmt(a)), warn: (...a) => out.push('[warn] ' + fmt(a)), error: (...a) => out.push('[error] ' + fmt(a)) }
  const fs = {
    readFile: (p) => { if (!(p in files)) throw new Error('No such file: ' + p); return files[p] },
    writeFile: (p, d) => { files[p] = String(d); changed[p] = String(d) },
    listFiles: () => Object.keys(files),
    exists: (p) => p in files,
  }
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const fn = new AsyncFunction('console', 'fs', code)
    const result = await fn(con, fs)
    self.postMessage({ ok: true, stdout: out.join('\\n'), result: result === undefined ? undefined : fmt([result]), changed })
  } catch (err) {
    self.postMessage({ ok: false, stdout: out.join('\\n'), error: String(err && err.stack || err), changed })
  }
}
`

const PY_WORKER = `
let py = null
const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.29.3/full/'
self.onmessage = async (e) => {
  const { code, files, id } = e.data
  try {
    if (!py) {
      const mod = await import(PYODIDE + 'pyodide.mjs')
      py = await mod.loadPyodide({ indexURL: PYODIDE })
    }
    let out = ''
    py.setStdout({ batched: (s) => { out += s + '\\n' } })
    py.setStderr({ batched: (s) => { out += '[stderr] ' + s + '\\n' } })
    try { py.FS.mkdir('/work') } catch {}
    py.FS.chdir('/work')
    const before = {}
    for (const [p, d] of Object.entries(files)) { py.FS.writeFile('/work/' + p, d); before[p] = d }
    try { await py.loadPackagesFromImports(code) } catch {}
    let result
    try {
      result = await py.runPythonAsync(code)
    } catch (err) {
      self.postMessage({ id, ok: false, stdout: out, error: String(err), changed: {} })
      return
    }
    const changed = {}
    for (const name of py.FS.readdir('/work')) {
      if (name === '.' || name === '..') continue
      const st = py.FS.stat('/work/' + name)
      if (py.FS.isDir(st.mode)) continue
      const d = py.FS.readFile('/work/' + name, { encoding: 'utf8' })
      if (before[name] !== d) changed[name] = d
    }
    self.postMessage({ id, ok: true, stdout: out, result: result === undefined || result === null ? undefined : String(result), changed })
  } catch (err) {
    self.postMessage({ id, ok: false, stdout: '', error: 'Python failed to load: ' + String(err), changed: {} })
  }
}
`

const blobUrl = (src: string) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
let jsUrl: string | null = null
let pyUrl: string | null = null
let pyWorker: Worker | null = null

export interface RunResult {
  ok: boolean
  stdout: string
  result?: string
  error?: string
  changed: Files
}

export class Sandbox {
  files: Files = {}
  private loaded: Promise<void>
  constructor(public id: string) {
    this.loaded = kv.get<Files>('sandbox:' + id).then((f) => {
      this.files = f ?? {}
    })
  }
  async ready() {
    await this.loaded
    return this
  }
  private save() {
    return kv.set('sandbox:' + this.id, this.files)
  }
  async list() {
    await this.loaded
    return Object.entries(this.files).map(([path, d]) => ({ path, size: d.length }))
  }
  async read(path: string) {
    await this.loaded
    if (!(path in this.files)) throw new Error('No such file: ' + path)
    return this.files[path]
  }
  async write(path: string, data: string) {
    await this.loaded
    if (!/^[\w.\-]+(\/[\w.\-]+)*$/.test(path)) throw new Error('Use a simple relative path like notes/plan.md')
    this.files[path] = data
    await this.save()
  }
  async remove(path: string) {
    await this.loaded
    delete this.files[path]
    await this.save()
  }

  async runJs(code: string, timeoutMs = 20000): Promise<RunResult> {
    await this.loaded
    jsUrl ??= blobUrl(JS_WORKER)
    const w = new Worker(jsUrl)
    const r = await new Promise<RunResult>((resolve) => {
      const t = setTimeout(() => {
        w.terminate()
        resolve({ ok: false, stdout: '', error: `Timed out after ${timeoutMs / 1000}s`, changed: {} })
      }, timeoutMs)
      w.onmessage = (e) => {
        clearTimeout(t)
        w.terminate()
        resolve(e.data)
      }
      w.onerror = (e) => {
        clearTimeout(t)
        w.terminate()
        resolve({ ok: false, stdout: '', error: e.message, changed: {} })
      }
      w.postMessage({ code, files: { ...this.files } })
    })
    Object.assign(this.files, r.changed)
    if (Object.keys(r.changed).length) await this.save()
    return r
  }

  async runPython(code: string, timeoutMs = 120000): Promise<RunResult> {
    await this.loaded
    pyUrl ??= blobUrl(PY_WORKER)
    pyWorker ??= new Worker(pyUrl, { type: 'module' })
    const w = pyWorker
    const id = Math.random().toString(36).slice(2)
    const r = await new Promise<RunResult>((resolve) => {
      const t = setTimeout(() => {
        w.terminate()
        pyWorker = null
        resolve({ ok: false, stdout: '', error: `Timed out after ${timeoutMs / 1000}s`, changed: {} })
      }, timeoutMs)
      const onMsg = (e: MessageEvent) => {
        if (e.data?.id !== id) return
        clearTimeout(t)
        w.removeEventListener('message', onMsg)
        resolve(e.data)
      }
      w.addEventListener('message', onMsg)
      w.postMessage({ code, files: { ...this.files }, id })
    })
    Object.assign(this.files, r.changed)
    if (Object.keys(r.changed).length) await this.save()
    return r
  }
}

const sandboxes = new Map<string, Sandbox>()
export const sandboxFor = (id: string) => {
  if (!sandboxes.has(id)) sandboxes.set(id, new Sandbox(id))
  return sandboxes.get(id)!
}

export function formatRun(r: RunResult) {
  const parts: string[] = []
  parts.push(r.ok ? 'ok' : 'error')
  if (r.stdout) parts.push('stdout:\n' + r.stdout.slice(0, 8000))
  if (r.result !== undefined) parts.push('result: ' + r.result.slice(0, 4000))
  if (r.error) parts.push('error: ' + r.error.slice(0, 4000))
  const ch = Object.keys(r.changed)
  if (ch.length) parts.push('files written: ' + ch.join(', '))
  return parts.join('\n')
}
