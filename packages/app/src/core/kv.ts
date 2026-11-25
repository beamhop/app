import type { KV } from '@beamhop/shared'

/** Tiny IndexedDB key-value store, namespaced per database. */
export class IDBKV implements KV {
  private dbp: Promise<IDBDatabase> | null = null
  constructor(private name = 'beamhop') {}
  /** Opens the database on first use, so importing this module has no side effects. */
  private db() {
    this.dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1)
      req.onupgradeneeded = () => req.result.createObjectStore('kv')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return this.dbp
  }
  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.db()
    return new Promise((resolve, reject) => {
      const t = db.transaction('kv', mode)
      const r = fn(t.objectStore('kv'))
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
  }
  get<T>(key: string) {
    return this.tx<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>)
  }
  async set(key: string, v: any) {
    await this.tx('readwrite', (s) => s.put(v, key))
  }
  async del(key: string) {
    await this.tx('readwrite', (s) => s.delete(key))
  }
  async keys(): Promise<string[]> {
    return (await this.tx('readonly', (s) => s.getAllKeys())) as string[]
  }
  async clear() {
    await this.tx('readwrite', (s) => s.clear())
  }
}

export const kv = new IDBKV()
