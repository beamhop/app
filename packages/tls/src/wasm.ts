// Loads the rustls wasm module (built by scripts/build-wasm.mjs). One instance per JS realm.
import init, * as glue from './generated/beamhop_tls_wasm.js'

export type WasmGlue = typeof glue

/** Anything `WebAssembly.instantiate[Streaming]` can take, or a URL to fetch. */
export type WasmSource = BufferSource | WebAssembly.Module | Response | URL | string | Promise<Response | BufferSource | WebAssembly.Module>

let ready: Promise<WasmGlue> | undefined

async function defaultSource(): Promise<BufferSource | URL> {
  // Vite and other bundlers that understand `new URL(asset, import.meta.url)` emit the .wasm as
  // an asset. Bundlers that do not (plain esbuild): call initTls(urlOrBytes) explicitly.
  const url = new URL('./generated/beamhop_tls_wasm_bg.wasm', import.meta.url)
  if (url.protocol === 'file:') {
    // Node / vitest: fetch() does not read file: URLs. Specifier is built at runtime so browser
    // bundlers do not try to resolve a Node builtin.
    const fs = await import(/* @vite-ignore */ ['node', 'fs/promises'].join(':'))
    return (await fs.readFile(url)) as Uint8Array<ArrayBuffer>
  }
  return url
}

/**
 * Load and instantiate the TLS engine. Optional: `connectTls` calls it on first use with the
 * default location. Call it yourself to control where the .wasm comes from, or to pay the
 * compile cost (tens of ms) before the first connection. Safe to call repeatedly; the first
 * successful call wins.
 */
export function initTls(source?: WasmSource): Promise<void> {
  return loadWasm(source).then(() => undefined)
}

export function loadWasm(source?: WasmSource): Promise<WasmGlue> {
  if (!ready) {
    const p = (async () => {
      const src = source === undefined ? await defaultSource() : typeof source === 'string' ? new URL(source, import.meta.url) : await source
      await init({ module_or_path: src })
      return glue
    })()
    ready = p
    p.catch(() => {
      if (ready === p) ready = undefined // allow a retry with another source
    })
  }
  return ready
}
