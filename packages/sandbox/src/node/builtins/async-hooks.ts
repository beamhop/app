import type { Dyn, Track } from '../types.js'

// ---------------- async_hooks ----------------
// There is no way to follow native async/await continuations in a browser (no AsyncContext, no promise hooks).
// This AsyncLocalStorage is exact for synchronous code and "sticky" across awaits: the store set by run() stays
// current until the promise returned by the callback settles. Concurrent run() calls can therefore observe each
// other's store. That is a known fidelity gap of this approach.
export function makeAsyncHooks({ track }: Dyn) {
  let alsUsed = 0
  class AsyncLocalStorage {
    [field: string]: Dyn // shaped like Node's class of the same name; fields are assigned in the constructor
    constructor(opts?: Dyn) {
      this._store = opts && opts.defaultValue
      this._enabled = true
      alsUsed++
      track('AsyncLocalStorage.new')
    }
    run(store?: Dyn, fn?: Dyn, ...args: Dyn[]) {
      const prev = this._store
      this._store = store
      let result
      try {
        result = fn(...args)
      } catch (e: Dyn) {
        this._store = prev
        throw e
      }
      if (result && typeof result.then === 'function') {
        track('AsyncLocalStorage.run(async)')
        const restore = () => {
          if (this._store === store) this._store = prev
        }
        result.then(restore, restore)
      } else this._store = prev
      return result
    }
    exit(fn?: Dyn, ...args: Dyn[]) {
      return this.run(undefined, fn, ...args)
    }
    getStore() {
      return this._store
    }
    enterWith(store?: Dyn) {
      track('AsyncLocalStorage.enterWith')
      this._store = store
    }
    disable() {
      this._store = undefined
    }
    static bind(fn?: Dyn) {
      return fn
    }
    static snapshot() {
      return (fn?: Dyn, ...args: Dyn[]) => fn(...args)
    }
  }
  class AsyncResource {
    [field: string]: Dyn // shaped like Node's class of the same name; fields are assigned in the constructor
    constructor(type?: Dyn) {
      this.type = type
    }
    runInAsyncScope(fn?: Dyn, thisArg?: Dyn, ...args: Dyn[]) {
      return fn.apply(thisArg, args)
    }
    emitDestroy() {
      return this
    }
    asyncId() {
      return 1
    }
    triggerAsyncId() {
      return 0
    }
    bind(fn?: Dyn, thisArg?: Dyn) {
      return fn.bind(thisArg)
    }
    static bind(fn?: Dyn, type?: Dyn, thisArg?: Dyn) {
      return thisArg ? fn.bind(thisArg) : fn
    }
  }
  return {
    AsyncLocalStorage,
    AsyncResource,
    executionAsyncId: () => 1,
    triggerAsyncId: () => 0,
    executionAsyncResource: () => ({}),
    createHook: () => {
      track('async_hooks.createHook')
      return {
        enable() {
          return this
        },
        disable() {
          return this
        },
      }
    },
    asyncWrapProviders: {},
  }
}

