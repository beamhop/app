import type { WasmGlue } from './wasm'
import type { Roots as WasmRoots } from './generated/beamhop_tls_wasm.js'

/** Where a bundled root set came from. */
export interface RootStoreInfo {
  source: string
  /** Date line of the upstream bundle. */
  date: string
  /** SHA-256 of the upstream PEM bundle, hex. */
  sha256: string
  count: number
}

type Entry = { der: Uint8Array } | { packed: Uint8Array }

function b64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * A set of trust anchors. Immutable once created. Only the subject, public key and name
 * constraints of each root are used (the anchor's own validity dates and signature are not
 * checked, as is conventional for trust anchors).
 */
export class RootStore {
  #entries: Entry[]
  #wasm: WasmRoots | undefined
  readonly info: RootStoreInfo | undefined

  private constructor(entries: Entry[], info?: RootStoreInfo) {
    this.#entries = entries
    this.info = info
  }

  /** The bundled Mozilla root set (see README for source, date and hash). Loaded lazily: the
   *  data module is only fetched/parsed when this is first called. */
  static async mozilla(): Promise<RootStore> {
    mozilla ??= import('./generated/mozilla-roots').then((m) => new RootStore([{ packed: b64(m.MOZILLA_ROOTS_PACKED_B64) }], m.MOZILLA_ROOTS_INFO))
    return mozilla
  }

  /** Roots from one or more PEM `CERTIFICATE` blocks. Throws if there is none. */
  static fromPem(pem: string): RootStore {
    const ders: Uint8Array[] = []
    const re = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/g
    for (let m = re.exec(pem); m; m = re.exec(pem)) ders.push(b64(m[1]!.replace(/\s+/g, '')))
    if (ders.length === 0) throw new TypeError('no CERTIFICATE blocks in PEM input')
    return RootStore.fromDer(ders)
  }

  /** Roots from DER-encoded X.509 certificates. A malformed certificate makes `connectTls`
   *  reject (parsing happens in the TLS engine, at first use). */
  static fromDer(certs: Uint8Array[]): RootStore {
    return new RootStore(certs.map((der) => ({ der: der.slice() })))
  }

  /** The union of several stores (e.g. Mozilla roots plus a private CA). */
  static concat(...stores: RootStore[]): RootStore {
    return new RootStore(stores.flatMap((s) => s.#entries))
  }

  /** A store that trusts nothing: every handshake fails with `cert-untrusted`. */
  static empty(): RootStore {
    return new RootStore([])
  }

  /** @internal */
  _handle(wasm: WasmGlue): WasmRoots {
    if (!this.#wasm) {
      const roots = new wasm.Roots()
      try {
        for (const e of this.#entries) roots.add_packed('packed' in e ? e.packed : wasm.pack_anchor(e.der))
      } catch (err) {
        roots.free()
        throw new TypeError(`invalid root certificate: ${err instanceof Error ? err.message : String(err)}`)
      }
      this.#wasm = roots
    }
    return this.#wasm
  }
}

let mozilla: Promise<RootStore> | undefined
