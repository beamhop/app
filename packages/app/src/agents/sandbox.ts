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
    // One worker serves every workspace, so each run starts from an empty /work holding only
    // this workspace's files, and runs in fresh globals.
    const FS = py.FS
    const rmTree = (dir) => {
      for (const n of FS.readdir(dir)) {
        if (n === '.' || n === '..') continue
        const p = dir + '/' + n
        if (FS.isDir(FS.stat(p).mode)) { rmTree(p); FS.rmdir(p) } else FS.unlink(p)
      }
    }
    FS.chdir('/')
    try { FS.mkdir('/work') } catch {}
    rmTree('/work')
    FS.chdir('/work')
    const mkdirs = (path) => {
      let cur = '/work'
      for (const part of path.split('/').slice(0, -1)) {
        cur += '/' + part
        try { FS.mkdir(cur) } catch {}
      }
    }
    const before = {}
    for (const [p, d] of Object.entries(files)) { mkdirs(p); FS.writeFile('/work/' + p, d); before[p] = d }
    try { await py.loadPackagesFromImports(code) } catch {}
    let result
    const globals = py.toPy({})
    try {
      result = await py.runPythonAsync(code, { globals })
    } catch (err) {
      globals.destroy && globals.destroy()
      self.postMessage({ id, ok: false, stdout: out, error: String(err), changed: {} })
      return
    }
    const changed = {}
    const walk = (dir, rel) => {
      for (const n of FS.readdir(dir)) {
        if (n === '.' || n === '..') continue
        const p = dir + '/' + n
        const r = rel ? rel + '/' + n : n
        if (FS.isDir(FS.stat(p).mode)) { walk(p, r); continue }
        let d
        try { d = FS.readFile(p, { encoding: 'utf8' }) } catch { continue }
        if (before[r] !== d) changed[r] = d
      }
    }
    walk('/work', '')
    if (result && typeof result.toJs === 'function') result = String(result)
    globals.destroy && globals.destroy()
    self.postMessage({ id, ok: true, stdout: out, result: result === undefined || result === null ? undefined : String(result), changed })
  } catch (err) {
    self.postMessage({ id, ok: false, stdout: '', error: 'Python failed to load: ' + String(err), changed: {} })
  }
}
`

// Agent code runs in workers started inside a sandboxed iframe (sandbox="allow-scripts", no
// allow-same-origin). The iframe and its workers get an opaque origin, so code a room member talks
// an agent into running can't read Beamhop's IndexedDB (identity key, sign-ins) or storage.
const HOST_SRC = (js: string, py: string) => `<!doctype html><meta charset="utf-8"><script>
const JS = ${JSON.stringify(js).replace(/</g, '\\u003c')};
const PY = ${JSON.stringify(py).replace(/</g, '\\u003c')};
const url = (src) => URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
const jsUrl = url(JS), pyUrl = url(PY);
let py = null;
const reply = (id, r) => parent.postMessage({ __sbx: 'res', id, r }, '*');
onmessage = (e) => {
  if (e.source !== parent) return;
  const { id, kind, code, files, timeoutMs } = e.data || {};
  if (kind === 'js') {
    const w = new Worker(jsUrl);
    const t = setTimeout(() => { w.terminate(); reply(id, { ok: false, stdout: '', error: 'Timed out after ' + timeoutMs / 1000 + 's', changed: {} }) }, timeoutMs);
    w.onmessage = (m) => { clearTimeout(t); w.terminate(); reply(id, m.data) };
    w.onerror = (m) => { clearTimeout(t); w.terminate(); reply(id, { ok: false, stdout: '', error: m.message, changed: {} }) };
    w.postMessage({ code, files });
  } else if (kind === 'py') {
    // A classic worker: module workers can't start from a blob: URL in an opaque-origin iframe.
    py = py || new Worker(pyUrl);
    const w = py;
    const fail = (error) => { clearTimeout(t); w.removeEventListener('message', on); w.removeEventListener('error', onErr); w.terminate(); py = null; reply(id, { ok: false, stdout: '', error, changed: {} }) };
    const t = setTimeout(() => fail('Timed out after ' + timeoutMs / 1000 + 's'), timeoutMs);
    const on = (m) => { if (!m.data || m.data.id !== id) return; clearTimeout(t); w.removeEventListener('message', on); w.removeEventListener('error', onErr); reply(id, m.data) };
    const onErr = (e) => fail('Python worker failed: ' + (e.message || 'unknown error'));
    w.addEventListener('message', on);
    w.addEventListener('error', onErr);
    w.postMessage({ code, files, id });
  }
};
parent.postMessage({ __sbx: 'ready' }, '*');
<\/script>`

let host: Promise<HTMLIFrameElement> | null = null
const waiting = new Map<string, (r: RunResult) => void>()

function sandboxHost(): Promise<HTMLIFrameElement> {
  host ??= new Promise((resolve) => {
    const f = document.createElement('iframe')
    f.setAttribute('sandbox', 'allow-scripts')
    f.setAttribute('aria-hidden', 'true')
    f.style.display = 'none'
    f.srcdoc = HOST_SRC(JS_WORKER, PY_WORKER)
    window.addEventListener('message', (e) => {
      if (e.source !== f.contentWindow || !e.data) return
      if (e.data.__sbx === 'ready') resolve(f)
      else if (e.data.__sbx === 'res') {
        waiting.get(e.data.id)?.(e.data.r)
        waiting.delete(e.data.id)
      }
    })
    document.body.appendChild(f)
  })
  return host
}

async function runInSandbox(kind: 'js' | 'py', code: string, files: Files, timeoutMs: number): Promise<RunResult> {
  const f = await sandboxHost()
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36)
  return new Promise((resolve) => {
    // a backstop in case the sandbox itself stops answering
    const t = setTimeout(() => {
      waiting.delete(id)
      resolve({ ok: false, stdout: '', error: 'The sandbox stopped responding', changed: {} })
    }, timeoutMs + 5000)
    waiting.set(id, (r) => {
      clearTimeout(t)
      resolve({ ok: !!r?.ok, stdout: String(r?.stdout ?? ''), result: r?.result, error: r?.error, changed: sanitizeFiles(r?.changed) })
    })
    f.contentWindow!.postMessage({ id, kind, code, files, timeoutMs }, '*')
  })
}

/** Only string files with simple relative paths come back from the sandbox. */
function sanitizeFiles(v: any): Files {
  const out: Files = {}
  if (v && typeof v === 'object') for (const [k, d] of Object.entries(v)) if (typeof d === 'string' && /^[\w.\-]+(\/[\w.\-]+)*$/.test(k)) out[k] = d
  return out
}

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
    const r = await runInSandbox('js', code, { ...this.files }, timeoutMs)
    Object.assign(this.files, r.changed)
    if (Object.keys(r.changed).length) await this.save()
    return r
  }

  async runPython(code: string, timeoutMs = 120000): Promise<RunResult> {
    await this.loaded
    const r = await runInSandbox('py', code, { ...this.files }, timeoutMs)
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
