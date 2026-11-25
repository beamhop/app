// Page side of the Beamhop Companion extension bridge.
// The extension's content script relays window messages to its background worker,
// which can make cross-origin requests (no CORS) and watch sign-in tabs.

type Res =
  | { __bh: 'res'; id: string; kind: 'head'; status: number; statusText: string; headers: [string, string][]; url?: string }
  | { __bh: 'res'; id: string; kind: 'chunk'; data: string } // base64
  | { __bh: 'res'; id: string; kind: 'end' }
  | { __bh: 'res'; id: string; kind: 'error'; message: string }
  | { __bh: 'res'; id: string; kind: 'result'; value: any }

const listeners = new Map<string, (r: Res) => void>()
let version: string | null = null
const versionWaiters: ((v: string | null) => void)[] = []

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object') return
    const d = e.data
    if (d.__bh === 'hello') {
      version = String(d.version)
      versionWaiters.splice(0).forEach((f) => f(version))
    } else if (d.__bh === 'res' && listeners.has(d.id)) listeners.get(d.id)!(d)
  })
  version = document.documentElement.dataset.beamhopCompanion ?? null
}

export function extensionVersion() {
  return version ?? document.documentElement.dataset.beamhopCompanion ?? null
}

export async function detectExtension(timeout = 1200): Promise<string | null> {
  const v = extensionVersion()
  if (v) return v
  window.postMessage({ __bh: 'ping' }, '*')
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(extensionVersion()), timeout)
    versionWaiters.push((v) => {
      clearTimeout(t)
      resolve(v)
    })
  })
}

const rid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

function b64ToBytes(s: string) {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function bytesToB64(b: Uint8Array) {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}

async function bodyToB64(body: any): Promise<string | undefined> {
  if (body == null) return undefined
  if (typeof body === 'string') return bytesToB64(new TextEncoder().encode(body))
  if (body instanceof URLSearchParams) return bytesToB64(new TextEncoder().encode(body.toString()))
  if (body instanceof Uint8Array) return bytesToB64(body)
  if (body instanceof ArrayBuffer) return bytesToB64(new Uint8Array(body))
  if (body instanceof Blob) return bytesToB64(new Uint8Array(await body.arrayBuffer()))
  if (body instanceof ReadableStream) return bytesToB64(new Uint8Array(await new Response(body).arrayBuffer()))
  return bytesToB64(new TextEncoder().encode(String(body)))
}

/** fetch() that runs inside the extension (no CORS, no cookies). Streams the response body. */
export async function extFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  if (!extensionVersion()) throw new Error('Beamhop Companion extension is not installed')
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const headers: [string, string][] = []
  new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => headers.push([k, v]))
  const id = rid()
  const body = await bodyToB64(init.body ?? undefined)
  return new Promise((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
      cancel() {
        window.postMessage({ __bh: 'req', id, op: 'abort' }, '*')
        listeners.delete(id)
      },
    })
    const onAbort = () => {
      window.postMessage({ __bh: 'req', id, op: 'abort' }, '*')
      listeners.delete(id)
      const err = new DOMException('Aborted', 'AbortError')
      reject(err)
      try {
        controller.error(err)
      } catch {}
    }
    init.signal?.addEventListener('abort', onAbort, { once: true })
    listeners.set(id, (r) => {
      if (r.kind === 'head') {
        const nullBody = [101, 204, 205, 304].includes(r.status)
        const res = new Response(nullBody ? null : stream, { status: r.status, statusText: r.statusText, headers: r.headers })
        // a constructed Response has no URL; report where the request ended up after redirects
        Object.defineProperty(res, 'url', { value: r.url ?? url })
        resolve(res)
      } else if (r.kind === 'chunk') controller.enqueue(b64ToBytes(r.data))
      else if (r.kind === 'end') {
        listeners.delete(id)
        init.signal?.removeEventListener('abort', onAbort)
        try {
          controller.close()
        } catch {}
      } else if (r.kind === 'error') {
        listeners.delete(id)
        const err = new TypeError(r.message)
        reject(err)
        try {
          controller.error(err)
        } catch {}
      }
    })
    window.postMessage({ __bh: 'req', id, op: 'fetch', url, method: init.method ?? 'GET', headers, body }, '*')
  })
}

function call<T = any>(op: string, args: Record<string, any>, timeoutMs = 10 * 60_000): Promise<T> {
  if (!extensionVersion()) return Promise.reject(new Error('Beamhop Companion extension is not installed'))
  const id = rid()
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      listeners.delete(id)
      reject(new Error('Timed out'))
    }, timeoutMs)
    listeners.set(id, (r) => {
      clearTimeout(t)
      listeners.delete(id)
      if (r.kind === 'result') resolve(r.value)
      else if (r.kind === 'error') reject(new Error(r.message))
    })
    window.postMessage({ __bh: 'req', id, op, ...args }, '*')
  })
}

/** Open `url` in a tab and resolve with the first address that starts with `redirectPrefix`. */
export function extCaptureRedirect(url: string, redirectPrefix: string): Promise<string> {
  return call<string>('capture', { url, redirectPrefix })
}

/** Fetch with the extension when it's there, otherwise directly. */
export const smartFetch = (input: string, init: RequestInit = {}) => (extensionVersion() ? extFetch(input, init) : fetch(input, init))

;(globalThis as any).__beamhopExt = { extFetch, detectExtension, extensionVersion }
