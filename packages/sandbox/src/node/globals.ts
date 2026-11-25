// What a Node program sees as its global scope.
//
// Several Node processes can share the worker's realm, so Node's globals cannot simply be installed on the
// worker global: two programs would share one `process`. Instead every module is evaluated inside a function
// whose parameters are the per-process globals (`process`, `Buffer`, `console`, timers, `fetch`, `globalThis`…),
// and `globalThis` itself is a proxy: per-process names resolve to the process's own values, everything else
// (URL, TextEncoder, WebAssembly, …) falls through to the real global.
//
// Limits of this scheme, by design:
//  - Assignments of any other name (`globalThis.myFlag = 1`, or undici's install() replacing Response, Headers,
//    Request, FormData, WebSocket) go to the real global, so that bare references to them see the new value, as
//    they would in Node. They are therefore visible to every Node process in the machine, and to this package's
//    own code, which is why that code uses the references captured in src/host.ts.
//  - `fetch` is the one per-process global programs routinely replace (pi installs undici's). A module parameter
//    cannot be reassigned from outside, so the `fetch` parameter is a trampoline to the process's current
//    implementation; see createFetchSlot.
//  - Code compiled outside a module wrapper (`new Function`, indirect `eval`) sees the worker's real globals.
import type { Dyn } from './types.js'

/** Worker globals a Node program must not see as bare identifiers. They cannot be removed, so every module shadows them. */
export const HIDDEN_GLOBALS = ['self', 'window', 'document', 'importScripts', 'location', 'postMessage', 'onmessage', 'close', 'WorkerGlobalScope', 'DedicatedWorkerGlobalScope']

/**
 * Browser APIs Node does not have. Their presence makes libraries choose a browser code path that cannot work
 * here (the frame's CSP allows no connection but to its own origin), so in a worker they are removed outright.
 * Removing, rather than shadowing, lets a program install its own (undici's WebSocket runs over net.Socket).
 */
const BROWSER_ONLY = ['WebSocket', 'XMLHttpRequest', 'EventSource', 'Worker', 'SharedWorker', 'indexedDB', 'caches']
let browserGlobalsRemoved = false
export function removeBrowserOnlyGlobals(): void {
  const real = globalThis as Dyn
  if (browserGlobalsRemoved || typeof real.WorkerGlobalScope === 'undefined') return
  browserGlobalsRemoved = true
  for (const name of BROWSER_ONLY) {
    try {
      delete real[name]
      // Attributes such as indexedDB live on the prototype; an own property hides them.
      if (name in real) Object.defineProperty(real, name, { value: undefined, writable: true, configurable: true })
    } catch {
      // a non-configurable global stays; nothing in the layer depends on its absence
    }
  }
}

/**
 * `fetch` for one process: `call` is what modules receive as the bare identifier, `get`/`set` back
 * `globalThis.fetch`. A program that wraps the fetch it captured as a bare identifier and installs the wrapper
 * would otherwise recurse through the trampoline forever; a re-entrant call therefore goes one implementation
 * down the stack. (Only synchronous re-entry can be recognised: a wrapper that awaits before calling a captured
 * bare `fetch` still loops. Capturing `globalThis.fetch`, the usual way, is always safe.)
 */
export function createFetchSlot(initial: Dyn): { call: Dyn; get(): Dyn; set(fn: Dyn): void } {
  const stack: Dyn[] = [initial]
  let depth = 0
  function fetch(this: unknown, ...args: Dyn[]): Dyn {
    const impl = stack[Math.max(0, stack.length - 1 - depth)]
    depth++
    try {
      return impl.apply(this, args)
    } finally {
      depth--
    }
  }
  return {
    call: fetch,
    get: () => stack[stack.length - 1],
    set(fn) {
      if (fn === fetch) return
      if (typeof fn === 'function') stack.push(fn)
    },
  }
}

export function createGuestGlobal(own: Record<string, Dyn>): Dyn {
  const real = globalThis as Dyn
  const hidden = new Set(HIDDEN_GLOBALS)
  const bound = new Map<string | symbol, Dyn>()
  const has = (key: string | symbol): boolean => Object.prototype.hasOwnProperty.call(own, key)
  const proxy: Dyn = new Proxy(own, {
    get(_target, key) {
      if (has(key)) return own[key as string]
      if (typeof key === 'string' && hidden.has(key)) return undefined
      const value = real[key]
      // Platform functions (atob, structuredClone, queueMicrotask, …) check their receiver; constructors do not need one.
      if (typeof value === 'function' && !('prototype' in value && value.prototype)) {
        let fn = bound.get(key)
        if (!fn) bound.set(key, (fn = Object.assign(value.bind(real), value)))
        return fn
      }
      return value
    },
    set(_target, key, value) {
      if (has(key) || (typeof key === 'string' && hidden.has(key))) own[key as string] = value
      else real[key] = value
      return true
    },
    has(_target, key) {
      return has(key) || (!(typeof key === 'string' && hidden.has(key)) && key in real)
    },
    deleteProperty(_target, key) {
      if (has(key)) return delete own[key as string]
      return delete real[key]
    },
    defineProperty(_target, key, descriptor) {
      // A proxy may only confirm a non-configurable property that its target really has, so those are kept on the
      // per-process object (undici pins its global dispatcher this way; per process is the better home for it anyway).
      if (has(key) || descriptor.configurable === false || (typeof key === 'string' && hidden.has(key))) Object.defineProperty(own, key, descriptor)
      else Object.defineProperty(real, key, descriptor)
      return true
    },
    getOwnPropertyDescriptor(_target, key) {
      if (has(key)) return Object.getOwnPropertyDescriptor(own, key)
      if (typeof key === 'string' && hidden.has(key)) return undefined
      const d = Object.getOwnPropertyDescriptor(real, key)
      if (!d) return undefined
      // Report as a plain data property of the proxy target; accessor properties of the real global need its receiver.
      return { value: proxy[key], writable: true, enumerable: d.enumerable, configurable: true }
    },
    ownKeys() {
      const keys = new Set<string | symbol>(Reflect.ownKeys(own))
      for (const k of Reflect.ownKeys(real)) if (!(typeof k === 'string' && hidden.has(k))) keys.add(k)
      return [...keys]
    },
  })
  return proxy
}
