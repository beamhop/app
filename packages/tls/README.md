# @beamhop/tls

A TLS client that runs over any byte stream, for use inside a browser worker. It lets a Beamhop
machine terminate TLS itself when its traffic leaves through the blind WebSocket-to-TCP tunnel
(`packages/proxy/PROTOCOL.md`, tunnel mode), so the proxy operator sees hostnames and volume but
never tokens or prompts.

- TLS 1.3 and TLS 1.2, SNI, ALPN, full certificate verification against a bundled Mozilla root set
  or caller-supplied roots.
- No SharedArrayBuffer, no cross-origin isolation, no WebCrypto. One 549 kB wasm module (226 kB
  gzip) plus about 5 kB gzip of JavaScript.
- The TLS state machine and the X.509 verifier are not ours: they are rustls, rustls-webpki and
  ring, compiled to wasm. This package is the stream plumbing around them.

## Use it from a worker

```ts
import { connectTls, initTls, RootStore, TlsError } from '@beamhop/tls'
import { openTunnel } from '@beamhop/tls/tunnel'

// Optional. connectTls() loads the engine on first use from
// new URL('./generated/beamhop_tls_wasm_bg.wasm', import.meta.url), which Vite resolves.
// With a bundler that does not (plain esbuild), or to warm up early, pass a URL, Response,
// bytes or WebAssembly.Module yourself:
await initTls('/assets/beamhop_tls.wasm')

const transport = await openTunnel({ proxy: 'wss://proxy.example', host: 'api.example.com', port: 443, token })
try {
  const tls = await connectTls(transport, { serverName: 'api.example.com', alpn: ['http/1.1'] })
  tls.alpn            // 'http/1.1' | null
  tls.protocolVersion // 'TLSv1.3' | 'TLSv1.2'
  await tls.write(new TextEncoder().encode('GET / HTTP/1.1\r\nHost: api.example.com\r\n\r\n'))
  for await (const chunk of tls.readable) { /* plaintext */ }   // or tls.readable.getReader()
  await tls.end()     // close_notify + FIN
  tls.close()         // always close when done; frees the wasm connection state
} catch (e) {
  if (e instanceof TlsError) e.code // 'cert-untrusted' | 'cert-name-mismatch' | ...
}
```

### API

`connectTls(transport, options) → Promise<TlsSocket>`. Rejects with a `TlsError` (the transport
has then been closed).

| Option | Meaning |
| --- | --- |
| `serverName` (required) | Name the certificate is checked against, and the SNI value. ASCII DNS name or IP literal; pass IDNs as A-labels (`xn--…`). IP literals are matched against IP SANs and send no SNI. |
| `alpn?: string[]` | Protocols to offer, most preferred first. |
| `roots?: RootStore` | Trust anchors. Default `await RootStore.mozilla()`. |
| `now?: () => Date` | Clock for validity checks. Default `new Date()`. |
| `versions?: ('TLSv1.2' \| 'TLSv1.3')[]` | Default both. |
| `allowUncleanEof?: boolean` | Treat EOF without close_notify as a clean end. Default false. |
| `signal?: AbortSignal` | Aborts a pending handshake (`closed`). There is no built-in handshake timeout: use `AbortSignal.timeout(ms)`. |

`TlsTransport` (what you provide): `{ readable: ReadableStream<Uint8Array>; write(bytes): void | Promise<void>; end(): void; close(): void }`.
`readable` closing means the peer sent FIN; `write` may return a promise for backpressure; `end`
is a half-close; `close` tears down both directions and must tolerate repeated calls.
`openTunnel()` in `@beamhop/tls/tunnel` builds one from the proxy's tunnel mode.

`TlsSocket`: `readable`, `write(bytes) → Promise<void>`, `end() → Promise<void>`, `close()`,
`alpn`, `protocolVersion`, `cipherSuite`.

- `readable` ends when the peer's close_notify arrives. If the transport ends without it, the
  stream errors with `truncated` (after delivering everything received before). Data that was
  authenticated before a later bad record is delivered before the error.
- Reading drives the connection: the transport is read only while a read on `readable` is
  pending. A caller that never reads will not see alerts or the peer closing.
- `close()` errors an unfinished `readable` with `closed`; later `write`/`end` reject with `closed`.

`RootStore`: `RootStore.mozilla()` (async, lazy chunk), `RootStore.fromPem(pem)`,
`RootStore.fromDer(certs)`, `RootStore.concat(a, b)`, `RootStore.empty()`; `.info` carries the
source, date, hash and count for the bundled set.

Error codes (`TlsError.code`). The first six are the ones callers will usually branch on; the rest
separate cases that would otherwise be mislabelled.

| Code | When |
| --- | --- |
| `cert-untrusted` | No path to a trusted root. Includes self-signed leaves and servers that omit an intermediate. |
| `cert-name-mismatch` | Certificate not valid for `serverName`. |
| `cert-expired` | Leaf or intermediate past notAfter. |
| `cert-not-yet-valid` | Leaf or intermediate before notBefore (often a wrong device clock). |
| `cert-invalid` | Any other certificate failure: bad signature, bad encoding, missing serverAuth usage, unsupported algorithm, unknown critical extension. |
| `protocol-version` | No common version: peer is TLS 1.1 or older, or outside `versions`. |
| `handshake-failed` | Anything else before the handshake completed: alerts, non-TLS bytes, EOF, no common cipher suite or ALPN protocol, invalid `serverName`. |
| `protocol-error` | Fatal TLS error after the handshake (bad record MAC, fatal alert). |
| `truncated` | Transport ended without close_notify. |
| `transport` | The transport's readable errored or a write rejected. |
| `closed` | Closed or aborted locally. |

`e.message` carries rustls' own description, e.g. `cert-untrusted: invalid peer certificate: UnknownIssuer`.

## Decision record

Chosen: **rustls 0.23 + rustls-webpki 0.103 + ring 0.17, compiled to `wasm32-unknown-unknown`,
behind a 320-line wasm-bindgen wrapper** (`wasm/src/lib.rs`) and a TypeScript stream adapter.

Why, in the order of the criteria:

1. Certificate verification. rustls-webpki builds paths through the intermediates the server
   sends, checks validity dates, basic constraints, key usage and serverAuth EKU, name constraints,
   and matches DNS and IP names against SANs only. It verifies ECDSA P-256 and P-384, RSA PKCS#1
   v1.5 and PSS (2048 to 8192 bit) and Ed25519. It is widely deployed; rustls and webpki had an independent audit in 2020. Nothing in this package re-implements any of it.
2. TLS 1.3 with a real TLS 1.2 fallback (ECDHE with AES-GCM or ChaCha20-Poly1305 only).
3. ALPN (any protocol, so `h2` can be negotiated) and SNI.
4. Size is the cost: 549 kB of wasm, 226 kB gzip.
5. Licences are permissive: rustls Apache-2.0/ISC/MIT, rustls-webpki ISC, ring Apache-2.0 and ISC,
   subtle BSD-3-Clause, the rest MIT/Apache-2.0.

Because all cryptography runs inside the wasm module (ring), the package uses **no WebCrypto at
all**; the only platform API it needs for crypto is `crypto.getRandomValues`. The question of
X25519 and Ed25519 support in WebCrypto across browsers therefore does not arise, and no
`@noble/curves` fallback is needed. (For the record, Chromium 158 reports both as available.)

Rejected:

| Option | Why not |
| --- | --- |
| `subtls` 0.5.0 (MIT, last published January 2025) | Its README says "Not intended for production use" and "really needs auditing". TLS 1.3 only. Key exchange P-256 only. Leaf signatures ECDSA P-256 and RSA-PSS-SHA256 only; chain signatures without Ed25519 or RSA-PSS. Hand-written state machine and X.509 checks, which is the thing we least want to own. Its one advantage is size (about 130 kB unpacked). |
| rustls with the `rustls-rustcrypto` provider | Pure Rust and needs no C compiler, but a much younger and less deployed provider than ring (not evaluated in depth here). ring builds for wasm with clang, so there was no reason to take it. |
| rustls with `aws-lc-rs` | Not tried: to our knowledge it does not target `wasm32-unknown-unknown`. |
| `node-forge` | No TLS 1.3, own X.509 code in JavaScript, TLS parts not actively maintained (not evaluated beyond its documentation). |
| BearSSL, mbedTLS or OpenSSL via Emscripten | Memory-unsafe C parsers for hostile input inside the trust boundary, a second toolchain, larger (OpenSSL) or without TLS 1.3 (BearSSL). |
| Writing it ourselves on WebCrypto | Excluded by the brief, and X25519/Ed25519 in WebCrypto are recent in every engine. |

Patches to libraries: none. Two build-time choices are worth knowing:

- Cipher suite order is ChaCha20-Poly1305 first, then AES-GCM (rustls' default is AES first).
  wasm has no AES instructions, so ChaCha20 is more than twice as fast here and has the simpler
  constant-time story. Servers that impose their own order still get AES-GCM.
- Session resumption and 0-RTT are disabled. Every connection is a full handshake with full
  certificate verification, and no ticket state is kept.

## Security properties

Given a correct clock and an uncompromised root set, when `connectTls` resolves:

- the peer proved possession of the private key of a certificate that chains to a trust anchor,
  is within its validity period, is valid for serverAuth, and names `serverName`;
- everything read from `readable` and written with `write` is confidential and authenticated with
  forward secrecy (ECDHE with X25519, P-256 or P-384; AEAD suites only);
- a clean end of `readable` means the peer deliberately ended the stream; anything else is an error;
- the transport (the proxy) can observe the destination, the SNI, sizes and timing, and can delay
  or cut the connection, but cannot read or alter the content without detection.

Not accepted at all: TLS 1.1 and older, RSA key exchange, CBC and other non-AEAD suites, finite
field DHE, renegotiation, SHA-1 signatures, RSA keys under 2048 bits, certificates identified only
by subject CN.

## Non-guarantees

- **No revocation checking.** No CRL, no OCSP, stapled OCSP responses are ignored. A revoked but
  unexpired certificate is accepted.
- **No Certificate Transparency enforcement.** SCTs are not required or checked.
- **Root store freshness is the app's release cadence.** The roots are a snapshot (see below).
  Removing a distrusted CA or adding a new one needs `npm run build:roots` and a release. The same
  holds for security fixes in rustls, webpki and ring: `Cargo.lock` pins them, and a fix needs
  `npm run build:wasm` and a release.
- **Mozilla's per-root restrictions are not applied.** The curl bundle carries the roots trusted
  for websites but not Mozilla's "distrust after" dates or other partial-distrust rules. A CA that
  browsers trust only for certificates issued before some date is trusted here without that limit.
- **Trust anchors are not checked for expiry**, as is conventional: an expired root stays trusted
  until it is removed from the bundle.
- **Side channels.** ring's primitives are written to be constant-time, and with no AES hardware
  it falls back to its portable software AES and GHASH (believed bitsliced and constant-time; we did
  not review that code). That code is then compiled to wasm and JIT
  compiled by the browser, which gives no constant-time guarantee, and nobody has measured it in
  this configuration. Keys and plaintext live in wasm linear memory and in JS buffers; they are
  not reliably zeroised. Without cross-origin isolation the worker may share a process with other
  origins, so Spectre-class attacks on that memory are the browser's site-isolation problem, not
  something this package mitigates. Record sizes and timing are visible to the proxy; there is no
  padding.
- **The clock is trusted.** A wrong device clock produces `cert-expired` or `cert-not-yet-valid`,
  and a clock set far in the past would accept an expired certificate.
- **No pinning, no HSTS, no client certificates, no ECH** (the SNI is sent in clear), **no
  post-quantum key exchange** (ring has no ML-KEM; X25519MLKEM768 is not offered).

## Root store

`src/generated/mozilla-roots.ts`, generated by `npm run build:roots`:

| | |
| --- | --- |
| Source | https://curl.se/ca/cacert.pem (the curl project's extract of the Mozilla CA list) |
| Upstream bundle date | Thu Nov 5 04:12:01 2026 GMT |
| SHA-256 of `cacert.pem` | `427c064216761a1e72a8b30f0d954d08cb6e4435a82091fb865afd20c8497285` |
| Generated | 2026-11-25 |
| Roots | 118 (RSA-4096: 59, P-384: 35, RSA-2048: 20, P-256: 3, P-521: 1) |
| Licence | The certificate data is under the **Mozilla Public License 2.0**. |

Each root is reduced to subject, public key and name constraints (extracted by webpki itself, no
ASN.1 parsing in JavaScript): 54 kB packed, shipped as a base64 module that is only loaded when
`RootStore.mozilla()` is first called. `src/generated/mozilla-roots.json` records the provenance.

The hash above matches the `cacert.pem.sha256` that curl.se publishes, but both were fetched from
the build container, whose outbound HTTPS passes through a TLS-inspecting gateway. Re-run
`npm run build:roots` (or compare the hash) from an independent network before a release.

## Sizes

`npm run sizes`, esbuild minified:

| Part | Raw | gzip | brotli |
| --- | --- | --- | --- |
| Client JS (index + wasm glue + root store class) | 14.4 kB | 5.3 kB | 4.7 kB |
| TLS engine wasm | 549.0 kB | 225.6 kB | 180.4 kB |
| **Client total** | **563.4 kB** | **230.9 kB** | **185.1 kB** |
| Mozilla root store chunk (lazy) | 72.7 kB | 46.3 kB | 45.1 kB |
| Tunnel transport (`./tunnel`) | 1.5 kB | 0.8 kB | 0.7 kB |

The wasm is built with `opt-level = "s"` and LTO and has not been through `wasm-opt`, which
typically saves a further 5 to 15 percent.

## Tests and measurements

`npm test` (vitest, 58 tests, about 5 s; also `BH_TEST_PENDING=1 npx vitest run packages/tls` from
the repo root). A `node:tls` server with a CA generated in memory at test time, reached over an
in-memory duplex and over loopback TCP:

- 5 MB echo with awkward chunk boundaries in both directions, TLS 1.3 and 1.2, both transports;
  every TLS 1.3 suite; four TLS 1.2 suites; X25519, P-256 and P-384 key exchange.
- Server certificates: ECDSA P-256, ECDSA P-384, Ed25519, RSA-2048 through an intermediate; RSA
  handshake signatures with PSS and with PKCS#1 v1.5.
- ALPN selection, no ALPN, no protocol in common; SNI as seen by the server.
- Rejections: untrusted CA, empty and wrong root stores, self-signed leaf, missing intermediate,
  wrong hostname, parent and child domains, wildcard depth, CN without SAN, IP literal against DNS
  SAN, expired and not-yet-valid (real certificates and via the injected clock), expired
  intermediate, issuer that is not a CA, leaf without serverAuth, tampered signature, P-521 CA and leaf, forged issuer
  with a copied name, malformed custom roots, non-ASCII server names.
- Versions: TLS 1.2-only server connects with 1.2; TLS 1.3-only server connects with 1.3; each
  fails with `protocol-version` when the caller excludes that version; TLS 1.1-only server fails
  with `protocol-version`; a 1.2 server offering only RSA key exchange or CBC fails with
  `handshake-failed`.
- Closing: clean close_notify, EOF without close_notify (`truncated`, both versions), abrupt TCP
  close, `allowUncleanEof`, half-close with `end()`, `close()`, abort of a stalled handshake.
- Hostile peers: HTTP reply, random bytes, an oversized record, an SSH banner, immediate close, a
  truncated handshake flight, garbage after the handshake, a flipped ciphertext bit, a failing
  transport write.

`npm run e2e` (Playwright, headless Chromium): the same client in a dedicated module worker, over
a WebSocket to a test-only relay (`e2e/relay.mjs`, tunnel-mode framing, destination allowlist), to
local `node:https` servers. It asserts `crossOriginIsolated === false` in the page and the worker
and that `SharedArrayBuffer` is undefined, makes an HTTP/1.1 GET and reads a chunked response
whose five chunks arrive 80 ms apart, checks the response ends with close_notify, checks
`cert-untrusted` (bundled Mozilla roots against the test CA, which also exercises the lazy chunk)
and `cert-name-mismatch`, and prints timings.

Measured in the worker, Chromium 158 headless, x86-64 Linux container, everything on loopback
(two runs; the server is OpenSSL in the same machine, so these are upper bounds for the client's
own cost, not network numbers):

| | |
| --- | --- |
| wasm fetch + compile + instantiate | 9 ms |
| Full handshake, TLS 1.3, ECDSA P-256 leaf | median 2.2 to 2.9 ms (n = 20) |
| Full handshake, TLS 1.2, ECDSA P-256 leaf | median 3.1 to 3.2 ms |
| Full handshake, TLS 1.3, RSA-2048 leaf + intermediate | median 3.4 to 3.7 ms |
| Tunnel setup (WebSocket + TCP connect), for scale | median 8 ms |
| Bulk, ChaCha20-Poly1305 | 84 to 86 MB/s down, 84 to 92 MB/s up |
| Bulk, AES-128-GCM | 39 to 40 MB/s down, 40 MB/s up |
| Bulk, AES-256-GCM | 33 to 35 MB/s down, 32 to 35 MB/s up |

Bulk is 32 MB over HTTP through the relay, timed in the worker, including the WebSocket hop.

`npm run e2e:public` (off by default) additionally handshakes with a real host (default
`example.com`, override with `BH_TLS_PUBLIC_HOST`) using the bundled Mozilla roots and sends only
`HEAD /`. In the container this package was built in, it **cannot pass**: outbound port 443 is
transparently intercepted and re-signed by an egress gateway CA, which the client correctly
rejects with `cert-untrusted: UnknownIssuer`. So the bundled root set has not yet been exercised
against a real public chain. Run it once from an unfiltered network.

## Known gaps

- Not validated against real public servers (see above) and tested against one TLS
  implementation only (OpenSSL via Node). No interop run against BoringSSL, Go, Schannel or NSS
  servers; rustls itself has broad interop coverage upstream.
- Not run in Firefox or Safari. It needs only wasm, `ReadableStream`, `WebSocket` and
  `crypto.getRandomValues` in a worker, all long supported, but that is reasoning, not a test.
- A strict Content-Security-Policy must allow wasm compilation (`script-src 'wasm-unsafe-eval'`).
- Servers that omit an intermediate fail with `cert-untrusted`. Browsers often hide this by
  fetching or caching intermediates; this client does not.
- The one P-521 root in the bundle (e-Szigno TLS Root CA 2023) cannot be used: ring has no P-521,
  so chains to it fail closed (tested with a synthetic P-521 CA). Ed448 and RSA keys above 8192 bits likewise.
- No HTTP. `h2` can be negotiated with ALPN but there is no HTTP/2 implementation here.
- No handshake timeout unless the caller passes `signal`.
- Resumption is off, so every connection costs a full handshake (about 3 ms of CPU here).
- The third-party licence texts for the code inside the shipped wasm (rustls, webpki, ring and
  ring's BoringSSL-derived parts, subtle, wasm-bindgen runtime) are not yet bundled as a notices
  file; add one before distributing.
- `src/tunnel.ts` follows `PROTOCOL.md` but has only been run against the test relay, not the
  real proxy.

## Rebuilding

```sh
npm run build:wasm    # needs rustc + wasm32-unknown-unknown, clang, wasm-bindgen-cli 0.2.130
npm run build:roots   # downloads cacert.pem; or: node scripts/build-roots.mjs path/to/cacert.pem
npm run sizes
```

`src/generated/` is checked in so consumers need no Rust toolchain. `wasm-build.json` records the
wasm hash, compiler and crate versions. The build is not verified to be bit-for-bit reproducible.
No private keys or certificates are stored in this package; the test PKI exists only in memory.
