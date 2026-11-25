import type { KV } from '@beamhop/shared'

/** Tiny IndexedDB key-value store, namespaced per database. */
export class IDBKV implements KV {
  private dbp: Promise<IDBDatabase> | null = null
  constructor(private name = 'beamhop') {}
  /** Opens the database on first use, so importing this module has no side effects. */
  private db() {
    this.dbp ??= this.open().catch((e) => {
      this.dbp = null
      throw e
    })
    return this.dbp
  }
  /**
   * Opens the database, and if an existing one at this name lacks the `kv` store
   * (left over from an older build or another app on this origin), bumps the
   * version so the upgrade creates it.
   */
  private open(version?: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = version ? indexedDB.open(this.name, version) : indexedDB.open(this.name)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv')
      }
      req.onsuccess = () => {
        const db = req.result
        if (db.objectStoreNames.contains('kv')) {
          db.onversionchange = () => db.close()
          return resolve(db)
        }
        const next = db.version + 1
        db.close()
        this.open(next).then(resolve, reject)
      }
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('Beamhop storage upgrade is blocked by another open tab; close it and reload.'))
    })
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
