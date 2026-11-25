// Storage seam. Everything the writable file system keeps (file contents today, inode records once a
// persistent backend exists) goes through a BlockStore, so an OPFS/SQLite store can replace the in-memory
// one without touching the VFS or its callers.
//
// The interface is synchronous on purpose: the Node layer's `fs.readFileSync` and `require` are direct calls
// into the kernel. SQLite on OPFS (`opfs-sahpool`) is synchronous inside a dedicated worker, so it fits.

export interface BlockStore {
  /** Returns the stored bytes, or undefined. Callers must not mutate the returned array. */
  get(key: string): Uint8Array | undefined
  /** Stores `data` under `key`, replacing any previous value. The store takes ownership of `data`. */
  put(key: string, data: Uint8Array): void
  delete(key: string): void
  has(key: string): boolean
  /** Durability point. A no-op for the in-memory store; a transaction commit for a persistent one. */
  flush(): void
}

export class MemoryBlockStore implements BlockStore {
  private readonly blocks = new Map<string, Uint8Array>()
  get(key: string): Uint8Array | undefined {
    return this.blocks.get(key)
  }
  put(key: string, data: Uint8Array): void {
    this.blocks.set(key, data)
  }
  delete(key: string): void {
    this.blocks.delete(key)
  }
  has(key: string): boolean {
    return this.blocks.has(key)
  }
  flush(): void {}
  /** Total bytes held; used by tests and diagnostics. */
  get byteLength(): number {
    let n = 0
    for (const b of this.blocks.values()) n += b.byteLength
    return n
  }
}
