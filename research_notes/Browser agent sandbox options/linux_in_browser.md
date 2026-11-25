# Linux / POSIX-like environments in a browser tab (zero install), state as of 2026-11-25

Reading notes for the report writer:
- "Cited Findings" are things read from a source during this research session (Nov 2026). Several were read through a page-summarising fetch tool, so exact wording of quotes should be re-checked before being reproduced verbatim.
- "Inferences" are my reasoning from those findings.
- "Gaps" lists what was not verified. Items there marked "(background, unverified)" come from my prior knowledge (training data up to mid-2026) and were NOT confirmed against a source in this session. Treat them as leads, not facts.
- Not every technology in the brief got a dedicated source check; the unchecked ones are listed explicitly in the Gaps of the relevant section.

## 1. WebContainers (StackBlitz): capabilities, licensing, isolation headers, browser support, GitHub Pages

### Takeaway
WebContainers is the mature, Node-centric in-browser runtime, but the core is closed source and production use in a for-profit setting needs a paid licence with unpublished pricing. It requires SharedArrayBuffer and therefore cross-origin isolation, is fully supported only on Chromium, and StackBlitz's own docs still label Firefox and Safari as alpha/beta.

### Cited Findings
- Licensing: "Licensing is required for production usage of the API in a commercial, for-profit setting", including serving customers, prospects or employees; prototypes and POCs need no licence; no prices are published (contact sales) — [webcontainers.io/enterprise](https://webcontainers.io/enterprise)
- The Enterprise offering includes "Self hosted, on-premises, and VPC installation options behind the firewall", private npm registry support and SSO — [webcontainers.io/enterprise](https://webcontainers.io/enterprise)
- The core WebContainers project is not open source, only the API package is available — [search summary of StackBlitz/community sources; see sebastiandg7/webcontainer-core](https://github.com/sebastiandg7/webcontainer-core)
- Chrome and most Chromium browsers are "fully supported"; blocking third-party cookies can stop it working out of the box; Brave's default blocking often stops it — [WebContainers browser support](https://webcontainers.io/guides/browser-support)
- Firefox is listed as alpha: it does not fully support the required cross-origin isolation mode, so a server preview in a frame may be limited; workaround is opening the preview in a separate window — [WebContainers browser support](https://webcontainers.io/guides/browser-support)
- Safari is listed as beta from Safari 16.4 TP; older versions lack `Atomics.waitAsync` and regex lookbehind, which cannot be polyfilled — [WebContainers browser support](https://webcontainers.io/guides/browser-support)
- Non-Chromium browsers can show runtime differences because Node.js code relies on V8-specific behaviour — [WebContainers browser support](https://webcontainers.io/guides/browser-support)
- WebContainers need SharedArrayBuffer, and cross-origin isolation is what enables it; the headers are `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Opener-Policy: same-origin` — [StackBlitz: Cross-browser support with cross-origin isolation](https://blog.stackblitz.com/posts/cross-browser-with-coop-coep/)
- StackBlitz published separate posts announcing Safari/iOS/iPadOS and Firefox desktop + Android support — [Safari post](https://blog.stackblitz.com/posts/webcontainers-are-now-supported-on-safari/); [Firefox post](https://blog.stackblitz.com/posts/webcontainers-are-now-supported-on-firefox/). These conflict in tone with the docs page, which still says alpha/beta — [browser support](https://webcontainers.io/guides/browser-support)
- GitHub Pages does not allow custom response headers, so COOP/COEP must be injected by a service worker; `coi-serviceworker` does this, and reloads the page once on first load so the worker can add the headers — [gzuidhof/coi-serviceworker](https://www.github.com/gzuidhof/coi-serviceworker); [GitHub community discussion #13309](https://github.com/orgs/community/discussions/13309)
- A third-party comparison (written by a competitor project) puts WebContainers at ~2 MB bundle and 2-5 s startup, with "real TCP/IP" and full native-module support — [almostnode README](https://github.com/macaly/almostnode). The "full Linux kernel" and "real TCP/IP" wording in that table is the almostnode authors' characterisation, not StackBlitz's, and looks inaccurate to me (see Inferences).

### Inferences
- A static GitHub Pages PWA can meet the header requirement with a coi-serviceworker-style shim, but Beamhop already needs its own service worker as a PWA, so the header injection has to be merged into that worker rather than added as a second one (one scope, one worker).
- Cross-origin isolation is page-wide: once on, every cross-origin subresource and iframe must opt in (CORP/CORS, or `credentialless`). This affects avatars, link previews and any embedded third-party content in a chat app, not just the sandbox.
- The licence is the blocker rather than the technology: Beamhop being free/static does not obviously make it "non-commercial", and there is no public price. Pricing and whether an open-source app qualifies for free use must be asked of StackBlitz.
- WebContainers is not a Linux environment: it runs Node and a JS-implemented shell. It cannot run arbitrary native binaries, so it suits JS-based agent CLIs but not "apt install anything".

### Gaps
- No source checked for WebContainer networking internals. (background, unverified): outbound HTTP goes through browser fetch and is subject to CORS; no raw TCP; dev-server previews are served through a service worker on a StackBlitz-controlled domain, which means the runtime depends on StackBlitz-hosted origins even when embedded.
- Whether the open-source/free allowance covers an app like Beamhop, and current rate limits, were not found.
- No evidence found of Claude Code, Codex CLI or OpenCode running unmodified inside WebContainers. (background, unverified): bolt.new/bolt.diy run their own agent loop against WebContainers rather than a stock CLI.
- Mobile behaviour (iOS memory kills, Android Chrome) is not documented on the support page.
- bolt.diy licence and its dependence on the WebContainer licence were not checked.

## 2. CheerpX / WebVM and BrowserPod / BrowserCode (Leaning Technologies)

### Takeaway
Leaning Technologies now has two distinct products: CheerpX/WebVM (x86 JIT running unmodified Debian binaries, networking through Tailscale) and BrowserPod (a from-scratch Wasm kernel with Linux syscalls, running programs recompiled to Wasm). BrowserPod is the only technology found that demonstrably runs unmodified Claude Code, Codex CLI and Pi in a browser tab, and since 16 Nov 2026 its runtime is free for commercial use when loaded from their CDN, though the runtime is not open source and self-hosting needs an enterprise licence.

### Cited Findings
BrowserPod architecture
- BrowserPod is a "WebAssembly-native kernel, designed from scratch to run in the browser" exposing Linux-compatible syscalls; each program is one Wasm binary and each process or thread runs in its own Web Worker — [BrowserPod deep dive, 18 May 2026](https://labs.leaningtech.com/blog/browserpod-deep-dive)
- Node.js is a modified build that executes JavaScript on the browser's own JS engine ("native-like performance"); git is the official git compiled to Wasm; bash, Python and many CLI utilities run — [BrowserPod deep dive](https://labs.leaningtech.com/blog/browserpod-deep-dive)
- Filesystem is POSIX-compatible, "effectively an Ext2 implementation"; disk images stream block by block over HTTP range requests or a Cloudflare WebSocket service; blocks are cached and writes persisted locally in OPFS or IndexedDB — [BrowserPod deep dive](https://labs.leaningtech.com/blog/browserpod-deep-dive)
- Packages are built with Cheerp (FOSS) for a new `wasm32-browserpod-linux` target using Nix; WASI and WASIX were considered and rejected in favour of Linux syscalls — [BrowserPod deep dive](https://labs.leaningtech.com/blog/browserpod-deep-dive)
- Stated limits: source code is required (third-party x86 binaries unsupported until CheerpX is integrated); JIT-generating programs need special handling; no paging for very large Wasm modules; no desktop OpenGL/Vulkan — [BrowserPod deep dive](https://labs.leaningtech.com/blog/browserpod-deep-dive)
- No benchmark numbers are published; the claim is "almost native speed" for Wasm binaries — [BrowserPod deep dive](https://labs.leaningtech.com/blog/browserpod-deep-dive)
- First BrowserPod release was February 2026 — [BrowserPod deep dive](https://labs.leaningtech.com/blog/browserpod-deep-dive)

BrowserPod 4.0 (16 Nov 2026)
- BrowserPod 4.0 is free for any use including commercial and production under the "BrowserPod Community Licence": "No usage limit, no fee, nothing metered"; no account, API key or telemetry for the core runtime, which loads from a CDN; published runtime versions are immutable — [BrowserPod 4.0 post](https://labs.leaningtech.com/blog/browserpod-40)
- Self-hosting, vendoring or redistributing the runtime requires a BrowserPod Enterprise Licence — [BrowserPod 4.0 post](https://labs.leaningtech.com/blog/browserpod-40)
- Installable from npm as `@leaningtech/browserpod` — [BrowserPod 4.0 post](https://labs.leaningtech.com/blog/browserpod-40)
- New "fetch network": outbound HTTP/HTTPS routed through the browser's `fetch()` with no API key; no inbound traffic, so Portals do not work on it; most sites block it unless they send CORS headers; a custom fetch function can route through a CORS proxy; `BrowserPod.opinionatedFetch` strips npm telemetry headers so `npm install`/`pnpm install` work — [BrowserPod 4.0 post](https://labs.leaningtech.com/blog/browserpod-40)
- "BrowserPod Edge" (the managed Cloudflare-based proxy) needs an API key, can open TCP connections on any port to allowed domains on every plan including Free, and supports inbound Portals; Pro allows any domain or a per-key allowlist — [BrowserPod 4.0 post](https://labs.leaningtech.com/blog/browserpod-40)
- Runtimes in 4.0: Node.js, Rust, git, bash, npm, pnpm; Python in preview; Go "coming soon"; OpenSSH, ripgrep and fd added to the base image — [BrowserPod 4.0 post](https://labs.leaningtech.com/blog/browserpod-40)
- Leaning Tech says BrowserPod does not replace cloud sandboxes for headless, long-running or GPU workloads — [BrowserPod 4.0 post](https://labs.leaningtech.com/blog/browserpod-40)
- Portals are randomly generated `browserportal.io` subdomains that route HTTP to ports inside the pod via Cloudflare Workers — [BrowserPod deep dive](https://labs.leaningtech.com/blog/browserpod-deep-dive)

BrowserCode (agent CLIs on BrowserPod)
- BrowserCode is Apache-2.0 and runs "unmodified versions of Claude Code, Codex CLI and Pi" (beta); Antigravity and OpenCode are listed as coming soon — [leaningtech/browsercode README](https://github.com/leaningtech/browsercode)
- The showcase page instead lists Claude Code and Gemini CLI as beta with Codex CLI and OpenCode coming soon; the two pages disagree, and the README looks newer — [BrowserCode showcase](https://labs.leaningtech.com/showcase/browsercode); contradicted by [README](https://github.com/leaningtech/browsercode)
- Requirements: WebAssembly JSPI, i.e. Chrome/Edge 137+, Firefox 153+ or Safari 27+; agents and Node.js projects do not run on iOS or iPadOS in any browser; desktop Chromium is recommended — [browsercode README](https://github.com/leaningtech/browsercode)
- BrowserPod needs SharedArrayBuffer and therefore cross-origin isolation; an embedding page must send `COOP: same-origin` and `COEP: require-corp` and the iframe needs `allow="cross-origin-isolated"` — [browsercode README](https://github.com/leaningtech/browsercode)
- Claude Code login needs the "copy code" flow because the default browser login redirects to a localhost callback the pod cannot receive; Codex takes an OpenAI API key stored in the browser — [browsercode README](https://github.com/leaningtech/browsercode)
- Outbound traffic in BrowserCode is restricted to an allowlist (npm registry, Yarn, GitHub, raw.githubusercontent.com, major AI provider APIs); other hosts fail to resolve; no native binaries yet; esbuild and rollup are swapped for their Wasm builds — [browsercode README](https://github.com/leaningtech/browsercode)
- Self-hosting BrowserCode as documented needs a BrowserPod API key in `VITE_API_KEY` — [browsercode README](https://github.com/leaningtech/browsercode)

CheerpX / WebVM
- WebVM's repo is Apache-2.0, but the CheerpX engine it depends on is proprietary: the public deployment is free for exploration, testing and individual use; organisational use needs a licence and hosting a CheerpX build elsewhere needs a commercial licence — [leaningtech/webvm](https://github.com/leaningtech/webvm)
- CheerpX Community Licence: free for individuals (including one-person companies), FOSS projects and technical evaluations, with attribution, for "unlimited, unmetered use of CheerpX from the `cxrtnc.leaningtech.com` domain"; any other business use, redistribution or self-hosting needs a paid Commercial Licence — [CheerpX licensing](https://cheerpx.io/docs/licensing)
- WebVM runs an unmodified Debian userland from an ext2 disk image; networking is by joining a Tailscale network (auth key or login), with an exit node needed for public internet; Headscale works but needs a CORS proxy; no ICMP — [leaningtech/webvm](https://github.com/leaningtech/webvm)
- WebVM documents a GitHub Pages deployment (fork, set Pages source to GitHub Actions, run the Deploy workflow); the large Debian image is too big for Pages — [leaningtech/webvm](https://github.com/leaningtech/webvm)
- WebVM ships a built-in Claude integration that takes the user's Anthropic API key, stored only in the browser — [leaningtech/webvm](https://github.com/leaningtech/webvm)
- Leaning Tech itself contrasts BrowserPod's networking with WebVM, noting WebVM required users to install/set up Tailscale — [BrowserPod deep dive](https://labs.leaningtech.com/blog/browserpod-deep-dive)

### Inferences
- BrowserPod is the closest match to the stated goal (shell, filesystem, npm/pnpm, real git, Node, agent CLIs unmodified, zero install). Its real costs for Beamhop are: (a) a closed runtime loaded from Leaning Tech's CDN, so a hard third-party dependency for a "serverless" app, with self-hosting gated behind an enterprise licence; (b) no iOS/iPadOS; (c) JSPI + cross-origin isolation required; (d) full networking and previews depend on their Edge proxy and an API key.
- The 4.0 fetch network is the only fully serverless networking mode: it works with no key but only against CORS-enabled hosts. Whether model-provider APIs and git hosts are reachable this way depends on each host's CORS policy, which I did not test.
- WebVM's Tailscale requirement (the user needs a tailnet and an exit node) breaks "nothing to set up" for public internet access, even though nothing is installed in the browser. That and the licence make it a weaker fit than BrowserPod for an agent sandbox, but it is the route to unmodified x86 binaries.
- The licence history moved fast (whitelist-limited free tier in May 2026, "free for any use" in Nov 2026), so terms should be re-read at decision time and treated as changeable.

### Gaps
- No quantitative performance figures (boot time, slowdown vs native, memory ceiling) were found for BrowserPod or CheerpX. (background, unverified): CheerpX has been 32-bit x86 only, with 64-bit on the roadmap.
- Whether WebVM can run Node or the Claude Code CLI unmodified was not confirmed; the README mentions only native toolchains and Python. Claude Code needs a recent Node and an HTTPS path to Anthropic, both doubtful on a 32-bit x86 guest behind Tailscale.
- The BrowserPod 4.0 post does not state browser support, mobile status or any change to the iOS exclusion; Android Chrome is not mentioned anywhere.
- I did not read the Community Licence text itself, only the blog's description of it; data-handling terms for the Edge proxy were not checked.
- Whether BrowserPod works when the host page gets its isolation headers from a service worker shim (GitHub Pages case) is not documented in what I read.

## 3. Other technologies: emulators, Wasm kernels, WASI runtimes, WebContainer clones, virtual shells

### Takeaway
The remaining options split into three tiers: full-system emulators (v86, container2wasm, JSLinux) that run real Linux but slowly and with awkward networking; experimental native-Wasm Linux ports (linux-wasm) that are tech demos; and lightweight JS/Wasm userlands (almostnode, just-bash, Wasmer/WASIX) that start instantly and are permissively licensed but are not Linux and cannot run arbitrary binaries.

### Cited Findings
v86
- v86 is an x86 PC emulator with an x86-to-Wasm JIT; it emulates roughly a Pentium 4, with no multicore and no 64-bit extensions, so 64-bit kernels are unsupported — [copy/v86](https://github.com/copy/v86)
- FPU instructions use softfloat, described by the project as very slow — [v86 how-it-works](https://www.github.com/copy/v86/blob/master/docs/how-it-works.md)
- Networking offers NE2000 and virtio NICs with several backends; the wisp backend wraps guest TCP payloads in WISP messages to a relay, handles only client-side TCP/UDP (the guest cannot serve through it), and isolates guests from each other — [v86 networking docs](https://raw.githubusercontent.com/copy/v86/master/docs/networking.md)
- A v86 issue on Node.js performance reports large cold-start overhead attributed to JIT warm-up, with warm runs still much slower than hoped — [copy/v86 issue #1005](https://www.github.com/copy/v86/issues/1005)

container2wasm
- container2wasm is Apache-2.0 and converts container images to Wasm by bundling an emulator: Bochs for x86_64, TinyEMU for riscv64, and QEMU-Wasm (emscripten, `--to-js`) for the browser; generated images embed Bochs (LGPL-2.1), GRUB (GPLv3) and Linux (GPLv2) — [container2wasm README](https://github.com/container2wasm/container2wasm)
- It describes itself as experimental; non-native architectures run slower through extra emulation — [container2wasm README](https://github.com/container2wasm/container2wasm)
- Browser networking has two modes: a network stack running in the browser (based on gvisor-tap-vsock) that forwards HTTP/HTTPS via the Fetch API and is limited by CORS, or forwarding all packets over WebSocket to a `c2w-net` process on a host; browser networking was tested only on Chrome — [container2wasm README](https://github.com/container2wasm/container2wasm)

Linux compiled natively to Wasm
- Joel Severin announced a port of the Linux kernel to WebAssembly on LKML in November 2025, after roughly two years of work; it compiles kernel and userland to Wasm (no ISA emulation), runs each process in its own Web Worker, and demos BusyBox in xterm.js — [LWN](https://lwn.net/Articles/1044787/); [LKML post](https://lkml.iu.edu/2511.0/00248.html)
- The author calls it a technology demo, and Phoronix reported crashes in Chrome — [Slashdot summary of Phoronix](https://linux.slashdot.org/story/25/11/03/0610234/linux-ported-to-webassembly-boots-in-a-browser-tab)
- A separate earlier effort exists at tombl/linux — [tombl/linux](https://github.com/tombl/linux)

almostnode and other WebContainer-style clones
- almostnode is MIT, a "browser-native Node.js runtime" emulating Node 20 APIs, ~250 KB gzipped, with npm install into a virtual filesystem, Vite and Next.js dev servers, and a shell built on just-bash; the README labels it experimental — [macaly/almostnode](https://github.com/macaly/almostnode)
- almostnode limits: native modules are stubs; `net`, `tls`, `dns` are stubbed; networking is virtual ports, not TCP/IP; shell is a POSIX subset; git is not mentioned — [macaly/almostnode](https://github.com/macaly/almostnode)
- almostnode security: recommended mode runs code in a cross-origin sandbox (separate origin serving with `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`), which blocks cookies/localStorage/IndexedDB/DOM but not network requests; same-origin mode is for trusted code only — [macaly/almostnode](https://github.com/macaly/almostnode)
- almostnode has ~1.2k GitHub stars and roughly 770 weekly npm downloads — [macaly/almostnode](https://github.com/macaly/almostnode); [Socket](https://socket.dev/npm/package/almostnode)
- A project on Trendshift is described as an "open-source MIT WebContainer alternative" running Node, Bun and Python in the browser, but its listing also says "source-available under MIT + Commons Clause"; I could not identify or verify it — [Trendshift](https://trendshift.io/repositories/341330)

just-bash
- just-bash (vercel-labs) is Apache-2.0, "a simulated bash environment with virtual filesystem", tagline "Bash for Agents", ~4.5k stars, and ships a `THREAT_MODEL.md` — [vercel-labs/just-bash](https://github.com/vercel-labs/just-bash)

Wasmer / WASIX
- `@wasmer/sdk` runs WASIX packages in the browser with threads, signals and subprocesses; CPython and Bash are the headline examples and wasmer.sh is bash piped into xterm.js through the SDK — [Introducing the Wasmer JS SDK (2023)](https://wasmer.io/posts/introducing-the-wasmer-js-sdk)
- The SDK needs cross-origin isolation (Wasmer documents COOP/COEP setup and a SharedArrayBuffer troubleshooting page); packages are downloaded on first run and cached in browser storage — [Wasmer COOP/COEP how-to](https://docs.wasmer.io/sdk/wasmer-js/how-to/coop-coep-headers); [Wasmer JS docs](https://docs.wasmer.io/runtime/js)
- Leaning Tech evaluated WASI and WASIX for BrowserPod and rejected both in favour of implementing Linux syscalls — [BrowserPod deep dive](https://labs.leaningtech.com/blog/browserpod-deep-dive)

### Inferences
- Rough fit ranking for "run a stock agent CLI with a real shell": BrowserPod (shown working) > WebContainers (capable for Node CLIs, licence and closed source) > emulators (anything runs, but Node-heavy CLIs are slow and need a network relay) > almostnode / just-bash / WASIX (fast and open, but an agent must be written or adapted for them).
- For Beamhop there are really two product shapes. One is "run someone else's CLI unmodified", which today means BrowserPod. The other is "our own agent loop with tools backed by a virtual shell and filesystem" (just-bash or almostnode plus OPFS and an in-browser git), which is fully open source, has no third-party runtime dependency, needs no cross-origin isolation in the simplest configuration, and is the only shape likely to work on iOS.
- Emulator options are the only fully open-source route to unmodified Linux binaries, but 32-bit-only (v86) or interpreter-grade speed (Bochs in c2w) makes a modern Node-based agent CLI impractical; they suit "run a small native tool" more than "run the agent".
- linux-wasm is architecturally the same idea as BrowserPod (Wasm processes on a real syscall ABI, one Worker per process) in open-source form, but a year after announcement there is no evidence it is usable beyond BusyBox.

### Gaps
- Not checked in this session, no sourced claims: JSLinux/TinyEMU as a standalone, Browsix, Nodebox (CodeSandbox), OpenWebContainer (the search returned nothing confirming it), bolt.diy, runno, Pyodide, QuickJS-wasm, wasm-git, isomorphic-git, ZenFS, jco / WASI preview 2-3 in browsers.
- (background, unverified) for those: Nodebox is a closed-core Node-compatible runtime from CodeSandbox that avoids SharedArrayBuffer and so works without cross-origin isolation; Pyodide is CPython on emscripten with micropip and pure-Python or prebuilt wheels only; isomorphic-git is a pure-JS git that needs a CORS proxy for most git hosts; wasm-git is libgit2 on emscripten; ZenFS is the BrowserFS successor with IndexedDB/OPFS backends; jco transpiles WASI 0.2 components to run in browsers with partial host-interface shims and no native browser component-model support; Browsix is a dormant research project; Fabrice Bellard's JSLinux is a demo with a restrictive rate-limited network relay. None of these is a full OS on its own; they are building blocks for the "own agent loop" shape.
- just-bash details (command list, filesystem backends, network allow-list, optional Python/SQLite/JS runtimes, browser build) were not read; the repo landing page only links to the package README. The almostnode acknowledgement calling it "POSIX shell in WebAssembly" conflicts with (background, unverified) my understanding that it is implemented in TypeScript.
- No benchmark numbers found for v86, container2wasm or Wasmer in the browser; the brief's "slowdown vs native" question is unanswered with sources for every option.
- Current maintenance status and release dates of container2wasm, v86, linux-wasm and wasmer-js in late 2026 were not checked.

## 4. Platform constraints: isolation, threads, JSPI, Memory64, memory and storage limits

### Takeaway
SharedArrayBuffer (hence COOP/COEP) is required by every heavyweight option (WebContainers, BrowserPod, Wasmer), and on GitHub Pages it can only come from a service-worker shim. JSPI reached all three engines during 2026 (Chrome 137, Firefox 153, Safari 27), Memory64 is in Chrome and Firefox but was still missing from Safari as of the latest evidence found, and iOS remains the hard limit because of per-tab memory kills.

### Cited Findings
- GitHub Pages cannot set COOP/COEP; `coi-serviceworker` injects them via a service worker with a one-time reload — [coi-serviceworker](https://www.github.com/gzuidhof/coi-serviceworker); [GitHub discussion #13309](https://github.com/orgs/community/discussions/13309)
- `COEP: credentialless` (which relaxes the need for every third-party asset to send CORP) was missing in Safari per a 2021 WebKit bug, and a later guide still says it is not uniformly supported, recommending `require-corp` as the mode every engine supports — [WebKit bug 230550](https://bugs.webkit.org/show_bug.cgi?id=230550); [dev.to guide](https://dev.to/osidorkin/fix-sharedarraybuffer-is-not-defined-a-practical-guide-to-cross-origin-isolation-1neh)
- StackBlitz argued in its own post that `credentialless` is the missing piece for WebContainers in all browsers — [StackBlitz: COEP credentialless call to action](https://blog.stackblitz.com/posts/bringing-webcontainers-to-all-browsers/)
- JSPI: Chrome shipped it (proposal at phase 4) — [Chromium intent to ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/w_jCD4gf7Bc); Mozilla's June 2026 intent to ship enables it by default from Firefox 153 — [Mozilla dev-platform](https://groups.google.com/a/mozilla.org/g/dev-platform/c/8cOxM-dWaNs); WebKit's WWDC26 recap lists JSPI among new features — [WebKit WWDC26 post](https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-saf)
- A downstream project states the concrete minimum versions as Chrome/Edge 137+, Firefox 153+, Safari 27+ — [browsercode README](https://github.com/leaningtech/browsercode)
- Memory64: enabled by default from Firefox 134 — [Mozilla intent to ship](https://groups.google.com/a/mozilla.org/g/dev-platform/c/I-MywEnFxKc); [caniuse](https://caniuse.com/wf-wasm-memory64). An October 2025 WebKit bug calls Memory64 the only remaining Wasm feature Safari lacks — [WebKit bug 300538](https://bugs.webkit.org/show_bug.cgi?id=300538)
- Mozilla's own analysis questions whether Memory64 is worth it because of the performance cost of 64-bit bounds checks — [SpiderMonkey blog, Jan 2025](https://spidermonkey.dev/blog/2025/01/15/is-memory64-actually-worth-using.html)
- iOS: the WebContent process has an OS-defined memory limit of about 1.5 GB on most iPhones, can sometimes exceed it without memory pressure, and can be killed by the OS at its discretion — [WebKit bug 269777](https://www2.webkit.org/show_bug.cgi?id=269777); [WebKit bug 221530](https://bugs.webkit.org/show_bug.cgi?id=221530)
- Storage: WebKit applies a per-origin and an overall quota; exceeding it throws `QuotaExceededError`; the quota is an upper bound, not a guarantee — [WebKit: Updates to Storage Policy](https://webkit.org/?p=14403); general rules in [MDN: Storage quotas and eviction criteria](https://developer.mozilla.org/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- BrowserPod's design note says multiplexing threads onto one Worker might become possible using JSPI; today each process/thread costs a Worker — [BrowserPod deep dive](https://labs.leaningtech.com/blog/browserpod-deep-dive)

### Inferences
- Because JSPI landed in Firefox 153 and Safari 27 only in 2026, any JSPI-dependent sandbox excludes users on older browsers for a while; Asyncify-based builds remain the compatibility fallback at a code-size and speed cost.
- With Safari lacking Memory64 (as of the last evidence), a portable sandbox should assume a 4 GB wasm32 ceiling per memory, and far less on phones. Multi-process designs (one memory per process) sidestep the per-memory cap but not the per-tab kill on iOS.
- Persistence should target OPFS with graceful handling of quota errors and eviction; a PWA should request persistent storage. A repo plus `node_modules` can plausibly reach hundreds of MB, which is within desktop quotas but risky on iOS.

### Gaps
- Could not confirm whether Safari 27 ships JSPI enabled by default beyond the WWDC recap and the BrowserCode README, nor whether Safari has shipped Memory64 by November 2026 (one secondary article projected Q4 2026; unconfirmed).
- No current, authoritative figure found for iOS OPFS quota or for Android Chrome wasm memory limits. (background, unverified): Chromium allows an origin up to roughly 60% of disk; Safari evicts script-written storage after 7 days without interaction for sites not installed to the home screen.
- Current Safari status of `COEP: credentialless` in late 2026 not confirmed.
- (background, unverified): on Safari the service-worker header shim has historically been less reliable than on Chromium; needs a hands-on test.

## 5. Networking from inside the sandbox

### Takeaway
No zero-install option gives real sockets without some server in the path. The choices are browser `fetch` (serverless, CORS-bound, HTTP only), a WebSocket/Wisp-style relay or vendor proxy (needs a server someone runs), or a Tailscale-in-Wasm tunnel (needs the user's own tailnet). Inbound "localhost preview" works only via a service worker or a vendor-hosted portal domain.

### Cited Findings
- Browsers expose no raw TCP/UDP socket API to ordinary pages; the Direct Sockets API is limited to Isolated Web Apps — [BrowserPod deep dive](https://labs.leaningtech.com/blog/browserpod-deep-dive)
- Fetch-based egress: BrowserPod 4.0's fetch network (no key, CORS-bound, custom fetch can add a CORS proxy) — [BrowserPod 4.0](https://labs.leaningtech.com/blog/browserpod-40); container2wasm's in-browser stack forwarding HTTP/HTTPS over Fetch with CORS limits — [container2wasm README](https://github.com/container2wasm/container2wasm)
- Relay-based egress: v86 wisp backend (client-side TCP/UDP only) — [v86 networking docs](https://raw.githubusercontent.com/copy/v86/master/docs/networking.md); container2wasm WebSocket delegate to a host process — [container2wasm README](https://github.com/container2wasm/container2wasm); BrowserPod Edge TCP proxy on Cloudflare Workers with domain allowlists and an API key — [BrowserPod 4.0](https://labs.leaningtech.com/blog/browserpod-40)
- VPN-in-Wasm: WebVM joins a Tailscale network from the browser and needs an exit node for public internet; Headscale needs a CORS proxy; no ICMP — [leaningtech/webvm](https://github.com/leaningtech/webvm)
- Inbound/preview: BrowserPod Portals map pod ports to public `browserportal.io` URLs through Cloudflare and need the Edge network — [BrowserPod deep dive](https://labs.leaningtech.com/blog/browserpod-deep-dive); [BrowserPod 4.0](https://labs.leaningtech.com/blog/browserpod-40). almostnode uses a service worker to give its virtual dev servers a URL — [macaly/almostnode](https://github.com/macaly/almostnode)
- almostnode stubs `net`/`tls`/`dns` and warns its sandbox does not stop outbound requests, recommending CSP — [macaly/almostnode](https://github.com/macaly/almostnode)
- OAuth-style logins that redirect to a localhost callback fail inside a pod; BrowserCode works around it with a copy-the-code flow — [browsercode README](https://github.com/leaningtech/browsercode)

### Inferences
- For a serverless app, fetch + CORS is the only egress with no operator. It is enough for an agent only if the model API, the package registry and the git host all allow cross-origin requests from the app's origin; anything else needs a CORS proxy, and whoever runs that proxy sees the traffic metadata (and plaintext unless TLS is terminated inside the sandbox).
- A relay that carries raw TCP with TLS terminated inside the sandbox keeps content private from the relay operator, which fits Beamhop's end-to-end-encryption posture better than an HTTP CORS proxy. Beamhop already relies on third-party relays (Nostr), so a user-configurable relay URL is a consistent pattern.
- Egress allowlisting is also the main defence against a prompt-injected agent exfiltrating room content or API keys; the "everything allowed via fetch" mode is the most dangerous default, since a tab's fetch runs with the user's network position.

### Gaps
- WebTransport as a sandbox transport was not researched beyond a secondary note that the WebSocket-over-HTTP/3 and related specs were still drafts in early 2026 — [dev.to (secondary, low confidence)](https://dev.to/instatunnel/no-install-no-risk-the-rise-of-webassembly-native-tunneling-16b8).
- Which AI provider APIs, npm registry endpoints and git hosts send permissive CORS headers was not tested. (background, unverified): the npm registry and Anthropic's API (with an explicit opt-in header) allow browser calls; GitHub's git smart-HTTP endpoints do not send CORS headers, which is why isomorphic-git needs a proxy.
- No source checked for public Wisp relay availability, terms or abuse limits.

## 6. Which approaches have actually run a real AI coding agent CLI in the browser

### Takeaway
Only one verified case was found: BrowserCode on BrowserPod, which runs unmodified Claude Code, Codex CLI and Pi (beta) fully client-side on desktop browsers. No evidence was found of stock agent CLIs running on WebContainers, v86, container2wasm, Wasmer or almostnode.

### Cited Findings
- BrowserCode runs "unmodified versions of Claude Code, Codex CLI and Pi", beta, with OpenCode and Antigravity "coming soon"; each agent is given a CLAUDE.md/AGENTS.md telling it about the custom environment — [browsercode README](https://github.com/leaningtech/browsercode)
- Leaning Tech states Claude Code runs unmodified via BrowserCode on BrowserPod 2.0 — [BrowserPod deep dive](https://labs.leaningtech.com/blog/browserpod-deep-dive)
- Gemini CLI is listed as beta on the showcase page but appears only as a repo topic in the README — [showcase](https://labs.leaningtech.com/showcase/browsercode); [README](https://github.com/leaningtech/browsercode)
- WebVM has a Claude chat/computer-use style integration using the user's API key, which is an integration built into the page, not the Claude Code CLI running in the VM — [leaningtech/webvm](https://github.com/leaningtech/webvm)
- "XCodex WASM" is listed on Product Hunt as Codex running in the browser with no backend; no technical detail was available to verify it — [Product Hunt](https://www.producthunt.com/posts/1103980)
- Anthropic's "Claude Code on the web" runs in Anthropic's cloud, not in the tab, so it is not an example of this — [Maginative](https://www.maginative.com/article/anthropic-launches-claude-code-on-the-web/)
- almostnode's README shows an AI SDK chatbot demo but no agent CLI — [macaly/almostnode](https://github.com/macaly/almostnode)

### Inferences
- Stock agent CLIs are Node programs that expect child processes, a real shell, ripgrep, git and outbound HTTPS. BrowserPod supplies exactly those (it added ripgrep, fd and OpenSSH in 4.0), which explains why it is the one place they run unmodified.
- Agents with a native binary distribution cannot run there ("no native binaries yet"), so an agent's packaging determines portability; this is likely why some agents are still "coming soon".
- Elsewhere, the realistic pattern is an agent loop in the page calling a virtual shell/filesystem as tools, not a ported CLI.

### Gaps
- I did not load browsercode.io or measure startup time, memory use or reliability; "beta, find out what breaks" is the vendor's own description.
- No search was made specifically for OpenCode/pi/Gemini CLI on WebContainers or v86; absence of evidence here is weak.
- How BrowserCode reaches Anthropic/OpenAI APIs (direct CORS fetch vs Edge proxy) is not documented in the pages read.

## 7. Mobile viability (iOS Safari, Android Chrome)

### Takeaway
iOS/iPadOS is effectively unsupported for the heavyweight sandboxes: BrowserCode explicitly does not run agents or Node there in any browser, and iOS kills tabs around a ~1.5 GB process limit. Android Chrome is undocumented by every vendor checked, so it is unknown rather than supported.

### Cited Findings
- BrowserCode: agents and Node.js projects "don't run on iOS or iPadOS in any browser"; desktop Chromium recommended; Android not mentioned — [browsercode README](https://github.com/leaningtech/browsercode)
- WebContainers docs list Safari as beta and do not address mobile on the support page; StackBlitz separately announced Safari/iOS/iPadOS and Firefox-on-Android support — [browser support](https://webcontainers.io/guides/browser-support); [Safari/iOS post](https://blog.stackblitz.com/posts/webcontainers-are-now-supported-on-safari/); [Firefox post](https://blog.stackblitz.com/posts/webcontainers-are-now-supported-on-firefox/)
- iPhone WebContent process limit of about 1.5 GB on most devices, with discretionary OS kills — [WebKit bug 269777](https://www2.webkit.org/show_bug.cgi?id=269777); [WebKit bug 221530](https://bugs.webkit.org/show_bug.cgi?id=221530)
- 2025-2026 WebKit reports describe reload loops and out-of-memory crashes on memory-heavy pages on iOS — [WebKit bug 309251](https://bugs.webkit.org/show_bug.cgi?id=309251); [WebKit bug 304810](https://bugs.webkit.org/show_bug.cgi?id=304810)
- All iOS browsers were historically WebKit-based, which is consistent with "in any browser" in the BrowserCode note — [browsercode README](https://github.com/leaningtech/browsercode)

### Inferences
- A worker-per-process design plus a Node runtime plus `node_modules` in memory is a poor match for the iOS budget, so the iOS exclusion is likely structural, not a temporary bug.
- For a chat PWA where many users are on phones, the sandbox should be an optional capability: a phone joins the room and talks to an agent hosted in another participant's desktop tab, or uses a lightweight JS-only tool sandbox (virtual shell + OPFS) that fits in tens of MB.
- Mobile browsers also suspend background tabs aggressively, so a long-running agent in a phone tab would stall when the user switches apps regardless of memory.

### Gaps
- No vendor statement or test found for Android Chrome with BrowserPod, WebContainers or Wasmer; needs a hands-on test on a mid-range device.
- The reason BrowserPod excludes iOS (memory, JSPI, Worker limits or SharedArrayBuffer behaviour) is not stated.
- Whether the EU alternative-engine allowance changes anything for iOS browsers in practice was not researched.
- Background-tab throttling and suspension behaviour was not sourced. (background, unverified.)
