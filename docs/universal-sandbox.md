# Universal sandbox design

Status: design, November 2026. Background research is in `reports/Browser agent sandbox options.md`. Prototype results are in the last section; anything not listed there is unproven.

## Goal

One sandbox that gives agents a real development workspace (shell, git, Python, JS/TS, npm packages, tests, web previews) and runs on iOS and Android browsers, desktop browsers, and desktop environments, with nothing installed. Browsers come first. People in a room and their agents share workspaces.

## Decisions

These were settled in the design interview.

| Question | Decision |
|---|---|
| Capability on every device | Dev workspace. The agent loop (fx) stays outside and uses the sandbox as a tool. Stock agent CLIs and x86 binaries are out of scope. |
| Untrusted JavaScript | Hardened JavaScript (SES) compartments on the browser's own JIT, inside the kernel worker. |
| Where the kernel lives | A second static origin, on Cloudflare Pages, embedded as an iframe. |
| Network | Browser-reachable endpoints only. No relays of any kind. |
| Mobile background | Pause and resume from a journal. No hand-off. |
| Device parity | Same core everywhere; desktop may add extras. |
| Build path | Assemble from existing open parts behind the kernel interface, then replace. |
| Workspace unit | Per room, hosted on one member's device. |
| Sharing | One host; other members and agents are remote. |
| Execution rights | The host grants read, write and execute per member, keyed on the Nostr signer. |
| Previews | Whole room, tunnelled over the room. |
| Desktop environments | The bridge runs the same kernel and wasm tools with a local folder mounted. |
| Durability | Local only. No automatic upload. |

## Why not an existing engine

Every in-browser Node or Linux engine found in the research (BrowserPod, WebContainers, Wasmer, the emulators) depends on SharedArrayBuffer, which requires cross-origin isolation of the whole page. That is impractical on static hosting, hostile to arbitrary avatars and embeds, and paired on iOS with a memory ceiling that a worker-per-process design does not fit. This design removes the dependency instead of working around it.

## Architecture

```
 Origin A: beamhop app (keys, Nostr, agent loop, capability broker)
 ┌──────────────────────────────────────────────────────────────┐
 │  fx agent loop ── tools ──► Workspace client                 │
 │  Capability broker (package fetch, GitHub API, room ACL)     │
 │        ▲ MessagePort RPC                    ▲ MessagePort    │
 │  ┌─────┴───────────────────────┐   ┌────────┴─────────────┐  │
 │  │ iframe, origin B (kernel)   │   │ iframe, origin P     │  │
 │  │  kernel worker              │   │ (previews)           │  │
 │  │   ├ wasm processes          │   │  service worker      │  │
 │  │   ├ SES compartments (JS)   │   │  answers requests    │  │
 │  │   └ SQLite on OPFS          │   │  from the kernel     │  │
 │  │  process workers (heavy)    │   └──────────────────────┘  │
 │  └─────────────────────────────┘                             │
 └──────────────────────────────────────────────────────────────┘
        ▲ room events, signed and encrypted (Nostr)
        ▼
 Other members' devices: Workspace client only (remote)
 Desktop bridge: same kernel under Node, local folder mounted
```

Three origins, all static:

- **A, the app.** Unchanged in role. It holds keys and is the only code that talks to the network.
- **B, the kernel.** Serves the kernel, the tool images and nothing else. Header CSP with `connect-src 'self'`, so even a full compromise of B cannot send data anywhere but B's own static host.
- **P, the previews.** Web pages built inside the sandbox are full documents running arbitrary script, which Hardened JS cannot confine. They get their own origin so they cannot reach the kernel's storage or service worker. This third origin was not in the interview; it follows from choosing live previews. It is a second Cloudflare Pages project, not a server.

### Kernel

A TypeScript kernel in one dedicated worker. It owns the process table, file descriptors, pipes, a virtual filesystem and a pseudo-terminal layer. The same code runs in the browser and under Node in the bridge.

**ABI.** WASI preview 1 plus a small extension set: `spawn` (no `fork`; guests are built the way no-MMU Linux programs are, with `vfork`-style spawn), `pipe`, `waitpid`, `kill`, terminal control, and `wasm_link` (below). Sockets are not offered; the network is a set of typed capabilities, not a socket API.

**Blocking without SharedArrayBuffer.** A blocking syscall is an import wrapped in `WebAssembly.Suspending`; the process entry point is wrapped in `WebAssembly.promising`. The guest's stack is suspended by the engine and resumed when the kernel has data. Where JSPI is missing, the same tool is shipped as an Asyncify build and chosen at load time.

**Two placements for a process.**

- *Coroutine process*: the instance lives in the kernel worker. Non-blocking syscalls are direct function calls. Spawn costs one instantiation of an already compiled module. Used for the shell, coreutils, git, and anything short-lived.
- *Worker process*: the instance has its own worker; syscalls cross a MessageChannel and are awaited through JSPI. Killable without affecting the kernel, and runs in parallel. Used for Python, compilers and anything CPU-heavy. A tool's manifest states which placement it wants; desktop may use more workers than a phone.

**Limits.** At load the kernel rewrites each module's memory section to cap its maximum pages, which gives per-process memory limits and a global budget sized for iOS. A page-side heartbeat watches the kernel worker; if a coroutine process spins without making a syscall, the worker is terminated and restarted from the filesystem. Running processes are lost, files are not.

**`wasm_link`.** A guest may hand the kernel wasm bytes to instantiate and link against its own memory and a chosen subset of its imports. This is a JIT hook: it lets a future JS engine or binary translator generate code at run time while still holding no authority beyond its syscalls. Not needed for the first version.

### Guests

| Need | First version (assembled) | Replacement |
|---|---|---|
| Shell and coreutils | A TypeScript virtual shell (just-bash class) over the kernel's filesystem | BusyBox built for the kernel ABI |
| Git | A JS git implementation plus the GitHub REST transport | git or gitoxide compiled to wasm |
| JS/TS execution | SES compartments, CommonJS and pre-transformed ESM, Node core-module shims backed by syscalls | Same, with broader Node coverage |
| Build tools | esbuild, Rolldown, the Go TypeScript compiler, Biome, Tailwind as wasm guests | Same |
| Python | Pyodide in a worker process with its JS bridge removed | CPython's WASI build with wasm wheels |
| Package install | Kernel-native `npm`/`pip` front ends that fetch through the broker | Real package managers where they run |

**JavaScript.** `lockdown()` runs once in the kernel worker. Each JS process is a `Compartment` whose globals are a `console`, timers, and Node-style modules implemented on kernel syscalls. Because the compartment shares the kernel's thread, `fs.readFileSync` is a direct call. The guest has no `fetch`, storage, `postMessage` or worker constructors. Two layers stand between guest JS and anything valuable: the compartment, and the B origin with its CSP. Neither is a process boundary, and that is the accepted trade-off.

**Python.** Pyodide's `js` module exposes the JavaScript global, so the worker's global is stripped to an allowlist before user code runs and the bridge module is disabled. Its files are synchronised with the kernel at process start and exit. This is the weakest part of the assembled version and the first to replace.

### Filesystem and storage

A workspace is one SQLite database stored in OPFS through the `opfs-sahpool` VFS, which uses synchronous access handles and needs no SharedArrayBuffer. Tables hold inodes and content-addressed chunks. This gives transactions, cheap directory forks, bounded memory (file data stays on disk), and the same file format under native SQLite in the bridge.

- **Base image.** Tool binaries and their support files are content-addressed files on origin B, listed in a manifest and fetched on first use, then cached. Boot costs one manifest.
- **Encryption.** All workspaces share origin B, so chunks are encrypted with a per-workspace key that A hands to the kernel at boot. Another workspace's kernel never holds that key.
- **Single writer.** Synchronous access handles are exclusive, so a Web Lock elects one tab as host; other tabs of the same user attach as clients.
- **Mounts.** On Chromium desktop a real folder can be mounted through the File System Access API. In the bridge a local folder is mounted directly. Elsewhere files are copied in and out.
- **Durability.** Local only, as decided. The kernel requests persistent storage and the app shows when it was refused. An explicit export to a file is the only way data leaves the device.

Storage is behind a `BlockStore` interface with two implementations: OPFS inside B, and a version that asks A to store blocks over the message port. The second exists because third-party iframe storage on Safari is the largest unknown (see risks).

### Network

The kernel worker has no network. Every outbound request is a typed call to the broker in A, which holds an allowlist and any credentials:

- npm registry, PyPI and its file host, jsDelivr: read-only package fetches.
- GitHub: clone, fetch and push implemented on the REST git-database endpoints, since git's own HTTPS protocol is not callable from a browser. Tokens stay in A and are granted per repository.
- Everything else fails with a clear error naming the host. There are no relays.

Read-only registries are low-risk destinations: a request can leak data only to the registry operator. GitHub writes are the one outbound channel an attacker could own an account on, so pushes require a host-approved repository grant.

### Sharing over the room

The workspace runs only on its host's device. Everything else is a client.

- **Requests** are room events signed by the requester: run a command, read or write a file, open a terminal, fetch a preview resource. The kernel's access check uses the event's signer and the host's grant table (read, write, execute per member). An agent inherits its owner's grant. Message content never confers authority.
- **Streams** (terminal output, preview responses) are chunked and encrypted with the room key. Nostr relays carry them at first; a WebRTC data channel signalled over Nostr is the upgrade path if relay limits bite.
- **Previews.** The host's P frame answers requests from the kernel directly. A remote member's P frame forwards each request over the room to the host. Previews work only while the host is active.
- **Paused host.** Clients see the workspace as paused and their requests queue with a time limit.

### Pause and resume

The agent loop journals each step before acting, and every file change is a committed SQLite transaction. When a phone suspends the tab, nothing is lost that was acknowledged. If the tab is merely frozen, processes continue on return. If it was discarded, the kernel restarts, in-flight commands report as interrupted, and the agent continues from the journal.

### Desktop environments

`packages/bridge` embeds the same kernel under Node with native SQLite and a mounted folder. Guests are the same wasm files, so behaviour matches the browser and the agent stays confined. Native-only tools are unavailable in this mode by decision.

## Security model

| Threat | Control |
|---|---|
| Sandboxed code reads Nostr keys or provider tokens | Keys exist only in origin A. The kernel is cross-site; wasm guests and compartments have no API to reach A. |
| Sandboxed code sends workspace data out | No network in the kernel; B's CSP allows connections only to B; all egress is brokered and allowlisted. |
| A room member's message instructs someone's agent to run commands | Authority comes from the signer's grant, checked in the kernel, not from the model's reading of the message. |
| A preview page attacks the kernel | Previews run on origin P and reach the kernel only through the request/response tunnel. |
| One workspace reads another | Per-workspace encryption keys. |
| Runaway process | Memory caps per module, heartbeat and restart. |
| Escape from a compartment | Lands in origin B: no keys, no egress, one workspace's data. Treated as serious but contained. |

Not defended: a browser engine bug that breaks process or origin isolation, and a malicious room member who has been granted execute.

## Phases

1. **Interface and assembly.** Define `Kernel`, `Process`, `BlockStore` and the workspace client. Fill them with the virtual shell, JS git, SES runtime, Pyodide and wasm build tools. Deploy origins B and P. Replace today's `sandbox.ts`.
2. **Room sharing.** Signed requests, grants, terminal streams, tunnelled previews, pause state.
3. **Real processes.** WASI process model with JSPI and Asyncify, BusyBox and git as wasm, memory caps, watchdog.
4. **Bridge.** Same kernel under Node with folder mount.
5. **Replacements.** CPython on WASI, broader Node coverage, `wasm_link`.

## Risks and unknowns

- **Safari and iOS are untested.** JSPI availability, storage for a cross-site iframe (Safari may make it ephemeral or cap its lifetime), service workers in a partitioned frame, and real memory limits all need a physical iPhone. The `BlockStore` and Asyncify fallbacks exist for the first two.
- **Hardened JS compatibility.** Frozen built-ins break some npm packages; the prototype measures how many.
- **Pyodide confinement** is by stripping globals, which is fragile.
- **Relay throughput** for terminal and preview streams is unmeasured.
- **GitHub-only git.** Other git hosts do not work without a relay, by decision.
- **Node in the bridge** needs JSPI or the Asyncify builds; which Node versions qualify is unverified.

## Prototype results

Pending.
