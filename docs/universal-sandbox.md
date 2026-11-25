# Universal sandbox design

Status: design, revision 2, November 2026. Revision 1 put the agent loop outside the sandbox; that was a misreading and is replaced here. Background research is in `reports/Browser agent sandbox options.md`. Only what is listed under "Prototype results" has been demonstrated, and only in headless Chromium.

## Goal

The sandbox is a computer in a browser tab. A user runs a coding-agent harness inside it (opencode, fx, codex, pi, claude, gemini) the way they would on a laptop, logs in with their own subscription, and shares that machine with a room. It runs on iOS and Android browsers, desktop browsers, and desktop environments, with nothing installed. Browsers come first.

## Decisions

Settled in the two design interviews. Rows marked *changed* differ from revision 1.

| Question | Decision |
|---|---|
| What runs inside | The harness itself, plus the dev tools it drives (shell, git, Python, Node, npm, tests, previews). *Changed.* |
| Harness fidelity | Unmodified where the harness is JavaScript; Beamhop-maintained builds for native ones. *New.* |
| Interface | Both: headless into the room chat, and a real terminal. *New.* |
| Phones | All harnesses on desktop browsers; best effort on phones, which can always drive a desktop-hosted machine remotely. *New.* |
| Network | A proxy that anyone can host anywhere. Blind tunnel by default, plain CORS mode where raw connections are unavailable. *Changed.* |
| JavaScript confinement | Undecided: prototype Hardened JS and plain JS behind the origin wall, then choose. *Changed.* |
| Credentials and sharing | One shared machine. The host's harness logins live inside it; members the host grants can use them. *Changed.* |
| Where the kernel lives | A second static origin, embedded as an iframe. Whether each workspace gets its own subdomain depends on the confinement choice. |
| Mobile background | Pause and resume. No hand-off. |
| Device parity | Same core everywhere; desktop may add extras. |
| Build path | Assemble from existing open parts, then replace. |
| Workspace unit | Per room, hosted on one member's device. |
| Execution rights | Host grants read, write, execute per member, keyed on the Nostr signer. |
| Previews | Whole room, tunnelled. |
| Desktop environments | The bridge runs the same kernel with a local folder mounted. |
| Durability | Local only. |

## The six harnesses

Packaging is from memory and is being checked by the prototype; treat it as unverified.

| Harness | Kind | Route |
|---|---|---|
| pi | JavaScript on Node | Unmodified on the Node layer. First target. |
| gemini | JavaScript on Node | Unmodified on the Node layer. |
| claude | JavaScript bundle, with native helpers such as ripgrep | Unmodified on the Node layer; helpers replaced by wasm builds on `PATH`. |
| fx | Already has a browser build | Runs as a wasm guest. |
| opencode | Bun-compiled binary using Bun APIs | Run from source on the Node layer with a Bun shim, or a maintained build. |
| codex | Native Rust binary | A maintained wasm build, or its headless protocol behind a port. Hardest. |

## Architecture

```
 Origin A: beamhop app (Nostr keys, room, UI, socket broker)
 ┌───────────────────────────────────────────────────────────────┐
 │ chat UI ◄─ ACP / JSON ─┐      terminal UI (xterm) ◄─ pty ─┐   │
 │ socket broker ──► WebSocket ──► proxy (hosted anywhere)   │   │
 │      ▲ MessagePort                                        │   │
 │ ┌────┴────────────────────────────────────────────────────┴─┐ │
 │ │ iframe, origin B: the machine                             │ │
 │ │  kernel worker                                            │ │
 │ │   ├ Node layer ── harness (pi, gemini, claude, …)         │ │
 │ │   ├ wasm processes (shell, git, rg, python, build tools)  │ │
 │ │   ├ TLS, HTTP, DNS-over-HTTPS (inside the machine)        │ │
 │ │   └ SQLite on OPFS                                        │ │
 │ └───────────────────────────────────────────────────────────┘ │
 │ iframe, origin P: previews (service worker ⇄ kernel)          │
 └───────────────────────────────────────────────────────────────┘
        ▲ room events, signed and encrypted (Nostr)
        ▼
 Other members: chat, terminal and preview clients (remote)
 Desktop bridge: same kernel under Node, local folder mounted
```

### Kernel and processes

A TypeScript kernel in one dedicated worker: process table, file descriptors, pipes, pseudo-terminals, virtual filesystem. The same code runs under Node in the bridge. It needs no SharedArrayBuffer and no cross-origin isolation.

- **Wasm processes** use WASI preview 1 plus `spawn`, `pipe`, `waitpid`, `kill` and terminal control. A blocking syscall suspends the guest's stack through WebAssembly JSPI, with an Asyncify build as fallback. This is proven in Chromium (see results).
- **In-kernel is the default placement.** A process in its own worker pays about 1,500 times more per syscall, so workers are for CPU-heavy guests only, pooled and with buffered I/O.
- **Rules the prototype forced:** every potentially blocking syscall is split into a plain "try" import and a suspending slow path; kill unwinds the stack by rejecting its promise; the kernel yields to the event loop every few milliseconds; a suspension never crosses a synchronous JavaScript frame; plan for about 100 live processes per tab.
- **Watchdog.** A page-side heartbeat restarts a frozen kernel worker. Files survive; processes do not.

### Node layer

The harnesses are Node programs, so `node` is the most important program on the machine. It is not a port of Node: the harness's JavaScript runs on the browser's own engine at JIT speed, in the kernel worker, against an emulation of Node's API.

- Because it shares the kernel's thread, `require`, `fs.readFileSync` and friends are direct calls into the filesystem. This is what removes the need for SharedArrayBuffer.
- `child_process.spawn` starts a wasm process or another Node-layer process and is asynchronous, as in Node.
- `spawnSync` and `execSync` cannot wait for a child that blocks. They run a wasm child to completion synchronously when it never needs to suspend, and fail otherwise. How often harnesses depend on this is being measured.
- `net`, `tls`, `http`, `https`, `dns` and `fetch` are implemented on the socket broker (below).
- A CPU-bound stretch of harness JavaScript stalls every process on the machine until it yields. That is the cost of one thread.
- `bun` is the same layer with Bun's extra APIs shimmed, for opencode.

### Network and the proxy

Browsers cannot open sockets and many provider endpoints refuse browser calls, so the machine's traffic leaves through a proxy.

- **One small program, hostable anywhere**: Cloudflare Workers, Deno, Node, Bun or a container. A room or a user points their machine at one. Beamhop may run a default.
- **Tunnel mode (default).** The proxy forwards raw TCP over a WebSocket. TLS, HTTP and certificate checks run inside the machine in wasm with a bundled root store, so the operator sees hostnames, addresses and volume, and never tokens or prompts. It carries any protocol: HTTPS, git, SSH.
- **Plain mode.** For hosts that cannot open raw connections, the proxy makes the HTTPS request and adds CORS headers. The operator can read everything, so this mode is labelled as safe only when self-hosted.
- **Direct fast path.** Destinations that allow browser calls can skip the proxy.
- **Not an open relay.** Access tokens, optional destination allowlists, and rate limits.
- **The kernel frame has no network of its own.** The app on origin A opens the WebSocket and passes bytes over a message port, so origin B keeps a strict CSP and the app can show and limit where a machine connects.

### Logging in

A harness logs in as it does on a laptop, with two adaptations:

- Opening a browser: the machine's `xdg-open` asks the app to open a real tab.
- Loopback callbacks: a redirect to `127.0.0.1` reaches the user's device, not the machine. Harnesses are started with their device-code or paste-the-code login where one exists. Where only a loopback flow exists, the user pastes the redirected address back.

Tokens are written to the machine's files and encrypted at rest with the workspace key.

### Storage

A workspace is one SQLite database in OPFS (the `opfs-sahpool` VFS, which needs no SharedArrayBuffer), holding inodes and content-addressed chunks. The Node layer and wasm processes read it synchronously in the kernel worker. Tool and harness images are content-addressed files fetched on first use. A Web Lock elects one tab as host. Storage sits behind a `BlockStore` interface with a second implementation that stores blocks through the app, in case Safari restricts storage in a cross-site iframe. Durability is local only; export to a file is manual.

### Interface

- **Chat.** The harness runs headless (ACP where it has it, otherwise its JSON mode) with its stdio connected to the room, reusing the bridge's existing ACP logic.
- **Terminal.** A pseudo-terminal carries the harness's own interface to a terminal view in the app. The host can share that terminal with granted members.

### Sharing over the room

One machine, on the host's device. Other members' requests (chat turns, terminal input, file access, preview requests) are room events signed by the requester and checked against the host's grant table in the kernel. Streams are chunked and encrypted with the room key, over relays first and a WebRTC data channel later if needed. When the host's tab pauses, the machine pauses and clients see that.

### Previews

Pages built on the machine are served from a third static origin by a service worker that asks the kernel for each response. Remote members' requests travel over the room to the host.

### Pause and resume, desktop

Unchanged from revision 1: file changes are committed transactions, a discarded tab restarts the kernel and the harness resumes its own session from its files. The bridge embeds the same kernel under Node with native SQLite and a mounted folder.

## Security model

The machine is trusted the way a laptop is: the harness, the model's commands and the host's tokens share it. The walls are around it, not inside it.

| Threat | Control |
|---|---|
| Code on the machine reads Beamhop's Nostr keys | Keys exist only in origin A; the machine is a cross-site frame with message-port access only. |
| One workspace reads another | Per-workspace encryption; per-workspace subdomain if the origin-wall option is chosen. |
| Proxy operator reads tokens or prompts | Tunnel mode: TLS ends inside the machine. |
| A stranger uses someone's proxy | Proxy access tokens and limits. |
| A room member's message drives the host's harness | Only signers the host granted are delivered to the harness. |
| A preview page attacks the machine | Separate origin, request tunnel only. |

Accepted, and to be stated in the app:

- **A member granted execute can use and extract the host's harness logins.** This follows from "one shared machine".
- **Prompt injection inside the machine can leak what is on the machine**, including those logins, through any destination the proxy allows. A destination allowlist reduces this; it does not remove it.
- **Provider terms.** Running an official harness with your own login is first-party use, but its traffic arrives from a proxy address, and letting room members use your subscription may count as account sharing. Each provider's current terms need checking before this is promoted.

## Phases

1. **A harness in a tab.** Kernel interface, Node layer, virtual shell, in-memory then SQLite storage, proxy in both modes, pi end to end. Origins B and P deployed.
2. **More harnesses.** gemini and claude unmodified; login flows; terminal view; wasm ripgrep and git.
3. **Room sharing.** Grants, chat and terminal streams, tunnelled previews, pause state.
4. **Real processes and tools.** JSPI process model in production, BusyBox, Python, build tools.
5. **Native harnesses.** opencode on the Bun shim; codex build.
6. **Bridge.** Same kernel under Node.

## Risks and unknowns

- **Node emulation breadth** is the main engineering risk. Each harness upgrade can touch a new API.
- **Safari and iOS are untested**: JSPI, storage and service workers in a cross-site iframe, and whether a Node-class harness fits in a phone tab's memory.
- **Synchronous child processes** cannot be fully emulated on one thread.
- **codex and opencode** need ports whose size is unknown.
- **TLS in wasm** adds code size and a root store to maintain.
- **Provider terms**, as above.
- **Hardened JS** may not survive whole harnesses; undecided until prototyped.

## Prototype results

Headless Chromium 158 in a cloud container. Not a phone, not Safari, not Firefox.

### Stack-switching processes (done)

Code and full numbers: `spikes/universal-sandbox/jspi-processes/RESULTS.md`.

- Unmodified Rust `wasm32-wasip1` programs ran as a three-stage pipeline in one worker with no SharedArrayBuffer and no isolation headers: 200,000 lines, correct output, about 158 MB/s.
- A process switch costs about 400 ns; a non-blocking syscall 18 to 160 ns; spawning from a compiled module about 0.14 ms.
- A process in its own worker costs 38 to 52 µs per syscall and moved 0.6 MB/s.
- Abandoning a suspended process leaks it permanently; rejecting its promise frees it.
- About 125 live wasm memories per browser process is a hard limit.
- A guest in a tight loop freezes the kernel; the watchdog restarted it in about 40 ms after a one-second timeout.

### Storage on a second origin, Hardened JS with npm packages (stopped)

Both were cancelled when the design changed. Their partial code is in `spikes/universal-sandbox/` and is unfinished and unreviewed.

### A harness in a tab (running)

Pending.
