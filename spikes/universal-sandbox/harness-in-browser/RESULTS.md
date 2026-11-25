# Spike: unmodified coding-agent CLIs on the browser's JS engine, in one worker

Run: `npm install && npm run spike` (installs the harnesses into `harnesses/`, builds, runs; roughly 5 minutes
the first time, not timed end to end, about 1.5 minutes for `npm run spike:run` afterwards). Prints one JSON document and writes
`results.json`. `node scripts/dev.mjs <pi|gemini|claude> [--ses] [--tunnel] [-- args]` runs one invocation and
dumps stdout, stderr and the emulation layer's logs.

**Machine caveat.** Every number comes from one run on 2026-11-25 in headless Chromium 158.0.8127.36
(Playwright) in a cloud container: 4 vCPU Xeon @ 2.30 GHz, 15.7 GB RAM, Linux, everything on localhost.
It is not a phone and not a desktop browser. Nothing was tested in Safari/iOS or Firefox and nothing below
says anything about them. Timings are medians of 5 runs, each in a fresh worker.

## Summary

| Harness (npm) | `--version` | `--help` | Full agent turn, plain JS, CORS proxy | Same, blind WebSocket tunnel | Same, under SES |
|---|---|---|---|---|---|
| pi `@earendil-works/pi-coding-agent@1.6.0` | ok | ok | **pass** | **pass** | **pass** (needs a 2-line SES patch and extra endowments) |
| Gemini CLI `@google/gemini-cli@0.71.1` | ok | ok | **pass** | **pass** | **pass** (same patch and endowments) |
| Claude Code `@anthropic-ai/claude-code@2.1.112` (last JS release) | ok | ok | **pass** | **pass** | **fail**: the Bash tool throws, see Hardened JS |
| Claude Code `@anthropic-ai/claude-code@2.1.332` (current) | not runnable: native binary only | | | | |

"Full agent turn" means: the harness, unmodified, runs headless against a scripted mock model server; the
mock makes it call its file-write tool, then its shell tool (`cat hello.txt && echo lines=$(wc -l < hello.txt)`),
then give a final answer that echoes the shell output. A turn passes only if all of these hold, checked by
`scripts/run.mjs` in every one of the 5 runs: exit code 0; `/work/hello.txt` exists in the virtual fs with the
expected bytes; the shell command ran in just-bash with exit 0; the mock saw the three steps; the shell output
(`hello from the universal sandbox`, `lines=1`) reached the mock in the tool result; the final answer arrived
on the harness's stdout; and the mock was reached only through the proxy under test (proxy request count =
mock request count and zero relay connections, or the reverse).

In the worker and the page: `crossOriginIsolated === false`, `typeof SharedArrayBuffer === "undefined"`.
The static server sends no COOP/COEP headers. (`Atomics.wait` exists as a function but there is nothing to
wait on.)

Things that should change the design are collected under "Design consequences" at the end.

## What was built

| File | What |
|---|---|
| `src/worker.js` | The single dedicated worker: fetches the image, mounts it, sets up the evaluator (plain indirect `eval`, or SES `lockdown()` + one `Compartment`), boots the emulation layer, runs the harness, reports |
| `src/runtime/vfs.js` | In-memory file system (files, directories, symlinks, hard links); image files are zero-copy views of the image `ArrayBuffer` |
| `src/runtime/fs.js` | `fs`, `fs/promises`: sync API as direct calls, callback and promise APIs on top, file descriptors, streams, `watch` |
| `src/runtime/loader.js` | Node module resolution (`exports`/`imports` conditions, self-reference, `node:`), CommonJS loader, and an ESM loader implementing the `System.register` linking protocol (live bindings, cycles, top-level await, `import()`, `import.meta`, `require(esm)`, ESM importing CJS/JSON/built-ins), plus `node:module` |
| `src/runtime/process.js` | `process`, stdio, Node-style timers (`ref`/`unref`/`refresh`), `setImmediate`, and a ref-counted liveness tracker that decides when "the event loop is empty" |
| `src/runtime/net.js` | `net.Socket`, `tls.connect`, `http`/`https` client, global `fetch`, in two proxy modes (below) |
| `src/runtime/child_process.js` | `spawn`/`exec`/`execFile` backed by just-bash on the same VFS; `execSync`/`spawnSync`/`execFileSync` fail and are logged |
| `src/runtime/builtins.js` | `buffer`, `events`, `stream` (+`promises`, `consumers`, `web`), `util`, `path`, `os`, `tty`, `readline`, `crypto`, `zlib`, `async_hooks`, `url`, `timers`, `console`, `vm`, `v8`, `perf_hooks`, `worker_threads`, `dns`, `diagnostics_channel`, and stubs for `http2`, `inspector`, `cluster`, `dgram`, `domain`, `repl`, `wasi`, `trace_events` |
| `scripts/build.mjs`, `scripts/babel-worker.mjs` | Bundle the worker (esbuild), pack each harness into an image, precompile reachable ESM |
| `scripts/run.mjs`, `scripts/scenarios.mjs`, `scripts/heap-sampler.mjs` | Playwright driver, per-harness configuration, heap sampling over CDP |
| `scripts/scan-sync.mjs` | Static scan for synchronous child-process calls |
| `servers/mock-model.mjs` | Mock model: OpenAI chat completions SSE, Anthropic Messages SSE, Gemini `streamGenerateContent` SSE / `generateContent` |
| `servers/cors-proxy.mjs`, `servers/ws-relay.mjs`, `servers/static.mjs` | Plain-mode CORS proxy, blind WebSocket-to-TCP relay, static server |

The emulation layer is my own code (about 170 KB of source) over existing polyfill packages. The worker
bundle is 2.71 MB unminified (0.59 MB gzip); 1.26 MB of that is just-bash.

### Base evaluation: almostnode and Nodepod (about 20 minutes)

- **almostnode 0.2.14 (MIT).** No SharedArrayBuffer needed. I loaded pi's `node_modules` into its VFS and
  ran pi's entry (under Node, not in a browser, to iterate quickly; script not kept in the repo). It failed
  at the first statement: `TypeError: enableCompileCache is not a function` (`node:module`). Starting one file
  later (`cli-runtime.js`) failed with `SyntaxError: Unexpected token 'const'`: its acorn/regex ESM-to-CJS
  rewrite breaks on the bundle's first line (`import {createRequire} ...; const require = ...`). Its transform
  has no top-level await and no live bindings, which Gemini CLI's entry needs. Its shims are TypeScript tied
  to its own VFS and dev-server features. Not adopted.
- **Nodepod (`@r1ck404/nodepod` 1.11.2).** Not run. Two reasons: its licence is "MIT WITH Commons-Clause"
  (the Commons Clause removes the right to sell, so it is not usable as a product base without a separate
  agreement), and its README states "Full synchronous and threaded behaviour requires cross-origin
  isolation and `SharedArrayBuffer`" with a reduced path otherwise.

### Adopted packages and licences

Bundled into the worker: just-bash 3.6.1 (Apache-2.0), ses 2.3.0 (Apache-2.0, loaded as its own script),
buffer 6.0.3, events 3.3.0, readable-stream 4.8.0, util 0.12.5, path-browserify 1.0.1, assert 2.1.0,
fflate 0.8.3, @noble/hashes 2.4.0, string_decoder 1.3.0, url 0.11.4, punycode 2.3.1 (all MIT),
querystring-es3 0.2.1 (no `license` field in its package.json; licence not verified), plus their small transitive dependencies. Build and test machine only: esbuild 0.28.2,
@babel/core 8.1.3, @babel/plugin-transform-modules-systemjs, @babel/plugin-transform-dynamic-import, ws
8.23.0 (all MIT).

### ESM: transformed ahead of time on the build machine

The harness files in the image are byte-identical to what `npm install` wrote. ESM cannot be evaluated by
`eval`, a `Compartment`, or anything else that works without a module loader hook, so each ESM file the
harness can reach is transformed by Babel to `System.register` form at build time and shipped in the image
as a compile cache keyed by path (pi: 84 files, 10.3 MB; gemini: 24 files, 18.1 MB; claude: 1 file, 13.8 MB).
The set is the static import closure of the bin entry plus string-literal `import()` targets, found with the
same resolver the worker uses. For Gemini CLI three files reached through computed `import()` had to be
listed by hand. An ESM file that is not in the cache fails to load with an explicit error; this spike has
**no in-worker transformer**.

A real system needs one: for packages installed at run time, for pi's extension loader (jiti), and for
anything the tracer cannot see. Options: Babel standalone in the worker (slow: the 17 MB Gemini chunk needed
roughly 2 GB and tens of seconds in Node), swc compiled to wasm, or a purpose-built `es-module-lexer`-based
rewrite. esbuild-wasm cannot emit `System.register` and its CJS output cannot express top-level await, which
Gemini's entry uses. CommonJS files are loaded as-is; the only rewrite is `import(` to a loader call.

## Per-harness detail

### pi

npm name: `@mariozechner/pi-coding-agent` is deprecated ("please use @earendil-works/pi-coding-agent");
1.6.0 is an esbuild-split ESM bundle (80 chunks) with undici bundled in. Run as
`pi --mode json --model mock/mock-model --no-session --offline "<prompt>"` with a custom provider in
`~/.pi/agent/models.json` (`api: "openai-completions"`, `baseUrl` = mock).

Its HTTP does not use the platform `fetch`: it installs its bundled undici as `globalThis.fetch`, and undici
speaks HTTP/1.1 over `net.connect`. So pi exercises `net.Socket` directly in both proxy modes, with undici's
own llhttp wasm parser running in the worker. 34 ESM modules (5.6 MB of source) are evaluated in a turn.

What had to be added to make it run, in order: `module.enableCompileCache`; `stream.finished()` on a web
`ReadableStream`; `performance.markResourceTiming`; PATH stubs for just-bash built-ins.

### Gemini CLI

0.71.1 ships `bundle/gemini.js` (ESM, top-level await) plus several generations of 17.5 MB chunks (118 MB
on disk). Optional native add-ons: `node-pty`, `@lydell/node-pty-*`, `@github/keytar`. Run as
`gemini -p "<prompt>" --yolo --output-format json` with `GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL` = mock,
and two environment variables that are needed for reasons unrelated to the browser:
`GEMINI_CLI_TRUST_WORKSPACE=true` (headless trust check; the native run needs it too) and
`GEMINI_CLI_NO_RELAUNCH=true`. Without the latter the launcher re-spawns itself with
`spawn(process.execPath, ..., { stdio: [..., 'ipc'] })` to set V8 heap flags; a second Node process with an
IPC channel is not something this layer provides. It uses the platform `fetch` (4 requests: one
`generateContent` routing call, three `streamGenerateContent`).

Observed while running: `git rev-parse --show-toplevel` (twice, answered `ENOENT`); loading `pty.node`
(fails, Gemini falls back to `child_process`); its shell wrapper uses `trap`, which just-bash does not have,
so the tool result contains an extra line `bash: trap: command not found` (the command itself runs and the
turn passes); 6 `AsyncLocalStorage` instances with async `run()` (see the missing-API list).

### Claude Code

`@anthropic-ai/claude-code@2.1.332` is a launcher: `bin/claude.exe` is a 402 MB x86-64 ELF executable
(hard link of `@anthropic-ai/claude-code-linux-x64/claude`), with one optional dependency per platform.
There is no JavaScript entry. `@anthropic-ai/claude-agent-sdk@0.3.332` has the same per-platform optional
dependencies. A binary search over the registry shows **2.1.112 is the last release with `bin: cli.js`**
(13.7 MB single-file ESM) and 2.1.113 the first native-only one.

2.1.112 runs: `claude -p "<prompt>" --output-format json --dangerously-skip-permissions` with
`ANTHROPIC_BASE_URL` = mock and `ANTHROPIC_API_KEY`. It uses the platform `fetch` (a `HEAD /` probe and three
`POST /v1/messages?beta=true`). It spawns its vendored ripgrep (an ELF file) 9 times at startup; the layer
maps a native executable whose basename is a just-bash built-in (`rg`) to that built-in. It opens a file,
passes the descriptor as the child's stdout, and closes it before the child finishes, so `spawn` needed
`dup` semantics. It calls `bash -c -l <script>`. It calls `spawnSync("which", ...)` three times (below).

### Codex and opencode (registry only, not run)

- `@openai/codex@0.172.0`: 13 KB package, `bin: bin/codex.js`, six optional dependencies of the form
  `npm:@openai/codex@0.172.0-<platform>`. The JS file is a launcher for a per-platform native binary.
- `opencode-ai@1.19.6`: 8 KB package, `bin: bin/opencode.exe`, twelve per-platform optional dependencies
  (`opencode-linux-x64`, `-musl`, `-baseline`, ...). Native binary per platform.

I did not download the platform packages; the statement that they contain native executables rests on the
package layout.

## Missing or misbehaving Node APIs

Hit while bringing up the three harnesses, in the order found. "Shimmed" means the spike script passes with
the fix in place.

| # | Harness | Symptom | Cause | Outcome |
|---|---|---|---|---|
| 1 | pi | `enableCompileCache is not a function` | `node:module` API from Node 22 | shimmed (no-op) |
| 2 | pi | fetch aborted right after headers | undici calls `stream.finished(webReadableStream)`; Node peeks at internal stream state, a browser exposes none; readable-stream's version throws | shimmed: guest code gets a `ReadableStream` subclass that records closed/errored. A native stream the guest did not construct cannot be observed (callback never fires) |
| 3 | pi | `markResourceTiming is not a function` | Node-only `performance` method | shimmed (no-op) |
| 4 | pi | `bash: cat: command not found` | just-bash resolves commands through `$PATH` on the file system it is given | shimmed: stub files for its built-ins in `/usr/bin` and `/bin` |
| 5 | gemini | `getDefaultHighWaterMark3 is not a function` | named ESM import from a built-in whose export object is a function with inherited statics | shimmed (namespace synthesis walks inherited and non-enumerable properties) |
| 6 | claude | `No such built-in module: node:stream/consumers` | missing built-in | shimmed |
| 7 | gemini | prints `An unexpected critical error occurred: process.exit(0)` | `process.exit()` cannot stop JavaScript; the layer throws a sentinel, which the harness's own `catch` sees | mitigated: output written after exit is dropped. Code after `process.exit()` still runs until it next yields |
| 8 | claude, gemini | silent exit code 0 while a response was streaming | the liveness tracker did not count an in-flight `fetch` body | shimmed (request holds a handle until the body ends or is cancelled) |
| 9 | claude | `rg` exits 1 | spawn of a vendored ELF binary | shimmed for names just-bash implements; any other native executable fails as `command not found` |
| 10 | claude | `bash: -l: command not found` | `bash -c -l <script>` | shimmed |
| 11 | claude | Bash tool returns no output, then hangs | stdout passed as an fd that the parent closes before the child writes | shimmed (`dup` at spawn time) |
| 12 | gemini | hangs forever after `git` is not found | execa needs Node's exact `ENOENT` sequence: no `spawn` event, `error`, stdio destroyed, `close` | shimmed |
| 13 | gemini | would hang at start | self-relaunch via `spawn(process.execPath)` with IPC | avoided with `GEMINI_CLI_NO_RELAUNCH=true`; spawning Node itself is not implemented |
| 14 | gemini | `Cannot load native addon` (`pty.node`) | native add-on | not shimmable; harness falls back |
| 15 | gemini | `bash: trap: command not found` in tool output | just-bash has no `trap` | not fixed |
| 16 | claude | `spawnSync("which", [rg \| bwrap \| socat])` | synchronous child process | cannot be emulated; returns an `ENOENT`-style error. Harmless in this run |
| 17 | gemini, claude | none visible | `AsyncLocalStorage` (gemini: 6 instances, async `run()`; claude: 7 instances, async `run()` and `enterWith`) | **approximated, not correct**: exact for synchronous code, "sticky" across `await`. A browser has no AsyncContext and no promise hooks, so native `async`/`await` continuations cannot be tracked. Two concurrent `run()` calls can see each other's store |
| 18 | claude | none visible | `fs.watchFile` (no-op), `process.kill(process.pid, 'SIGKILL')` twice (delivered as an event only) | recorded |

Known gaps that these runs did not hit (each throws a recognisable error and is logged if called): brotli and
zstd in `zlib`; `crypto` ciphers, signing, key objects, scrypt, ECDH, X509; `http2`; `worker_threads.Worker`;
`child_process.fork`; `dgram`; `vm` contexts (approximated with `with`); `inspector`; `node:sqlite`; Unix
sockets. `net`/`http` servers accept `listen()` but nothing can connect to them (OAuth callback servers and
local MCP servers would wait forever). stdio is never a TTY, so no interactive TUI was attempted. stdin is
an immediate EOF. `process.version` is reported as v22.12.0.

## Network through a proxy

The worker never contacts the mock directly; the mock sends no CORS headers.

**(a) Plain mode: CORS proxy** (`servers/cors-proxy.mjs`). `fetch` in the layer calls
`<proxy>/fetch?url=...` with the real request headers JSON-encoded in one header (browsers refuse to set
`user-agent`, `host` and others), and the proxy replays and streams. That covers Gemini CLI and Claude Code.
pi does not use `fetch`, so plain mode also needed a socket-level bridge: `net.Socket` (and `tls.connect`)
parses the HTTP/1.1 request the harness writes, replays it through the proxy with `fetch`, and feeds a
synthesized chunked HTTP/1.1 response back into the socket as the body arrives. undici is unaware. Streaming
is preserved: for pi's final-answer request the socket received 11 body chunks, the first 3.5-5 ms after the
request and the last about 155 ms later (the mock paces its output at 15 ms per token). Request bodies are
buffered, not streamed. The proxy forces `accept-encoding: identity`, because the worker has no brotli
decoder. The proxy sees plaintext.

**(b) Blind tunnel: WebSocket-to-TCP relay** (`servers/ws-relay.mjs`). `net.Socket` is a byte pipe over
one WebSocket per connection. For pi the bytes on the wire are undici's own
(`POST /v1/chat/completions HTTP/1.1`, 2 connections, 18.6 kB up, 7.2 kB down, 0 proxy requests). For
Gemini CLI and Claude Code, which call `fetch`, the layer's `fetch` is implemented by a small HTTP/1.1 client
of my own over the same socket (4 connections each). All three harnesses pass the turn in this mode.

Only plain TCP to the mock is proven. `tls.connect` in tunnel mode fails with an explicit error. Real use
needs TLS inside the worker; I would try a WebCrypto-based TLS 1.3 client such as `subtls` first (small, no
wasm) and rustls compiled to wasm as the fallback. Neither was built or tested. TCP half-close is not
expressible over a WebSocket. Neither proxy has an allow-list wired up in the spike (both take an `allow`
callback).

## Hardened JS (ses 2.3.0)

Setup: `lockdown({ errorTaming: 'unsafe', overrideTaming: 'severe', consoleTaming: 'unsafe', evalTaming:
'safe-eval', errorTrapping: 'none', unhandledRejectionTrapping: 'none' })`, then the whole harness is
evaluated in one `Compartment` whose globals are the emulated Node globals plus the web platform globals a
Node 22 process also has (`URL`, `TextEncoder`, `AbortController`, `Response`, `ReadableStream`,
`WebAssembly`, `crypto`, ...). The emulation layer and just-bash run in the start compartment, after
lockdown. A probe run inside the compartment reports: `Object.prototype` and `Array.prototype` frozen;
`self`, `importScripts`, `postMessage` not visible; `new Function('return this')()` is `undefined` and
`new Function('return typeof importScripts')()` is `"undefined"`; `Object.prototype.polluted = 1` throws.

**Verdict: it works for pi and Gemini CLI, not for Claude Code 2.1.112, and not with stock SES.**

Every breakage, in the order found:

| # | Breakage | Fix |
|---|---|---|
| 1 | `Float64Array is not a constructor` (pi). A SES Compartment global has no `Float64Array`, `Float32Array`, `Float16Array`; also absent: `DisposableStack`, `AsyncDisposableStack`, `SuppressedError`, `SharedArrayBuffer`, `Atomics` | endow the first six explicitly. Without them pi fails at load (shown by the script) |
| 2 | `Illegal invocation` (pi) on `structuredClone` | WebIDL operations passed as endowments must be bound to the real global (`structuredClone`, `queueMicrotask`, `atob`, `btoa`, `reportError`) |
| 3 | `Date.now()` and `Math.random()` are tamed inside a Compartment | endow the real `Date` and `Math` |
| 4 | `Cannot assign to read only property 'return' of object '[object AsyncGenerator]'` (pi; the stream code it bundles assigns `.return` on an async generator). This is the override mistake, and `overrideTaming: 'severe'` has no entry for generator prototypes | **patch SES**: `scripts/build.mjs` writes a copy of `ses.umd.js` with two lines added to its severe enablement table (`%AsyncGeneratorPrototype%` and `%GeneratorPrototype%`). SES has no API to add enablements. Doing the repair myself before `lockdown()` does not work: lockdown throws `Accessor not expected at intrinsics.%AsyncGeneratorPrototype%.next`. The script runs pi against stock SES and records the failure |
| 5 | SES source censors: files containing `import(`, `<!--`/`-->` or `eval(` are rejected by `Compartment.evaluate` by default (pi: 7 files with `import(`, 4 with HTML-comment sequences; gemini: 22, 4, and 1 with `eval(`; claude: 1, 1, 1) | evaluate with `__evadeImportExpressionTest__`, `__evadeHtmlCommentTest__`, `__rejectSomeDirectEvalExpressions__: false`. Dynamic import is already rewritten to a loader call |
| 6 | `overrideTaming: 'moderate'` and `'min'`: Claude Code dies at load with `Cannot assign to read only property 'constructor'` (axios `reduceDescriptors`) | use `'severe'` |
| 7 | **Unresolved.** Claude Code's Bash tool fails before it spawns anything: `Invalid property descriptor. Cannot both specify accessors and a value or writable attribute`. Same with stock SES, so it is not the patch. The write tool and the three model round trips work; the turn fails the shell checks. I did not locate the call site; the message fits code that spreads a property descriptor taken from a prototype (now an accessor because of `'severe'`) and adds `value` | none found in the time available |

SES also logs `Removing intrinsics.%IteratorPrototype%.join` and `.includes` at lockdown (newer than its
permit list); nothing in these runs needed them.

Slowdown, medians of 5 (plain to SES):

| | pi | gemini | claude (turn fails under SES; timings for reference) |
|---|---|---|---|
| Module evaluation, ms | 82 to 107 (1.3x) | 274 to 344 (1.3x) | 293 to 384 (1.3x) |
| Time to first output, ms | 513 to 594 (1.2x) | 1063 to 1248 (1.2x) | 1552 to 1849 (1.2x) |
| Full turn, ms | 965 to 1060 (1.1x) | 1575 to 1743 (1.1x) | 1567 to 1884 (1.2x) |
| Peak worker JS heap in a turn, MB | 27.9 to 38.2 | 81.7 to 140.8 | 61.5 to 137.6 |
| `lockdown()` itself, ms | 48 | 54 | 33 |

These turns are dominated by load and by the mock's pacing (about 0.4 s of deliberate token delays per
turn), so they say little about steady-state compute under SES.

What this does not show: that the Compartment confines anything. The endowments are powerful and unhardened
(`fetch` to the proxy, `WebAssembly`, the whole emulated `fs` and `child_process`), and all code in the image
shares one compartment.

## Measurements

Cold start = new worker, image fetched from localhost with `cache-control: no-store` (gzip on the wire),
mounted, harness started. Times are ms since the page asked for the run, medians of 5, plain JS, CORS proxy.

| | pi | gemini | claude 2.1.112 |
|---|---|---|---|
| Image: files / directories | 6 806 / 1 483 | 827 / 104 | 30 / 29 |
| Image size (of which ESM compile cache) | 77.7 MB (10.3) | 143.9 MB (18.1) | 80.0 MB (13.8) |
| Image size, gzip (what the worker downloads) | 18.3 MB | 30.0 MB | 30.6 MB |
| Image fetch + gunzip, localhost | 181 | 300 | 244 |
| Image mount | 30 | 6 | 2 |
| Emulation layer booted | 297 | 399 | 347 |
| `--version`: first output (cold start to first harness output) | 501 | 991 | 843 |
| Turn: first output | 513 | 1 063 (stderr), 1 574 (stdout) | 1 552 |
| Turn: process exit (min-max of 5) | 965 (953-1 014) | 1 575 (1 463-1 714) | 1 567 (1 511-1 646) |
| Module evaluation inside that | 82 (5.6 MB source) | 274 (17 MB) | 293 (13.1 MB) |
| Worker JS heap, `--version`, peak used | 21.7 MB | 64.6 MB | 39.2 MB |
| Worker JS heap, full turn, peak used / total | 27.9 / 37.7 MB | 81.7 / 97.0 MB | 61.5 / 70.5 MB |
| ArrayBuffer backing store (mostly the mounted image) | 82.6 MB | 155.6 MB | 92.3 MB |

Reference: the same pi turn on real Node.js v22.23.5 against the same mock, direct connection, takes 660 ms
(3 runs: 634-677), so the browser run is about 1.5x that, including the image download.

Heap method: `performance.memory` does not exist in workers and `measureUserAgentSpecificMemory()` is
undefined without cross-origin isolation, so the driver samples `Runtime.getHeapUsage` on the worker target
over the DevTools protocol every 40 ms, in a separate pass (one run each). "Heap after load" is the
`--version` row: the peak while the harness loads and prints its version. Chromium is launched with
`--remote-debugging-port` for this and with no other flag.

Image contents: everything `npm install` wrote under `node_modules`, except `*.map`, `*.d.ts`, `*.d.mts`,
`*.d.cts` (pi: 9 290 files, 56 MB excluded). Nothing was over the 30 MB per-file cap. The Claude image is
mostly its vendored ripgrep binaries for six platforms, which are dead weight here. Images are rebuilt by
`scripts/build.mjs` and are not committed.

## Synchronous child processes

Observed at run time (logged by the layer with a stack): only Claude Code, three calls at startup from its
`checkDependencies`: `spawnSync("which", [<vendored rg path>])`, `spawnSync("which", ["bwrap"])`,
`spawnSync("which", ["socat"])`. pi and Gemini CLI made none in these runs.

Static scan of the entry bundles (`scripts/scan-sync.mjs`, distinct call sites by name; results in
`dist/sync-scan.json`). No `Atomics.wait`, `receiveMessageOnPort` or `readSync(0)` call sites were found.

| Harness | Call sites | What they are for |
|---|---|---|
| pi (84 files) | 6 `spawnSync`, 2 `execSync` | `which`/`where` to locate an executable; `trash` to delete files; run a shell command synchronously (`spawnSync(shell, [...args, command], {input})`; I did not trace its callers, pi's docs describe `!command` values in `models.json`); cross-spawn's sync wrapper (2); `tmux display-message` to detect terminal features; one generic `execSync(command, {timeout: 1e4})` helper |
| gemini (104 files, several chunk generations deduplicated) | 15 `spawnSync`, 14 `execSync`, 6 `execFileSync` | `command -v` / `where.exe` to test for tools (clipboard, editors); WSL (`wslinfo`, `wslpath`), `cmd.exe`, PowerShell and `taskkill` on Windows; `brew --prefix`; `zip`/`tar` for skill packaging; `ffmpeg` presence; VS Code companion install; Docker/Podman/LXC sandbox setup; `sysctl`, `getconf`, `ps -p`, `xattr`; cross-spawn and execa sync wrappers |
| claude 2.1.112 (1 file) | 1 `execSync`, 2 `spawnSync` by name | the bundle imports these under minified aliases, so the scan undercounts; the run-time log above is the reliable evidence for this harness |

Most of these are probes for optional tools, where failing is the correct answer in a sandbox with no such
tools. The ones that matter are "run this shell command and give me its output now" (pi's synchronous shell helper, Claude Code's `which`). They cannot be served by an asynchronous shell.

## Surprises

1. **Three different unmodified harnesses completed a full turn**, and the turn costs about 1-1.6 s cold,
   within 1.5x of native Node for pi.
2. **The current Claude Code is not JavaScript on disk.** Neither are Codex and opencode. Of the five
   harnesses named in the brief, only pi and Gemini CLI currently publish something this approach can run.
3. **pi brings its own HTTP stack** and replaces `globalThis.fetch`. Shimming `fetch` is not enough; the
   socket layer has to carry HTTP. The plain-proxy bridge at `net.Socket` level handles that without the
   harness noticing.
4. **Exact failure semantics matter more than breadth.** The longest debugging sessions were a missing
   `close` event after `ENOENT`, an fd closed by the parent, and `stream.finished` on a web stream, not
   missing modules.
5. **SES needed a source patch** for a pattern as ordinary as assigning `.return` on a generator, and a
   Compartment lacks float typed arrays.
6. **just-bash defaults to defence-in-depth measures** that patch globals during execution; it must be
   constructed with `defenseInDepth: false` when it shares a realm with the harness.
7. Babel needs about 2 GB per worker for a 17 MB minified chunk; four in parallel were OOM-killed in this
   container.

## Limitations

- One harness process per worker. The "kernel" here is the VFS, the process object and just-bash; there is
  no process table, and Node globals are installed on the worker global in plain mode, so two Node programs
  in one realm would share `process` and `globalThis`.
- A harness cannot be killed or pre-empted: it shares the thread with the file system and the proxy client.
  A busy loop in the harness stops everything, and `process.exit()` cannot unwind the stack.
- "Event loop empty" is a heuristic (ref-counted timers, sockets, requests, children; three idle checks 15 ms
  apart). Work that holds no handle, such as an `await` on a browser API the layer does not wrap, could cause
  an early exit; item 8 in the API list was exactly that.
- Shell commands run to completion before any output is delivered (just-bash returns buffered results), and
  only commands just-bash implements exist: no `git`, no `node`, no `trap`.
- The mock scripts one conversation. No real provider was contacted, no TLS, no auth flows, no MCP, no
  extensions, no interactive mode, no session persistence across reloads.
- The ESM compile cache is trusted by path; a file changed at run time would still get the stale precompiled
  form.
- Every number is from one machine and one browser build.

## Design consequences

1. **The approach is viable for harnesses that ship JavaScript**, without SharedArrayBuffer, with
   synchronous `fs` and `require` as direct calls. The emulation layer is modest in size but must match
   Node's observable behaviour closely at the edges (process and stream lifecycles, `spawn` events, fd
   semantics).
2. **Native distributions are the main threat to the plan.** Claude Code (since 2.1.113), Codex and opencode
   publish per-platform executables. For those, running "the unmodified CLI" in a tab means either an old
   JS release, a vendor-provided JS or wasm build, or a different execution strategy altogether. This should
   be settled per harness before investing further.
3. **An in-worker ESM transformer is required** for anything beyond a pre-built image (run-time
   `npm install`, extensions). Budget for its size and for memory on large bundles; consider transforming at
   install time and caching.
4. **Synchronous child processes need a decision.** Options: a shell that can run synchronously for simple
   commands (`which`, `command -v`, `cat`) with the asynchronous one for everything else; or accept failure
   and verify per harness that the fallbacks are acceptable. Without SharedArrayBuffer there is no general
   answer.
5. **`AsyncLocalStorage` cannot be implemented correctly** on a browser engine today. Both Gemini CLI and
   Claude Code use it. The sticky approximation passed these single-conversation runs; concurrent tool calls
   or sub-agents are where it would go wrong. Mitigations are heavy (transpile `async`/`await` in all guest
   code) or out of our hands (AsyncContext).
6. **Put the HTTP bridge at the socket layer**, not only at `fetch`, so harnesses with their own HTTP client
   work through a plain proxy; and plan for in-worker TLS if the blind tunnel is to be the default.
7. **Hardened JS is not free and not turnkey**: a patched SES, hand-picked endowments, one harness that
   fails in a way I could not resolve, 1.3x module evaluation time and 1.4-2.2x peak heap. If its
   purpose is per-process global isolation (several Node programs in one worker), a lighter mechanism may be
   enough; if its purpose is confinement, the endowment surface needs its own review.
8. **Images are large in memory** (78-144 MB held as one ArrayBuffer, on top of 28-82 MB of JS heap).
   Lazy or chunked loading and dropping unused files (other platforms' binaries, unused chunk generations)
   would matter on small devices; that was not measured here.
