// Builds wasm/ (rustls + rustls-webpki + ring) and writes the wasm-bindgen output to src/generated/.
// Needs: rustc with the wasm32-unknown-unknown target, clang (ring compiles C for wasm32), and
// wasm-bindgen-cli at exactly the version pinned in wasm/Cargo.toml
// (`cargo install wasm-bindgen-cli --version 0.2.130 --locked`).
// The output is checked in so that consumers and CI do not need a Rust toolchain.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkg = fileURLToPath(new URL('..', import.meta.url))
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: pkg + 'wasm', ...opts })
const env = { ...process.env, CC_wasm32_unknown_unknown: process.env.CC_wasm32_unknown_unknown ?? 'clang', AR_wasm32_unknown_unknown: process.env.AR_wasm32_unknown_unknown ?? 'llvm-ar' }

run('cargo', ['build', '--release', '--locked', '--target', 'wasm32-unknown-unknown'], { env })
run('wasm-bindgen', ['--target', 'web', '--out-dir', '../src/generated', '--out-name', 'beamhop_tls_wasm', 'target/wasm32-unknown-unknown/release/beamhop_tls_wasm.wasm'])
rmSync(pkg + 'src/generated/beamhop_tls_wasm_bg.wasm.d.ts', { force: true })

const wasm = readFileSync(pkg + 'src/generated/beamhop_tls_wasm_bg.wasm')
const lock = readFileSync(pkg + 'wasm/Cargo.lock', 'utf8')
const ver = (name) => new RegExp(`name = "${name}"\\nversion = "([^"]+)"`).exec(lock)?.[1]
const info = {
  sha256: createHash('sha256').update(wasm).digest('hex'),
  bytes: wasm.length,
  rustc: execFileSync('rustc', ['-V']).toString().trim(),
  crates: Object.fromEntries(['rustls', 'rustls-webpki', 'ring', 'rustls-pki-types', 'wasm-bindgen'].map((n) => [n, ver(n)])),
}
writeFileSync(pkg + 'src/generated/wasm-build.json', JSON.stringify(info, null, 2) + '\n')
console.log(info)
