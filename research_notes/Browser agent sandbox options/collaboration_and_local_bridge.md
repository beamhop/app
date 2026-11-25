# Collaboration architectures and local desktop bridge for Beamhop (state as of late Nov 2026)

Scope: (A) real-time multi-user + multi-agent collaboration for a serverless, E2EE browser app; (B) zero/low-install ways to connect desktop agents to a web page.
Beamhop baseline (from README.md / PLAN.md): static PWA on GitHub Pages, no backend, Nostr keypair identity, room key (NIP-44) re-issued in NIP-59 gift wraps on membership change, files AES-GCM on Blossom, browser agents = fx (WASM) in the owner's tab with a Web Worker sandbox (JS + Pyodide, per-room files), desktop agents via `npx` bridge (ACP / cmd / MCP stdio) or the Companion extension, rooms up to ~50 members, agents run on "whichever of the owner's devices is online".

Reading notes:
- "Cited Findings" are things I read in a source this session. Where the source is secondary or I could not confirm against a primary, it is flagged inline.
- "Inferences" are my reasoning and are not sourced facts.
- Many items in the brief could not be checked within the tool budget; they are listed under "Gaps" rather than filled in from memory.

---

## A1. Sharing a workspace that lives in one member's tab: CRDT / sync-engine options and E2EE access control

### Takeaway
No surveyed library gives "E2EE + serverless + multi-writer filesystem" out of the box: the E2EE-native ones (Jazz, Keyhive/Beelay) either expect a sync server or are pre-alpha, while the mature CRDTs (Yjs, Automerge, Loro) are transport-agnostic and would have to be encrypted with Beamhop's existing room key and carried over Nostr and/or WebRTC. Server-authoritative designs (tldraw sync) do not fit because the authority sees plaintext.

### Cited Findings
- Keyhive (Ink & Switch) is a project to add access control to local-first apps using "convergent capabilities", with guarantees likened to private group messaging; Beelay is the co-designed next Automerge sync protocol that syncs E2EE payloads a server cannot decrypt and only syncs with replicas granted access in Keyhive. — [Ink & Switch Keyhive project page](https://www.inkandswitch.com/project/keyhive/)
- Keyhive and Beelay were open-sourced as a **pre-alpha**; Keyhive is the signing/encryption/delegation core, Beelay the auth-enabled sync over E2EE data. — [Ink & Switch Dispatch 010](https://www.inkandswitch.com/newsletter/dispatch-010). I found no 2026 release or production-readiness announcement in this session (see Gaps).
- Jazz: Groups use a shared symmetric "read key" handed by admins to accounts with reader-or-higher roles; keys rotate automatically when a member leaves; every change is signed; data stays encrypted on Jazz Cloud servers. — [Jazz encryption docs](https://jazz.tools/docs/react/reference/encryption)
- Jazz needs a sync server: Jazz Cloud or self-hosted via `npx jazz-run sync` (default port 4200, SQLite storage, `--in-memory` option, Node 20+). — [Jazz sync and storage docs](https://jazz.tools/docs/sync-and-storage)
- Yjs/y-webrtc: peers exchange document updates directly; signaling servers only set up connections; a room `password` encrypts everything that passes through the signaling servers. — [y-webrtc README](https://github.com/yjs/y-webrtc/)
- The Yjs maintainers' forum position is that the stock y-websocket server "probably can't be extended to support e2e encryption because it needs to interpret document updates". — [Yjs forum: implementing E2EE](https://discuss.yjs.dev/t/implementing-end-to-end-encryption/308/2)
- A community package bridges y-webrtc onto Trystero (so Yjs can use Trystero's serverless signaling strategies). — [@winstonfassett/y-webrtc-trystero](https://www.pkgstats.com/pkg:@winstonfassett/y-webrtc-trystero) (not evaluated for quality/maintenance)
- Loro is a Rust CRDT library focused on memory, CPU and load speed; `loro-crdt` on npm was at 1.5.4 in the listing I saw. — [loro-crdt on npm](https://npmjs.com/package/loro-crdt). A secondary 2026 comparison calls it fastest in benchmarks but youngest in ecosystem. — [pkgpulse comparison (secondary)](https://www.pkgpulse.com/guides/yjs-vs-automerge-vs-loro-crdt-libraries-2026)
- Automerge 3 (fall 2025) is described by one blog as fixing Automerge 2's memory/document-size weaknesses. — [youngju.dev deep dive (secondary, single source)](https://www.youngju.dev/blog/culture/2026-05-15-crdt-local-first-engines-2026-yjs-automerge-loro-replicache-liveblocks-deep-dive.en)
- tldraw sync is server-authoritative: exactly one `TLSocketRoom` per room globally (one Cloudflare Durable Object per room), persistence in the DO's SQLite, assets in R2; tldraw's docs cite up to 50 simultaneous collaborators. — [tldraw sync docs](https://tldraw.dev/docs/sync); [tldraw-sync-cloudflare](https://github.com/tldraw/tldraw-sync-cloudflare)
- Zed launched **Delta** (Aug 12, 2026): a multiplayer environment for coding with agents built on DeltaDB, a real-time database syncing code and conversation together; threads are shared so teammates can join a live agent thread; work can move to a cloud runner so the agent continues with the laptop closed. — [Zed: Introducing Delta](https://zed.dev/blog/introducing-delta). Reported in public beta in Sept 2026 by [The New Stack (secondary)](https://thenewstack.io/zed-delta-github-alternative/); a `/delta share` plugin for multiplayer Claude Code sessions is reported by [AlphaSignal (secondary)](https://alphasignal.ai/news/zed-lets-developers-share-live-claude-code-sessions-across-machines).

### Inferences
- The "single authoritative room" pattern (tldraw, and effectively Delta's cloud runner) maps onto Beamhop as "the hosting tab is the authority": the sandbox VM is not a CRDT and cannot be merged, so the realistic split is (1) **files/docs** as a CRDT or content-addressed tree that any member can hold, and (2) **execution** (processes, terminal, Pyodide heap) as single-host state streamed to others.
- For Beamhop, CRDT updates can be treated as opaque bytes: encrypt with the existing room key and ship as Nostr events (durable, async, works offline/late-join) and/or over a WebRTC data channel (low latency for cursors and terminal output). The room key rotation Beamhop already does on leave/remove gives the same forward-exclusion property Jazz documents for its Groups, without adopting Jazz's sync server.
- Keyhive/Beelay is the closest conceptual fit to Beamhop's constraints (E2EE, capability delegation, untrusted relay) but pre-alpha status makes it a watch item, not a dependency.
- Jazz would require a sync server; "self-host with `npx jazz-run sync`" breaks the no-server constraint unless a member runs it, which is the same shape as a member-run always-on node (see A5).

### Gaps
- Not researched this session (no sources fetched): Electric / Durable Streams, Evolu, DXOS, nostr-crdt, Automerge 3 primary release notes, Loro's tree/movable-list/version-control features, Keyhive/Beelay status after the pre-alpha dispatch. Treat any claims about these as unverified.
- No source found on a production "CRDT filesystem" library suitable for a browser sandbox (file tree + binary blobs + rename semantics); whether Loro's tree CRDT or an Automerge-repo layout is the better base is an open design question.
- Whether y-webrtc's password also protects the data channel contents beyond WebRTC's own DTLS was not confirmed.

---

## A2. Transport: Nostr vs WebRTC data channels vs relay-only QUIC; signaling and NAT traversal without owning servers

### Takeaway
WebRTC with signaling over Nostr is an established, library-supported pattern (Trystero) and there is still no merged Nostr NIP for it; the hard residual is TURN, where the only generous free option found (Cloudflare, 1,000 GB/month) requires an account and credential minting, i.e. a tiny server. Iroh in the browser works but is relay-only, so it does not remove the dependency on someone's relay.

### Cited Findings
- Trystero: serverless WebRTC matchmaking over "decentralized public relays"; strategies listed are Nostr, MQTT, BitTorrent, Supabase, Firebase and a self-hosted WebSocket relay. SDP offers are AES-256-GCM encrypted before reaching any relay; a room `password` derives the key (PBKDF2-SHA256, 600,000 iterations) so relay operators cannot read handshakes or join. Identities are ECDSA P-256 keys verified against the DTLS fingerprint. — [Trystero README](https://github.com/dmotz/trystero)
- Trystero npm docs state the default `trystero` package uses the Nostr network for peer discovery and that app data never touches the strategy medium. — [trystero on npm](https://npmjs.com/package/trystero)
- Trystero features relevant to shared workspaces: synced per-user/shared state with late-joiner sync, RPC, binary transfer with chunking/backpressure/progress, media streams, `roles()` (admin-only writes, ban), headless Node/Bun/Deno peers including `passive` peers that keep state available, and a `scale()` plugin that turns larger rooms into a multi-hop gossip network (a 100-person canvas is cited). — [Trystero README](https://github.com/dmotz/trystero)
- Trystero treats TURN as needed only on restrictive networks and exposes a `turnConfig` option; a third-party page estimates 5–10% of users fail without TURN (one author's figure, not a benchmark). — [Trystero docs via npm README](https://unpkg.com/trystero@0.25.2/README.md); [socket.dev third-party package page](https://socket.dev/npm/package/@martini-kit/transport-trystero)
- No official Nostr NIP for WebRTC signaling was found. Projects use ad hoc kinds: a third-party draft "NIP-DC" uses ephemeral kind 25050 with a `t` tag for message types; hashtree uses kind 25050; a Swift Trystero port uses kind 29000; matchbox_nostr encrypts offers/answers with NIP-04. — [NIP-DC draft in nostr4j](https://github-users.yhajoa.workers.dev/NostrGameEngine/nostr4j/blob/master/NIP-DC.md); [hashtree-webrtc](https://docs.rs/crate/hashtree-webrtc/0.2.6/source/README.md); [matchbox_socket_nostr](https://docs.rs/matchbox_socket_nostr)
- Iroh reached 1.0; browser (WASM) nodes are **relay-only** because browsers cannot send raw UDP, so hole punching cannot be ported. Traffic stays end-to-end encrypted through the relay. Browser support is "a subset"; iroh-gossip supports browsers since 0.33; no official npm package (write an app-specific Rust wrapper with wasm-bindgen). Direct connections via WebTransport `serverCertificateHashes` or WebRTC are something the team "may expand" to, not a commitment. — [iroh WASM/browser docs](https://docs.iroh.computer/deployment/wasm-browser-support); [iroh 1.0 announcement](https://iroh.computer/blog/v1)
- Cloudflare Realtime TURN: first 1,000 GB/month free (allowance shared with the SFU), then $0.05/GB, billed on egress from Cloudflare to the TURN client; `stun.cloudflare.com` is free and unlimited. — [Cloudflare Realtime pricing](https://developers.cloudflare.com/realtime/pricing/); [Cloudflare TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/)
- Metered "Open Relay": 20 GB/month free TURN, but now requires an account and credentials from a dashboard. — [Metered Open Relay](https://metered.ca/tools/openrelay/); [dev.to list (secondary)](https://dev.to/aprogrammer22/list-of-free-stun-and-turn-servers-open-relay-project-3a70)
- Chrome's Local Network Access docs (June 2025) said WebRTC connections to local addresses were not yet gated by the permission; I found no later statement changing this. — [Chrome LNA blog](https://developer.chrome.com/blog/local-network-access)

### Inferences
- Layering that fits Beamhop: Nostr stays the durable, authenticated control plane (membership, room key, signaling, CRDT checkpoints); a WebRTC mesh between online members is an optional fast path for terminal bytes, cursors, large file sync. If WebRTC fails (symmetric NAT, no TURN), fall back to ephemeral Nostr events — slower and rate-limited by relays, but zero extra infrastructure.
- Beamhop already has stronger signaling auth than Trystero's password scheme: offers/answers can be gift-wrapped to specific member pubkeys, and the DTLS fingerprint can be signed by the member's Nostr key, so no shared-password step is needed.
- TURN is the first place where "a tiny optional server unlocks a lot": TURN credentials are secrets tied to a billing account, so they cannot be embedded in a static page safely. Options: (a) ship with STUN only and accept a failure tail; (b) a small credential-minting Worker (Cloudflare free allowance is large relative to terminal/doc traffic); (c) let room admins paste their own TURN credentials, distributed E2EE in room state.
- Iroh-in-browser gives dial-by-key and gossip but every byte still transits a relay; versus Nostr relays it offers streams and better throughput, but adds a WASM bundle and dependence on n0's (or someone's) relay fleet. It becomes more interesting if a desktop bridge also speaks iroh natively (direct QUIC between desktops, relay only for the browser leg).

### Gaps
- Not researched: WebTransport as a browser-to-browser option, libp2p WebRTC / js-libp2p status, Hyperswarm/Holepunch browser status, public STUN reliability data, n0 public relay rate limits/terms. Mesh size limits for ~50-member rooms were not measured by any source found.
- Could not confirm Trystero's Nostr event kinds, relay list, or redundancy behaviour from the README alone.
- NIP PR #2238 (mentioned in a Damus post as live A/V direction) was not inspected.

---

## A3. Group E2EE: is MLS (Marmot / NIP-EE) worth adopting over NIP-44 room key + NIP-59 gift wraps?

### Takeaway
Marmot (MLS over Nostr, successor to NIP-EE) is real, audited in 2026 and shipping in White Noise, but its reference stack is Rust (MDK); the browser/TypeScript path exists (marmot-ts) with maturity I could not verify. For ≤50-member rooms Beamhop's shared-key-with-rotation scheme is simpler; MLS mainly buys forward secrecy/post-compromise security and cheaper rekeys.

### Cited Findings
- NIP-EE (Aug 2024) was the first MLS-over-Nostr attempt; Marmot is its successor and broadens scope (media, group management) via its own specs (MIPs). — [Least Authority Marmot protocol review summary](https://leastauthority.com/white-noise-marmot-protocol-review-summary-report/)
- Least Authority audited the Marmot Development Kit (MDK, Rust), covering MIPs 0–5, with a final report in March 2026; one finding concerned missing validation of the mandatory relays tag in MLS KeyPackage events. A whitenoise-rs audit report followed (April 1, 2026 per search summary). — [Least Authority MDK final audit report (PDF)](https://leastauthority.com/wp-content/uploads/2026/03/Least-Authority-White-Noise-MDK-Final-Audit-Report.pdf); [Least Authority MDK audit page](https://leastauthority.com/blog/audit-of-white-noise-marmot-development-kit-mdk/)
- White Noise shipped v0.3.0 in Feb 2026 (160+ merged improvements). — [Nostr Compass #11 (secondary)](https://buttondown.com/nostrcompass/archive/nostr-compass-11/)
- A TypeScript implementation, marmot-ts, has published reference docs. — [marmot-ts reference](https://marmot-protocol.github.io/marmot-ts/reference/index.html) (maturity/audit status not verified)
- XMTP is a comparable production deployment of MLS for human+agent groups: groups up to 400 members, OpenMLS underneath, agents built with a Node-based Agent SDK; NCC Group assessed LibXMTP's MLS use (Dec 2024). — [XMTP agents intro](https://docs.xmtp.org/agents/get-started/intro); [XMTP docs index](https://docs.xmtp.org/llms/llms-full.txt)

### Inferences
- With members' agents as separate keys, a 50-seat room rekeyed by gift-wrapping to each member costs O(n) events per rotation; MLS makes this O(log n) and adds PCS, but requires KeyPackage publication, commit ordering over unordered relays, and a WASM or TS MLS library. That is a large migration for marginal benefit at Beamhop's room sizes; a shared workspace CRDT does not change this calculus because it can reuse the room key.
- If MLS is adopted later, deriving workspace/CRDT encryption keys from the MLS exporter secret is the obvious integration point — and the exporter/extractor key was specifically flagged for attention in the Least Authority protocol review, so it would need care.

### Gaps
- Whether NIP-EE is formally deprecated in the nips repo, and whether MIPs are considered final, was not confirmed.
- No source found on Marmot interop with AI agents or on marmot-ts browser bundle size/performance.

---

## A4. Terminal / VM sharing prior art and "host migration"

### Takeaway
The closest prior art for an E2EE shared terminal relayed by an untrusted server is sshx (ciphertext-only relay, key in the link); the closest for "multiplayer agent thread + worktree" is Zed Delta, which solves host availability with a cloud runner rather than peer migration. I found no prior art for snapshot-and-resume of a browser sandbox between peers.

### Cited Findings
- sshx: web-based collaborative terminal shared by link, end-to-end encrypted (Argon2 + AES), infinite canvas of multiple terminals, live cursors, Mosh-style predictive local echo; "the server never sees what you're typing". — [sshx GitHub](https://github.com/ekzhang/sshx/); [sshx.io](https://sshx.io/)
- A third-party write-up says the sshx server only relays ciphertext, with the key derived from the session link and AES-256-GCM transport, and contrasts this with tmate where the server side holds shell access. — [x-cmd sshx page (secondary, single source)](https://www.x-cmd.com/install/sshx/)
- termpair is another E2EE browser terminal-sharing tool ("view and control remote terminals from your browser with end-to-end encryption"). — [termpair on PyPI](https://pypi.org/project/termpair/0.3.1.3)
- Zed Delta: shared agent threads built on CRDTs that teammates and agents can join by link; work can be moved to a cloud runner so the agent keeps going while the laptop is closed, with conversation and code kept in sync. — [Zed: Introducing Delta](https://zed.dev/blog/introducing-delta); CRDT detail from [AlphaSignal (secondary)](https://alphasignal.ai/news/zed-launches-delta-to-replace-git-where-ai-agents-write-code)
- tldraw sync: single authoritative room instance, ~50 collaborators. — [tldraw sync docs](https://tldraw.dev/docs/sync)
- Cursor's local↔cloud handoff is advertised, but users report it is one-way for cloud-origin sessions (no move-to-local), with a staff reply that cloud-to-local was not being actively built at that time; workaround is to have the agent push a branch. — [Cursor forum thread](https://forum.cursor.com/t/cloud-origin-agents-have-no-move-to-machine-option-in-agents-window-glass-cant-hand-off-to-local/162470); [Cursor forum: move from cloud agent to local](https://forum.cursor.com/t/can-we-move-from-cloud-agent-to-local/165263.md)

### Inferences
- sshx's model transfers directly: the hosting tab is the "sshx client", Nostr relays (or a WebRTC channel) are the untrusted relay, the room key replaces the link-embedded key. Terminal sharing is then a stream of encrypted PTY output chunks plus input events with per-member write permission; predictive echo matters if the transport is Nostr (hundreds of ms latency).
- Streaming a VM *display* as WebRTC video is unnecessary for a terminal/file sandbox; byte streams and CRDT file sync are far cheaper. Video would only matter for a GUI sandbox.
- Host migration design that follows from Beamhop's existing parts: periodically snapshot the sandbox filesystem (OPFS/virtual FS) → AES-GCM under the room key → Blossom blob → publish a signed "checkpoint" event (hash, size, host, sequence). On host loss, another member (or the same owner's other device) claims the host role via a room-state event with a fencing counter, downloads the snapshot and restarts. Process state (running Pyodide/JS, open sockets) is lost; only the filesystem and the agent transcript (already in room history) survive, so agents must treat tools as restartable. Cursor's experience suggests even vendors with servers find bidirectional handoff hard; "push a branch / publish a snapshot" is the robust lowest common denominator.
- Two classes of migration differ in trust: owner's-own-device migration (same keys, same credentials via NIP-78 sync, no new trust) versus another member resuming the workspace (they get files but must not get the original owner's provider credentials or agent identity — the workspace migrates, the agent does not).

### Gaps
- Not researched: tmate and Upterm architecture (only one secondary comparison), VS Code Live Share, Replit multiplayer, multiplayer WebContainers/StackBlitz, Figma cursor architecture. No source found for snapshotting WebContainer/Pyodide/WASM-VM state across browsers, or for Blossom blob size limits/retention that would bound snapshot size.

---

## A5. Multi-agent coordination in group chats: routing, loops, cost, permissions, and injection risk

### Takeaway
Shipping products split into two models — one shared org-owned agent per channel (Claude Tag) versus each person's own agent that only they can drive (Copilot/Claude Remote Control, Claude Code channels' sender allowlist). Beamhop's "everyone brings their own agent, others may instruct it" is the riskier third model, and the published security guidance (lethal trifecta, Rule of Two, CaMeL, Anthropic's own channel docs) all point to gating on **sender identity** and separating untrusted content from tool-triggering authority.

### Cited Findings
- Claude Tag (replaced Claude in Slack on Aug 3, 2026; legacy bot retired Oct 5, 2026): "@Claude is multiplayer" — one Claude per channel that interacts with everyone; channel work is attributed to the **organization's** Claude identity, while DM work runs on the individual's account; permissions and memory inherit org → workspace → channel; admins can restrict invocation to org members; Claude is disabled by default in channels containing a Slack guest. — [Anthropic: Introducing Claude Tag](https://www.anthropic.com/news/introducing-claude-tag); [What is Claude Tag](https://support.claude.com/en/articles/15594475-what-is-claude-tag); [Claude Tag admin: restrict access](https://claude.com/docs/claude-tag/admins/restrict-access)
- In Claude Tag group DMs, Claude reads top-level messages even without a mention unless asked to reply only when mentioned. — [Claude Tag group DMs](https://claude.com/docs/claude-tag/users/group-dms)
- Claude Code channels docs: "An ungated channel is a prompt injection vector"; gate on the **sender's** identity, not the room's — gating on the room "would let anyone in an allowlisted group inject messages into the session"; non-allowlisted senders are dropped silently. — [Claude Code channels reference](https://code.claude.com/docs/en/channels-reference)
- Claude Code permission relay: tool-approval prompts (Bash/Write/Edit) can be relayed to a chat channel with a 5-letter request ID; the remote reply `yes <id>`/`no <id>` is intercepted by the channel server and never reaches the model; first answer (local or remote) wins; the capability should only be declared if the channel authenticates the sender, "because anyone who can reply through your channel can approve or deny tool use in your session". Previews are sanitized (invisible/direction-override characters neutralized, 3,500 code-point limit with the end of long commands preserved, credential masking from v2.1.234). — [Claude Code channels reference](https://code.claude.com/docs/en/channels-reference)
- GitHub Copilot CLI remote control: only the account that started the CLI session can view or steer it. — [GitHub docs: about remote control](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-remote-control)
- Lethal trifecta (Willison, June 2025): private data + exposure to untrusted content + ability to communicate externally; the only reliable defence is to avoid the combination. — [Simon Willison: The lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)
- Meta's "Agents Rule of Two" (Oct 2025): an agent session should have at most two of {untrusted input, sensitive data/systems, state change or external communication}; Willison called it the best practical advice available but later noted untrusted input + state change is not actually safe. — [Simon Willison: new prompt injection papers](https://simonwillison.net/2025/Nov/2/new-prompt-injection-papers/)
- CaMeL (Google DeepMind): a privileged LLM plans from the trusted user query; a quarantined LLM with no tools processes untrusted data; a custom interpreter attaches capability tags (provenance, allowed readers) to every value and evaluates policies at tool-call time. Solves 67% of AgentDojo tasks with provable security in the original abstract (a later version reports 77% vs 84% undefended; version provenance not confirmed). — [arXiv 2503.18813](https://arxiv.org/abs/2503.18813); [Simon Willison on CaMeL](https://simonwillison.net/2025/Apr/11/camel/)
- A2A reached v1.0 in March 2026 under Linux Foundation governance, with a TSC spanning AWS, Cisco, Google, IBM Research, Microsoft, Salesforce, SAP, ServiceNow and 150+ supporting organizations. — [Google Open Source Blog, April 2026](https://opensource.googleblog.com/2026/04/a-year-of-open-collaboration-celebrating-the-anniversary-of-a2a.html); [Linux Foundation press release](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year)
- ContextVM carries MCP JSON-RPC over Nostr using ephemeral kind 25910 events, so MCP servers are addressed by pubkey with no public HTTP endpoint. — [contextvm-sdk on docs.rs](https://docs.rs/crate/contextvm-sdk/0.1.0)
- NIP-90 (Data Vending Machines) is reported as flagged "unrecommended" in the upstream nips repo, with maintainers favouring use-case-specific specs; kinds 5000–7000 still see use. — [D-Central guide (secondary; not verified against the nips repo)](https://d-central.tech/nostr-data-vending-machines/)
- XMTP positions MLS group chats as the substrate for confidential multi-agent + human conversations. — [XMTP agents intro](https://docs.xmtp.org/agents/get-started/intro)

### Inferences
- Beamhop already has the right primitives (who-can-instruct, replies/hour cap, hop limit, `--allow-tools owner|everyone|none`). Mapping the published guidance onto them:
  - **Instruction authority = signed sender, not room membership.** Every Nostr event is signed, so the agent runtime can tag each context item with its author pubkey — stronger provenance than Slack/Telegram bridges have. Treat messages from non-authorized members (and all other agents' output, fetched web pages, shared files) as *data* that may be read but may not trigger tools.
  - **Rule of Two per turn:** when a turn is triggered by someone other than the owner, drop either private data (owner's DMs, other rooms, local files, synced credentials) or state-changing/external tools. A browser sandbox with web fetch + room history + a non-owner trigger already holds all three legs if the room history is considered private.
  - **Confused deputy:** another member's message causing *my* agent to spend *my* tokens and use *my* tool grants is the core hazard. The Claude Code relay pattern is directly reusable: surface an approval card to the owner (on any of their devices) with a sanitized preview; approval messages are consumed by the runtime and never shown to the model; approver identity is checked by signature.
  - **Cost attribution:** in the bring-your-own-agent model the payer is always the agent's owner (their key/subscription in their tab); Claude Tag instead bills the org identity. Beamhop's replies/hour cap is therefore a spend limit; per-requester quotas and visible "X asked, Y's agent paid N tokens" accounting are natural extensions.
  - **Loop prevention:** hop limit + mention-only triggering + a rule that agent-authored messages never count as instructions covers the common ping-pong case; a room-level circuit breaker (N agent messages without a human message) is cheap because all events are visible to all clients.
- Capability-based delegation (UCAN-style or Keyhive's convergent capabilities) would let an owner hand a narrowly-scoped, expiring grant ("Bob may ask my agent to run code in workspace W until Friday") as a signed Nostr event; the agent runtime verifies the chain locally with no server. This is design reasoning; I did not research UCAN's 2026 status.
- A2A is HTTP/enterprise-shaped (agent cards at URLs); it is a poor fit for tab-hosted agents with no endpoint, whereas ContextVM-style "MCP over Nostr" matches Beamhop's transport and could expose a room's sandbox as tools to other members' agents.

### Gaps
- Not researched: AGNTCY/SLIM (only confirmed that AGNTCY is a Cisco-originated Linux Foundation project), TENEX, Goose+Nostr, proposed Nostr "agent" NIPs, Matrix agent conventions, Discord bot patterns, UCAN status. No source found that addresses prompt-injection threat models specifically for multi-owner, multi-agent group chats.
- How Claude Tag resolves differing per-user access within one thread is not documented in what I read (inference: channel identity governs).

---

## A6. Agent availability when the hosting tab closes

### Takeaway
Nothing in the web platform keeps a page-scoped agent loop alive after the tab closes; every vendor that offers "keeps working while you're away" does it with either a local long-running process plus a vendor relay, or a cloud runner. For Beamhop the honest options are: queue-and-resume (current behaviour), owner's other device takes over, or an optional always-on node (the existing bridge) run by the owner or a trusted member.

### Cited Findings
- Claude Code Remote Control: the local `claude` process must keep running and the machine must stay awake; closing the terminal ends the session; server-mode sessions can be resumed for about four hours after the server stops. — [Claude Code Remote Control docs](https://code.claude.com/docs/en/remote-control)
- Claude Code channels: events queue into the session and are processed in order; notifications are not acknowledged, and if the session has not loaded the channel they are dropped silently. — [Claude Code channels reference](https://code.claude.com/docs/en/channels-reference)
- Zed Delta moves work to a cloud runner so the agent continues with the laptop closed. — [Zed: Introducing Delta](https://zed.dev/blog/introducing-delta)
- OpenAI Codex (May 14, 2026 preview): a relay connects the ChatGPT mobile app to machines running Codex (laptop, Mac mini, managed remote environment); files and credentials stay on the host. — [OpenAI: Work with Codex from anywhere](https://openai.com/index/work-with-codex-from-anywhere/)
- Chrome *extension* service workers are terminated after 30 s of inactivity; since Chrome 116 an active WebSocket's messages reset the idle timer. — [Chrome extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle); [Chrome: longer extension service worker lifetimes](https://developer.chrome.com/blog/longer-esw-lifetimes)
- Trystero supports headless Node/Bun/Deno peers, including passive peers that keep room state available. — [Trystero README](https://github.com/dmotz/trystero)

### Inferences
- The Companion extension is the only browser-side lever for outliving a tab: an extension service worker holding a relay WebSocket can stay alive while messages flow (PLAN.md already lists "run the libfx agent loop inside the extension background worker" as a fallback). It still dies with the browser, and it is an install.
- "Member-run always-on node" = the existing `npx` bridge in a headless mode holding (a) the agent identity for an owner, or (b) only a workspace replica + snapshotter with no model credentials. (b) is much lower trust and already solves host migration and late-joiner sync; it is the same role as a Trystero passive peer or a self-hosted Jazz/automerge sync node.
- Because Nostr relays store events, queue-and-resume loses nothing but latency; the UX work is presence (who hosts, last checkpoint age) and making missed mentions expire sensibly.

### Gaps
- No sources gathered on web (non-extension) service worker lifetime, background-tab timer/WebSocket throttling, Web Locks / audio keep-alive tricks, Background Sync/Periodic Sync, or Web Push without a push server. These need a dedicated check before making claims.

---

## B1. Can the public HTTPS page talk to a localhost server? (browser rules, late 2026)

### Takeaway
In Chrome and Firefox it now works only behind a user permission prompt (Chrome 142+ for fetch, Chrome 147 for WebSocket/WebTransport; Firefox 151+ rollout), and Safari has a long record of blocking `http://localhost` / `ws://localhost` from HTTPS pages as mixed content. A localhost bridge is therefore viable on Chromium/Firefox with one prompt, and unreliable on Safari/iOS.

### Cited Findings
- Chrome Local Network Access (LNA) replaces Private Network Access: requests from public pages to local-network or loopback addresses require a user permission; opt-in flag in Chrome 138; the **prompt launched in Chrome 142** (blog update dated 2025-09-29). The permission can only be requested from secure contexts. — [Chrome blog: Local Network Access](https://developer.chrome.com/blog/local-network-access)
- Loopback (127.0.0.0/8, ::1) and local ranges (RFC1918, link-local, ULA) are both covered; from Chrome 145 the permission is split into `local-network` and `loopback-network`. — [Chrome blog](https://developer.chrome.com/blog/local-network-access); [Chrome LNA guide](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access)
- Mixed-content exemption applies when Chrome knows the target is local before resolving: private IP literals, `.local` names, or `fetch(..., { targetAddressSpace: "local" })`. — [Chrome blog](https://developer.chrome.com/blog/local-network-access)
- **Chrome 147** extends LNA to **WebSockets** (connections to local addresses now trigger the prompt; LNA enterprise policies apply) and to **WebTransport**. — [Chrome 147 beta notes](https://developer.chrome.com/blog/chrome-147-beta); [Chrome 147 release notes](https://developer.chrome.com/release-notes/147); [blink-dev Intent to Ship: LNA for WebSockets](https://groups.google.com/a/chromium.org/g/blink-dev/c/O6GMKt44Ups)
- Service/Shared Workers can only make local requests if the origin already holds the permission; the prompt must be triggered from a page first. Chrome advises not firing local requests on page load and showing remediation UI on denial. — [Chrome blog](https://developer.chrome.com/blog/local-network-access); [Chrome LNA guide](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access)
- Pages served from `http://localhost` do not trigger LNA checks by default. — [Chrome LNA guide](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access)
- Firefox: local network access restrictions roll out gradually to all users starting with **Firefox 151** (previously only ETP Strict); public sites must be explicitly allowed to reach local-network resources or apps on the device. Prefs include `network.lna.enabled`, `network.lna.blocking`, `network.lna.skip-domains`. — [Mozilla support article](https://support.mozilla.org/en-US/kb/control-personal-device-local-network-permissions-firefox); [Malwarebytes on Firefox 151, May 2026 (secondary)](https://www.malwarebytes.com/blog/privacy/2026/05/firefox-151-packs-big-privacy-upgrades-into-a-small-update)
- Safari/WebKit: long-standing bugs report that HTTPS pages are refused access to `http://` and `ws://` localhost as mixed content (2017), and that Safari 18 beta blocked loading localhost content from HTTPS sites (2024). An Oct 2025 OpenStreetMap issue reports its localhost "Remote Control" button fails in Safari and that `window.open()` was the only workaround. — [WebKit bug 173161](https://bugs.webkit.org/show_bug.cgi?id=173161); [WebKit bug 171934](https://bugs.webkit.org/show_bug.cgi?id=171934); [WebKit bug 279249](https://bugs.webkit.org/show_bug.cgi?id=279249); [OSM issue #6426](https://lists.openstreetmap.org/pipermail/rails-dev/2025-October/044273.html)
- Local servers still need CORS for a GitHub Pages origin. Ollama rejects browser origins by default (403) and is opened with `OLLAMA_ORIGINS`; `*` lets any visited site use the local API. — [Ollama CORS guide (secondary)](https://objectgraph.com/blog/ollama-cors/); [ONLYOFFICE Ollama CORS guide](https://api.onlyoffice.com/docs/ai/guides/configuring-ollama-with-cors/)

### Inferences
- For Beamhop (HTTPS on github.io → secure context) a `ws://127.0.0.1:<port>` bridge costs one "apps on this device" prompt in current Chrome/Edge/Brave and Firefox, must be initiated from a user gesture in the page (not the service worker), and should be considered unavailable in Safari and on iOS. That makes it a progressive enhancement, not the primary bridge.
- The origin is shared with every other `beamhop.github.io/*` project path (same origin for permissions and CORS allow-lists). A local server that allow-lists `https://beamhop.github.io` trusts all pages on that host; pairing must therefore be authenticated at the application layer (the existing agent link / Nostr key handshake) rather than by Origin alone. A custom domain would tighten this.
- Loopback does not need TLS in Chrome/Firefox, so no local certificate dance; but any local HTTP server reachable from a browser must defend against other sites and DNS rebinding (check Origin + Host, require a pairing secret).
- Compared to the current Nostr transport, localhost buys latency and large-payload throughput (streaming tool output, file sync) but not reach (other room members still need Nostr/WebRTC), so the simplest architecture keeps Nostr as the only bridge transport and uses localhost/WebRTC purely as an optional fast path between an owner's tab and their own bridge.

### Gaps
- Current Safari 26/iOS behaviour for `http://127.0.0.1` fetch and `ws://localhost` from HTTPS pages was not confirmed by a 2026 source; the WebKit bug outcomes were not checked. Treat Safari as "assume blocked, test".
- Whether LNA enforcement requires CORS preflight behaviour beyond normal CORS (as PNA did) is not stated in the pages read.
- Exact Firefox version at which the restriction became default for all users was not pinned (support article says rollout begins with 151; an LWN thread from July 2026 quotes it as default for all).
- LM Studio CORS toggle: only one thin secondary mention found.

---

## B2. Which local agents already expose a local server a page could attach to?

### Takeaway
opencode and Codex both ship local servers (HTTP/OpenAPI and experimental WebSocket respectively), but neither allow-lists arbitrary web origins by default; ACP's remote transport is still a draft. Attaching directly from the page is possible for opencode with one `--cors` flag; everything else still wants a small adapter — which is what the Beamhop bridge already is.

### Cited Findings
- `opencode serve` runs a headless HTTP server exposing an OpenAPI endpoint (clients attach e.g. at `http://localhost:4096`); `--cors` adds allowed browser origins (repeatable); default allowed origins are localhost/127.0.0.1 on any port, `tauri://localhost` and `https://*.opencode.ai`; `OPENCODE_SERVER_PASSWORD` enables HTTP basic auth. Docs are split between V1 and V2 and do not fully agree. — [opencode server docs](https://opencode.ai/en/docs/server); [opencode web docs](https://opencode.ai/docs/cli/web)
- `codex app-server` defaults to stdio; `--listen ws://127.0.0.1:4500` enables a WebSocket transport that OpenAI labels experimental and unsupported for production; `wss://` is expected for remote hosts; a Unix-socket listen mode also exists. — [OpenAI Codex app-server docs](https://developers.openai.com/codex/app-server)
- ACP: stdio remains the standard transport; a "Streamable HTTP & WebSocket Transport" RFD entered **Draft** on April 22, 2026 and a Transports Working Group was formed; clients supporting remote ACP must support both Streamable HTTP and WebSocket, HTTP/2 is required for the HTTP mode. An ACP v2 draft was published July 20, 2026. — [ACP RFD: Streamable HTTP & WebSocket transport](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport); [ACP Transports Working Group announcement](https://agentclientprotocol.com/announcements/transports-working-group.md); [ACP updates](https://agentclientprotocol.com/updates.md)
- Gemini CLI's documented A2A feature is client-side (connect to remote subagents). A third-party project states Gemini CLI ships an A2A server package (`@google/gemini-cli-a2a-server`) exposing models over HTTP — unverified against Google's docs. — [Gemini CLI remote subagents docs](https://geminicli.com/docs/core/remote-agents/); [pi-gemini-cli-provider README (third-party)](https://cdn.jsdelivr.net/gh/skdev-ai/pi-gemini-cli-provider@main/README.md)
- Ollama serves on `localhost:11434` and needs `OLLAMA_ORIGINS` for browser access. — [Ollama CORS guide (secondary)](https://objectgraph.com/blog/ollama-cors/)
- Claude Code does not open inbound ports for Remote Control (outbound HTTPS only). Channel servers are stdio subprocesses that *may* listen on a local port themselves (the docs' webhook example binds `127.0.0.1:8788`). — [Claude Code Remote Control docs](https://code.claude.com/docs/en/remote-control); [Claude Code channels reference](https://code.claude.com/docs/en/channels-reference)

### Inferences
- A page-direct opencode attach is a real zero-Beamhop-binary path: user runs `opencode serve --cors https://beamhop.github.io`, accepts the LNA prompt, and the tab drives sessions over HTTP. It only helps opencode users on Chromium/Firefox and makes the tab the relay for the room (agent offline when the tab closes).
- Codex's WebSocket listener has no documented Origin allow-list in what I read; exposing it to a browser page should be assumed unsafe without checking how it authenticates.
- The ACP remote-transport draft suggests that within a year "agent --acp over ws://localhost" may be common; a browser ACP client would then replace per-agent adapters in the bridge. Not usable today.

### Gaps
- Goose server (`goosed`) API, LM Studio server CORS specifics, and whether Codex app-server WebSocket checks Origin were not found. Whether Gemini CLI officially ships an A2A server is unconfirmed.

---

## B3. Vendor-hosted remote-control relays — any third-party-accessible API?

### Takeaway
Claude Code, Copilot CLI and Codex all now offer first-party remote control through their own relay and their own clients, bound to the user's vendor account; none of the sources show an API that a third-party web page like Beamhop could attach to. These are competitors for the "reach my desktop agent from a browser" job, not building blocks.

### Cited Findings
- Claude Code Remote Control connects claude.ai/code and the Claude mobile apps to a local session; the local process registers with the Anthropic API and polls for work; all traffic goes through the Anthropic API over TLS with multiple short-lived, single-purpose credentials; outbound HTTPS only. Requires claude.ai subscription auth (Pro, Max, Ultra, Team, Enterprise) — **API keys are not supported**; Team/Enterprise owners must enable it. Started with `claude remote-control` (server mode, default capacity 32 sessions, `--spawn` modes) or `claude --remote-control` / `/remote-control`. Optional Trusted Devices enrollment restricts which devices may connect. — [Claude Code Remote Control docs](https://code.claude.com/docs/en/remote-control)
- GitHub Copilot CLI remote control: public preview April 13, 2026, GA May 18, 2026 on GitHub Mobile, github.com and VS Code; enabled with `copilot --remote` or `/remote on`; only the signed-in account that started the session can view or interact. — [GitHub changelog, GA](https://github.blog/changelog/2026-05-18-remote-control-for-copilot-cli-sessions-now-generally-available-on-mobile-web-and-vs-code/); [GitHub docs: about remote control](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-remote-control)
- OpenAI Codex: preview in the ChatGPT mobile app (May 14, 2026) with a relay to machines running Codex; terminal output, diffs and approval requests stream to the phone; rolling out to all plans including Free and Go. — [OpenAI: Work with Codex from anywhere](https://openai.com/index/work-with-codex-from-anywhere/)
- Cursor: local↔cloud handoff advertised (Cursor 3.4 / Glass) with reported gaps; iOS remote control requires a team admin to enable Remote Control under Cloud Agents > Self-Hosted (forum-sourced). — [Cursor forum](https://forum.cursor.com/t/cloud-origin-agents-have-no-move-to-machine-option-in-agents-window-glass-cant-hand-off-to-local/162470)

### Inferences
- All three bind the relay to the vendor identity and first-party clients, which is exactly the property that makes them safe; it also means Beamhop cannot ride them. The extensibility point vendors *do* offer is on the local side (MCP servers, Claude Code channels/plugins, ACP), so Beamhop's integration surface is "be an MCP server / channel inside the user's session", covered in B5.
- Sharing a vendor remote-control link into a Beamhop room is not a collaboration feature: Copilot restricts to the owner account and Claude's is tied to the owner's claude.ai login.

### Gaps
- Factory and Amp web handoff were not researched. No documentation of a public/partner API for any of these relays was found; absence of evidence, not a confirmed "no".

---

## B4. Zero-install-ish launchers and "no local process at all" options

### Takeaway
The only true zero-install bridge to local files is the File System Access API, and it is Chromium-only. Anything that runs a local *agent* needs a process; the lightest launch remains a one-line `npx`/`uvx`, and public tunnels are a weak fit (Cloudflare quick tunnels need no account but do not support SSE and require installing `cloudflared`).

### Cited Findings
- `showDirectoryPicker` is supported in Chrome and Edge since v86, unsupported in Firefox and Safari (both vendors hold negative positions); the feature is marked limited availability and "very unlikely to ever become Baseline in this current form". Safari 26 added the File System WritableStream API but not the pickers. — [caniuse: showDirectoryPicker](https://caniuse.com/mdn-api_window_showdirectorypicker); [web-features explorer: File System Access](https://web-platform-dx.github.io/web-features-explorer/features/file-system-access); [WebKit bug 231706](https://bugs.webkit.org/show_bug.cgi?id=231706)
- Cloudflare Quick Tunnels (`trycloudflare.com`): no account or domain needed; URL changes each run and exists only while `cloudflared` runs; no SLA; **no Server-Sent Events support**; 200 in-flight request cap (429 beyond); not available if a `config.yaml` exists in `.cloudflared`. An Oct 2, 2026 changelog adds a way to restrict who can access a quick tunnel (previously anyone with the URL could). — [Cloudflare Quick Tunnels docs](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/); [Cloudflare changelog 2026-10-02: protected quick tunnels](https://developers.cloudflare.com/changelog/post/2026-10-02-protected-quick-tunnels/)
- Beamhop's current launcher is `npx -y github:beamhop/app#dist "<agent link>" --agent …` (Node 22.4+), nothing published to npm, keys in `~/.beamhop`. — /home/user/app/README.md (project file)
- ContextVM's gateway CLI (expose a local MCP server on Nostr) installs via curl or Deno and takes a private key, relay URL and server command. — [ContextVM gateway-cli](https://github.com/ContextVM/gateway-cli)
- Iroh's native bindings (NAPI) support direct connections and hole punching in Node, while browser nodes are relay-only. — [iroh WASM/browser docs](https://docs.iroh.computer/deployment/wasm-browser-support)

### Inferences
- **File System Access as the "bridge"** fits the new browser-first goal best: the in-tab agent mounts a user-picked local folder into the sandbox (read/write), no local process, no LNA prompt. Limits: Chromium desktop only; no process execution on the host (code still runs in the WASM sandbox, so no native toolchains, git hooks, or local servers); the folder is only reachable while that tab is open; other members see the files only via the workspace sync layer. For Firefox/Safari the fallbacks are drag-and-drop/`<input webkitdirectory>` import (read-only copy-in) plus OPFS and explicit export.
- Sharing a mounted local folder into a multi-member room is a privilege escalation worth a distinct consent: once mounted into a shared workspace, any member authorized to instruct the agent can read/modify those files. Default should be "mounted folders are owner-only unless explicitly shared".
- Tunnels invert the trust model (a public URL to a local agent) and add an install; they only make sense for the MCP reverse path (B5) and even there the SSE limitation of quick tunnels conflicts with streaming HTTP transports.
- Custom URL protocol handlers, WebUSB/WebSerial and PWA file handlers do not start or reach a local agent without something already installed; they are not shortcuts around the install.
- Ranking for Beamhop by install cost: (0) FSA folder mount / drag-drop; (1) config-only MCP entry that itself runs `npx` (already in README); (2) one-line `npx`/`uvx` bridge over Nostr (current); (3) localhost attach to an agent server the user already runs (opencode); (4) extension; (5) tunnels.

### Gaps
- Not researched: persistence of directory handles/permissions across sessions in Chrome, Tailscale Funnel, ngrok free-tier behaviour, dumbpipe, piping-server, `bunx`/`uvx` specifics, custom protocol handler behaviour, WebUSB/WebSerial relevance. The inferences above about those are reasoning only.

---

## B5. MCP-based reverse path: the desktop agent connects to Beamhop

### Takeaway
"Add Beamhop as an MCP server" is already the lowest-friction desktop integration, and Claude Code channels are the documented mechanism for pushing room messages into a running session — but channels are stdio-only, research preview, and custom channels are not on the approved allowlist, so users must launch with `--dangerously-load-development-channels`. A config-only *remote* MCP URL is impossible without a host; MCP-over-Nostr (ContextVM) is the serverless-compatible way to give the endpoint an address.

### Cited Findings
- Beamhop already ships `claude mcp add beamhop -- npx -y github:beamhop/app#dist mcp "<agent link>"` (MCP stdio server giving tools to read and post in the room). — /home/user/app/README.md (project file)
- Claude Code channels: a channel is an MCP server that "runs on the same machine as Claude Code", spawned as a subprocess over **stdio**; it declares `capabilities.experimental['claude/channel']` and emits `notifications/claude/channel` with `content` and `meta` (rendered to the model as a `<channel source=… …>` tag); two-way channels add a normal MCP reply tool; `instructions` tell the model how to respond. — [Claude Code channels reference](https://code.claude.com/docs/en/channels-reference)
- Channels are in research preview; Telegram, Discord, iMessage and fakechat are the included channels; every channel must be on the approved allowlist (the channel plugins in `claude-plugins-official`); a custom or own-marketplace channel needs `--dangerously-load-development-channels server:<name>` (interactive confirmation; ignored in `-p` and Agent SDK modes); Team/Enterprise admins must enable channels and can set their own `allowedChannelPlugins`. Listing in the official marketplace goes through an Anthropic partner contact. — [Claude Code channels reference](https://code.claude.com/docs/en/channels-reference); [Claude Code channels](https://code.claude.com/docs/en/channels)
- Delivery semantics: no acknowledgement; events are dropped silently if the session has not loaded the server as a channel; multiple events arriving while busy are delivered together next turn. — [Claude Code channels reference](https://code.claude.com/docs/en/channels-reference)
- Permission relay lets the channel forward tool-approval prompts and return `allow`/`deny` verdicts (see A5). — [Claude Code channels reference](https://code.claude.com/docs/en/channels-reference)
- The chat-platform channel pattern needs "no URL to expose": the local plugin polls the platform's API outbound. — [Claude Code channels reference](https://code.claude.com/docs/en/channels-reference)
- MCP spec 2026-07-28 makes the protocol stateless: the initialize handshake and `Mcp-Session-Id` are removed, each request carries its own version/capabilities, Streamable HTTP POSTs carry `Mcp-Method`/`Mcp-Name` routing headers, and legacy HTTP+SSE is on a deprecation path with a twelve-month compatibility window. — [MCP blog: 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/); [WorkOS summary (secondary)](https://workos.com/blog/mcp-stateless-spec-2026-07-28); [Cloudflare: the next generation of MCP](https://blog.cloudflare.com/mcp-v2/)
- ContextVM: MCP JSON-RPC over Nostr (ephemeral kind 25910). A **gateway** exposes a local MCP server on Nostr; a **proxy** runs client-side and presents a remote Nostr-addressed MCP server as a local one for clients without Nostr support; Rust SDK `contextvm-sdk` 0.1.1 (2026-05-08) and a TypeScript `@contextvm/sdk`; funded by OpenSats. Existing MCP clients/servers work unchanged because it operates at the transport layer. — [contextvm-sdk docs](https://docs.rs/crate/contextvm-sdk/0.1.1); [ContextVM gateway docs](https://docs.rs/crate/contextvm-sdk/0.1.0/source/docs/gateway.md); [ContextVM concepts](https://skills.sh/contextvm/cvmi/concepts); [OpenSats: ContextVM](https://opensats.org/projects/contextvm)
- Cloudflare quick tunnels do not support SSE. — [Cloudflare Quick Tunnels docs](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

### Inferences
- Who hosts the endpoint when Beamhop has no server — the options, in order of fidelity to the constraints:
  1. **Local stdio MCP process that speaks Nostr outbound (today's `mcp` mode).** Config-only for the user, but the config line downloads and runs Beamhop code via `npx`; "no Beamhop binary" is true only in the sense of no separate install step. This mirrors exactly how Anthropic's own Telegram/Discord channels work (local plugin, outbound polling, no URL).
  2. **Same process, upgraded to a Claude Code channel** so room mentions arrive as `<channel source="beamhop" sender=… room=…>` events and start a turn without the user typing. Blockers: research-preview status, allowlist (needs the dangerous dev flag, or an official-marketplace listing, or an org allowlist), Claude-Code-only. The permission-relay capability would let the owner approve tool calls from the Beamhop PWA on their phone — a close match for Beamhop's approval UX — and the docs' sender-gating advice maps to Beamhop's who-can-instruct policy enforced on signed pubkeys.
  3. **Tab-hosted MCP server addressed by pubkey over Nostr (ContextVM-style).** The browser tab cannot listen on a socket but can answer kind-25910 requests; the desktop side still needs the ContextVM proxy (a local process) because mainstream MCP clients do not speak Nostr. This does not remove the local process, but replaces a Beamhop-specific binary with a generic, third-party one and makes the sandbox/workspace tools callable by any member's agent, browser or desktop.
  4. **Tiny optional relay server (e.g. a Cloudflare Worker) exposing a Streamable HTTP MCP endpoint and bridging to Nostr.** This is the only way to get a pure "paste this URL into your MCP client" flow, including clients that only accept remote connectors. Costs: it is a Beamhop-operated (or self-deployed) server; to preserve E2EE the Worker must be a blind pipe, which is impossible for standard MCP because the client sends plaintext JSON-RPC over TLS to the endpoint — so the room key or a delegated agent key would have to live in the Worker or be supplied per request. The 2026-07-28 stateless spec makes such a Worker easier to build (no session affinity) but, per the sources read, I could not confirm how server-initiated pushes work in the stateless model, so "push room messages into a session via remote MCP" remains unverified.
- For non-Claude clients (Codex, Cursor, Gemini CLI) there is no documented equivalent of channels in what I read; MCP gives them pull-only tools (the model must decide to call `read_room`), so an agent that should respond to mentions unprompted still needs the ACP/`--cmd` bridge that drives the agent loop.
- Net: the MCP path is best positioned as "let my existing desktop session participate in the room" (owner-driven, pull-mostly), while the ACP bridge remains the path for an autonomous room agent. Channels would merge the two for Claude Code if/when custom channels leave the allowlist restriction.

### Gaps
- How MCP 2026-07-28 handles server-to-client notifications/subscriptions without sessions was not covered by the sources read.
- Did not verify current remote-MCP/custom-connector configuration flows for Claude Desktop, Codex or Cursor, or whether any of them accept a non-HTTP custom transport without a local shim.
- ContextVM maturity (0.1.x), relay rate limits for kind-25910 traffic, and whether its encryption mode is compatible with Beamhop's gift-wrap scheme were not evaluated.
- Whether Anthropic would list a third-party Nostr-backed channel plugin in `claude-plugins-official` is unknown.

---

## Cross-cutting: where a tiny optional server would unlock a lot

### Takeaway
Three small, optional, self-hostable components cover nearly every limitation found: TURN credential minting, an always-on headless peer, and a remote-MCP shim. Each can be offered as "bring/run your own" without changing the serverless default.

### Cited Findings
- TURN free tier requires an account (Cloudflare 1,000 GB/month free; Metered 20 GB/month with account). — [Cloudflare Realtime pricing](https://developers.cloudflare.com/realtime/pricing/); [Metered Open Relay](https://metered.ca/tools/openrelay/)
- Headless/passive peers are a supported pattern for keeping room state available (Trystero) and vendors solve agent availability with runners/relays (Zed Delta cloud runner, Claude Remote Control server mode, Codex relay). — [Trystero README](https://github.com/dmotz/trystero); [Zed: Introducing Delta](https://zed.dev/blog/introducing-delta); [Claude Code Remote Control docs](https://code.claude.com/docs/en/remote-control); [OpenAI: Work with Codex from anywhere](https://openai.com/index/work-with-codex-from-anywhere/)
- A pure URL-based MCP connector needs an HTTP endpoint; MCP's 2026-07-28 revision is stateless, which suits serverless functions. — [MCP blog: 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)

### Inferences
- (1) **TURN credential Worker**: removes the WebRTC failure tail; sees only DTLS ciphertext; cheapest to justify.
- (2) **Always-on peer** (the existing bridge in a "workspace replica / snapshotter" mode, optionally also hosting an agent): solves host migration, late-joiner sync and agent availability; member-run, so no Beamhop server; lowest trust if it holds only the room key and no provider credentials.
- (3) **Remote MCP shim**: unlocks URL-only connectors but cannot be E2EE-blind; best offered as self-deploy (user's own Worker) rather than Beamhop-hosted.
- None of these is required for the browser-first goal: Nostr-only sync + in-tab sandbox + FSA mount works with zero servers, at the cost of latency, Safari/Firefox folder access, and availability when tabs close.

### Gaps
- No cost/latency measurements were gathered for Nostr-relay-only CRDT/terminal sync at 50 members; public relay rate limits and ephemeral-event policies should be measured against Beamhop's default relay set before committing to Nostr as the sole real-time transport.
