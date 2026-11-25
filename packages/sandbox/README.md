# @beamhop/sandbox

A computer in a browser tab. The app embeds a *machine frame* from another origin; inside it one dedicated
worker runs a small kernel, an emulation of Node.js, and a shell. Unmodified JavaScript coding-agent harnesses
(pi, Gemini CLI) run there as ordinary programs. No SharedArrayBuffer, no cross-origin isolation, no network
access from the machine itself. Design: `docs/universal-sandbox.md` (this package is the core of Phase 1).

Status: tested in headless Chromium only. Not tested in Safari, Firefox or on phones.

## Architecture

```
 app page (origin A)                         machine frame (origin B, one per workspace)
 ┌──────────────────────────┐  postMessage   ┌───────────────────────────────────────────────┐
 │ createMachine()  client.ts│ ─ hello/init ─►│ machine.html + frame.js   (hands the port on)  │
 │   typed methods, watchdog │               │ ┌─────────────────────────────────────────────┐│
 │   MachineNet (app-provided)│◄─MessagePort─►│ │ worker.js — one thread                      ││
 │     openSocket ─► proxy   │  protocol.ts  │ │  frame/worker.ts   requests, events, broker ││
 │     openHttp   ─► proxy   │               │ │  kernel/           VFS · processes · pipes  ││
 └──────────────────────────┘               │ │  kernel/programs/  bash + tools (just-bash) ││
                                             │ │  node/             the `node` program       ││
                                             │ │  esm-transform.js  loaded on demand         ││
                                             │ └─────────────────────────────────────────────┘│
                                             └───────────────────────────────────────────────┘
```

| Directory | What it is |
|---|---|
| `src/protocol.ts`, `src/rpc.ts` | The wire contract and its envelope layer (requests by id, events). |
| `src/client.ts` | What the app imports. Embeds the frame, handshake, typed async API, network translation, watchdog. No Node dependencies. |
| `src/frame/` | `machine.html`, the page script (starts the worker, passes the port to it) and the worker entry. |
| `src/kernel/` | `Vfs` over `FsBackend`s (`MemFs` writable, `ImageFs` read-only mounts), `BlockStore` storage seam, `Pipe`, `Process`/`Program`, `Kernel` (process table, PATH and shebang resolution, signals), `NetBroker`. |
| `src/kernel/programs/` | Program kinds besides `node`: the shell and its tools (just-bash), `which`, `xdg-open`. |
| `src/node/` | The Node layer: module loader (CJS and ESM), `process`, `fs`, `child_process`, `net`/`tls`/`http`/`https`/`fetch`, other built-ins on polyfill packages. |
| `src/esm/` | ES module → `System.register` transformer (acorn + magic-string). Used by the image builder ahead of time and by the worker as a lazy fallback. |
| `src/image/` | Image format (isomorphic) and builder (Node). |
| `src/harness/` | Declarative harness registry: pi, gemini. |
| `src/machine.ts` | Assembles kernel + programs + image mounting. The worker uses it; so do the unit tests, under Node. |

How the pieces behave:

- **One thread.** Kernel, file system and every process share the worker's thread. `fs.readFileSync` and `require`
  are direct calls into the VFS; that is what makes SharedArrayBuffer unnecessary. The price is listed under
  Limitations.
- **Processes.** `kernel.spawn` resolves a command (PATH, `#!` lines, `#!virtual <kind>` stubs for built-in
  programs) to a `Program` and gives it a `Process`: pid, argv, env, cwd, three `Pipe`s, an exit status, an abort
  signal for termination. `Program` is the seam for wasm (WASI + JSPI) programs; the rules their prototype
  established are written on the interface (`src/kernel/process.ts`).
- **Node programs** do not run on a port of Node. Guest code is evaluated by the browser's engine inside function
  wrappers whose parameters are the per-process globals (`process`, `Buffer`, timers, `console`, `globalThis`…),
  so several Node processes can share the realm (`src/node/globals.ts` explains the limits).
- **ES modules** cannot be evaluated from a string with a custom loader, so they run in `System.register` form.
  The image builder transforms every module the harness entry can reach; anything else (files written or
  installed at run time) is transformed in the worker by the same code, loaded with `importScripts` on first use.
- **Network.** The machine never opens a connection. `net.Socket` becomes `sock.open` + `sock.*` events to the app
  (tunnel mode: raw TCP through the proxy), or, in http mode, the socket parses the HTTP/1.1 the program writes
  and each request becomes one `http.open` (the proxy's plain mode). The mode is chosen per boot.
  TLS in tunnel mode is a hook (`Kernel.connectTls`, type `TlsConnector` in `src/kernel/net.ts`, shaped to take
  `packages/tls`'s `connectTls`); it is **not installed yet**, so `tls.connect` and `https:` fail with
  `ERR_TLS_NOT_AVAILABLE` in tunnel mode. In http mode the proxy terminates TLS and `https:` works.

## Build and test

```sh
npm install                      # inside packages/sandbox, until the package is in the root workspace
npm run build                    # dist/site (machine origin) and dist/lib (library), prints bundle sizes
npm run build:image -- pi        # images/pi-<hash>.bhi + images/images.json (npm-installs the pinned release)
npm run typecheck                # or, from the repo root: npx tsc -p packages/sandbox
npm test                         # unit tests; from the repo root: BH_TEST_PENDING=1 npx vitest run packages/sandbox
npm run e2e                      # browser end-to-end test (builds first; builds the pi image if missing)
node test/e2e/run.mjs --repeat 3 # the same, three rounds
```

- Unit tests run the kernel and the Node layer under Node: VFS and mounts, image format, module and program
  resolution, the HTTP/1.1 codec and socket bridge, the transformer (by running its output), processes, pipes,
  the shell, `child_process`, networking against in-memory brokers, the TLS hook with a stand-in connector.
  `test/harness-node-host.test.ts` runs a full pi (and gemini) turn on the kernel under Node; it is skipped for a
  harness whose image has not been built.
- The e2e test serves a host page on `http://localhost` and the built machine frame on `http://127.0.0.1`
  (different origins and sites) with the CSP below on every response, drives the machine through `client.ts`
  only, and implements `net` against a test-only proxy that speaks `packages/proxy/PROTOCOL.md`. Scenarios: a
  full pi turn in tunnel and in http mode against a scripted mock model (gemini too when its image exists);
  stdin, kill, open-url, spawn errors, dispose; a worker frozen by `while (true) {}`; ES modules written at run
  time.
- **No real provider is ever contacted.** The mock model is local, and the test proxy refuses every destination
  that is not on its allow-list (the mock's host:port) before any lookup or connection; the e2e asserts that an
  attempt to reach `example.com` is refused.

`dist/`, `images/`, `.cache/` and `node_modules/` are build outputs and are git-ignored.

## Serving the frame: CSP

Serve `dist/site/` and the images from the machine origin with this header **on every response** (a worker takes
its policy from the response that delivered its script, not from the page):

```
Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-eval'; worker-src 'self'; connect-src 'self'; frame-ancestors <app origin>; base-uri 'none'; form-action 'none'
```

- `script-src 'self'`: `frame.js`, `worker.js`, and `esm-transform.js` (pulled in with `importScripts`). There is
  no inline script or style in `machine.html`.
- `'unsafe-eval'`: required, and the reason the origin is the wall. The loader evaluates every guest module with
  indirect `eval`; it compiles (without running) ambiguous `.js` files with `new Function` to tell CommonJS from
  ESM, as Node does; and harnesses compile WebAssembly from bytes (undici's HTTP parser in pi). `'wasm-unsafe-eval'`
  alone covers only the last of these.
- `worker-src 'self'`: the kernel worker.
- `connect-src 'self'`: the worker fetches images from its own origin and nothing else. This directive, not the
  emulation, is what guarantees the machine has no network of its own: guest code can reach the worker's real
  `fetch` (`(0, eval)('this').fetch`), and the e2e test checks that the browser refuses it.
- `frame-ancestors`: the origin(s) allowed to embed the machine. The frame accepts `machine-init` only from its
  parent window and has no secrets before that.
- Do **not** send `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`; nothing here needs isolation.
- The app's own CSP needs `frame-src <machine origin>`. The client creates the iframe with
  `sandbox="allow-scripts allow-same-origin"`.

## Client API

```ts
import { createMachine, getHarness, NetFailure, type MachineNet } from '@beamhop/sandbox'

const machine = createMachine({
  frameUrl: 'https://<workspace>.machines.example/machine.html',
  container: document.body,                 // the invisible iframe is attached here
  net,                                      // MachineNet, implemented by the app (below)
  onOpenUrl: (url) => { /* a program ran xdg-open: decide whether to open a tab */ },
  onLog: (level, message) => {},
  watchdog: { timeoutMs: 5000, onUnresponsive: ({ silentMs, phase }) => {}, onResponsive: () => {} },
})
await machine.boot({ workspaceId, env: {}, net: 'tunnel' })      // 'tunnel' | 'http' | 'none'
const pi = getHarness('pi')
await machine.mount(pi.mountAt, 'images/pi-<hash>.bhi')            // URL on the machine origin, or an ArrayBuffer
const run = pi.headless({ prompt, endpoint: { baseUrl, apiKey, model } })
for (const [path, content] of Object.entries(run.files)) await machine.fs.write(path, content)
const proc = await machine.spawn(run.argv, { env: run.env, cwd: '/work', stdin: run.stdin })
proc.stdout                      // ReadableStream<Uint8Array>; also proc.stderr
await proc.write('text'); await proc.end(); await proc.kill('SIGTERM')
const { code, signal } = await proc.exit
await machine.fs.read(path)      // also readText, write, list, stat (null if missing), remove, mkdir
machine.dispose()                // removes the frame: worker, processes and files are gone
```

`MachineNet` is two functions: `openSocket({ host, port }, { data, end, close })` resolving to
`{ write, end, close }` once connected, and `openHttp({ url, method, headers, body, signal })` resolving to
`{ status, headers, body: ReadableStream | null }`. Reject with `NetFailure(code, message)`; the code (`policy`,
`dns`, `connect`, …) reaches the program as a Node-style error. Request bodies arrive whole. Response bodies must
be handed over decoded, and redirects must not be followed (the machine follows them). A reference
implementation against the proxy protocol is `proxyNet` in `test/e2e/host.ts`.

The watchdog reports, it does not act: the machine emits a heartbeat every 250 ms from the kernel thread, and
`onUnresponsive` fires once when none arrives for `timeoutMs` (also if the frame never completes the handshake).
A machine that stays frozen is replaced by `dispose()` and a new `createMachine()`.

## Image format (`.bhi`)

A read-only file tree plus an ES module compile cache, in one file (`src/image/format.ts`):

| Offset | Size | Field |
|---|---|---|
| 0 | 8 | magic, ASCII `BHIMAGE1` |
| 8 | 4 | flags, u32 LE. Bit 0: payload is gzip-compressed |
| 12 | 4 | index length in bytes, u32 LE (uncompressed) |
| 16 | 8 | payload length in bytes, u64 LE (uncompressed) |
| 24 | 32 | SHA-256 of the uncompressed payload |
| 56 | … | payload = index (UTF-8 JSON) followed by the blob; one gzip stream when bit 0 is set |

Index: `{ v: 1, meta, dirs: [path], files: [[path, offset, length, mode]], links: [[path, target]], esm: [[path, offset, length]] }`.
Offsets are relative to the blob. Paths are relative to the image root; the mount point is chosen at mount time.
`esm` holds the precompiled `System.register` form of a source file, keyed by that file's path. `meta.bin` maps
command names to scripts; mounting links them into `/usr/bin`.

The file is named `<name>-<first 16 hex of the hash>.bhi`, so it can be served `immutable`; `images.json` next to
it maps names to current files. The worker decodes the stream into one buffer and serves file contents as views
of it (no per-file copy). The builder packs what `npm install --ignore-scripts` wrote, byte for byte, except
source maps, `.d.ts` files and files over 30 MB.

## Adding a harness

1. Add a `HarnessDefinition` to `src/harness/index.ts`: pinned npm spec, image name, mount point, command and
   entry script, the environment it always needs, and a `headless()` that returns argv, env and config files for
   a non-interactive run. Harness-specific switches (such as `GEMINI_CLI_NO_RELAUNCH`) belong here, never in
   `src/node`.
2. `npm run build:image -- <name>`. Check the output for modules that failed to precompile and for
   `precompileExtra` candidates (files reached through computed `import()`).
3. Add it to `cases` in `test/harness-node-host.test.ts` and run it under Node first: failures there are Node
   layer gaps, and the turnaround is seconds. The layer logs every unimplemented API a program touches
   (`onLog`, `node-exit … unusual`).
4. Add it to `HARNESSES` in `test/e2e/run.mjs`.

Only harnesses published as JavaScript can run. Claude Code is native since 2.1.113 and is out of scope here.

## Known limitations

- **No pre-emption.** A program in a synchronous loop freezes the whole machine, heartbeat included. It cannot
  be killed from inside; the watchdog reports it and the app replaces the machine. `kill` works on any process
  that yields: it stops receiving timers and I/O and its output is dropped, but JavaScript already on the stack
  runs until it next returns to the event loop. `process.exit()` throws a sentinel for the same reason.
- **No real `spawnSync`/`execSync`/`execFileSync` of children that need to wait.** They work for `which` (and
  `command -v`), which the kernel answers synchronously; anything else is reported as `ENOENT` and logged once per
  command. Harnesses mostly use these to probe for optional tools.
- **`AsyncLocalStorage` is an approximation**: exact for synchronous code, "sticky" across `await`. Two
  concurrent `run()` calls can see each other's store. gemini uses it.
- **No TTY, no interactive mode.** stdio are pipes; `isTTY` is false everywhere.
- **No persistence.** Files live in memory and die with the frame. `BlockStore` and `FsBackend` are the seams for
  OPFS/SQLite; nothing implements them durably yet. Writes under an image mount fail with `EROFS`.
- **TLS in tunnel mode is pending** (see Network above).
- Shell: just-bash delivers a script's output when the script ends, has no `trap` or job control, and offers only
  its built-in commands plus `node`, `xdg-open` and mounted harness commands. No `git`, no `npm`.
- Node layer gaps that throw a recognisable error when used: `crypto` ciphers/signing/key objects, brotli and
  zstd, `http2`, `worker_threads.Worker`, `child_process.fork` (no IPC), `dgram`, native add-ons, `vm` contexts
  (approximated), Unix sockets. `net`/`http` servers accept `listen()` but nothing can connect to them.
  HTTP request bodies are buffered. `process.version` reports v22.12.0.
- Sharing one realm: a program that replaces web globals (undici's `install()` replaces `Response`, `Headers`,
  `WebSocket`, …) replaces them for every Node process in the machine. Uncaught errors that surface on the worker
  global are attributed to the most recently started Node process.
- Memory: a mounted image is one buffer of its uncompressed size (pi 77 MB, gemini 153 MB) on top of the JS heap.
- The watchdog cannot tell a frozen machine from a long synchronous computation; pick `timeoutMs` accordingly.
