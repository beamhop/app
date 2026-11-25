// What a Node program sees as its global scope.
//
// Several Node processes can share the worker's realm, so Node's globals cannot simply be installed on the
// worker global: two programs would share one `process`. Instead every module is evaluated inside a function
// whose parameters are the per-process globals (`process`, `Buffer`, `console`, timers, `fetch`, `globalThis`…),
// and `globalThis` itself is a proxy: per-process names resolve to the process's own values, everything else
// (URL, TextEncoder, WebAssembly, …) falls through to the real global.
//
// Limits of this scheme, by design:
//  - A program that assigns `globalThis.fetch = mine` changes what `globalThis.fetch` returns, but a bare
//    `fetch` identifier in other modules still refers to the value the module was started with.
//  - Assignments of other names (`globalThis.myFlag = 1`) go to the real global so bare references to them
//    work; they are therefore visible to every Node process in the machine.
//  - Code compiled outside a module wrapper (`new Function`, indirect `eval`) sees the worker's real globals.
import type { Dyn } from './types.js'

/** Worker and browser globals a Node program must not see: their presence makes libraries pick a browser code path. */
export const HIDDEN_GLOBALS = [
  'self', 'window', 'document', 'importScripts', 'location', 'postMessage', 'onmessage', 'close', 'WorkerGlobalScope', 'DedicatedWorkerGlobalScope',
  'WebSocket', 'XMLHttpRequest', 'EventSource', 'Worker', 'SharedWorker', 'indexedDB', 'caches',
]

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
      // Always configurable: a proxy may not report a non-configurable property its target lacks.
      Object.defineProperty(has(key) || (typeof key === 'string' && hidden.has(key)) ? own : real, key, { ...descriptor, configurable: true })
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
