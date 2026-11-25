# Using existing AI subscriptions from a pure static web app (no backend, no extension) — state as of 2026-11-25

Reading conventions used throughout:
- **Technically possible** = the HTTP/OAuth mechanics work from a browser tab.
- **Permitted** = allowed by the provider's terms as far as sources show.
- **Officially supported** = the provider documents and endorses this for third-party apps.
- "CORS probe" = an OPTIONS preflight I ran on 2026-11-25 with `Origin: https://example.github.io`, `Access-Control-Request-Method: POST`, `Access-Control-Request-Headers: authorization,content-type` (plus provider headers where noted). A preflight shows whether a browser would be allowed to send the request; it does not prove the authenticated request succeeds. The probes ran through an egress proxy; headers are as returned by the origin. Treat them as a single-day measurement and re-test from a real browser.

---

## 1. Summary matrix: per-provider subscription path from a browser tab

### Takeaway
No major provider offers, as of late November 2026, an officially supported flow in which a *hosted static web origin* obtains subscription-backed inference tokens. The closest is OpenAI's "Sign in with ChatGPT" (announced 2026-09-29), whose plan-usage flow is documented for open-source apps with a `127.0.0.1` loopback callback (i.e. a local process), and whose website flow is identity-only and partner-gated. The only paths that are simultaneously browser-feasible, permitted and officially supported are user-pays accounts that are not chat subscriptions (OpenRouter PKCE, Puter, Hugging Face OAuth) and pasted API keys / plan-issued API keys.

### Cited Findings

| Provider / plan | OAuth a 3rd-party public client can use for subscription inference | Browser (CORS) reachability | Terms / enforcement | Verdict for a static PWA |
|---|---|---|---|---|
| **Anthropic — Claude Pro/Max** | Claude Code OAuth exists but is not offered to third-party apps; Anthropic docs are quoted as not permitting third-party developers to offer Claude.ai login or route requests through Free/Pro/Max credentials — [WinBuzzer 2026-02-19](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/) | `api.anthropic.com/v1/messages` preflight: 200, `access-control-allow-origin: *`, accepts `anthropic-dangerous-direct-browser-access` — [CORS probe](https://api.anthropic.com/v1/messages). OAuth token endpoints `console.anthropic.com/v1/oauth/token` and `platform.claude.com/v1/oauth/token` preflight: HTTP 400, no `access-control-allow-origin` — [CORS probe](https://platform.claude.com/v1/oauth/token) | Prohibited for third-party OAuth login; server-side blocks since 2026-01-09 (see section 2) | API key: possible + supported. Subscription: not permitted, and token exchange is not browser-callable |
| **OpenAI — ChatGPT Go/Plus/Pro/Business** | Yes, official: "Sign in with ChatGPT" (SIWC). Open-source flow uses `client_id=dynamic_agent_client`, PKCE S256, no secret, loopback redirect `http://127.0.0.1:1455/auth/callback` ("Do not substitute `localhost`") — [OpenAI SIWC sign-in docs](https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md) | `api.openai.com/v1/responses` preflight: 200, `access-control-allow-origin: *` — [CORS probe](https://api.openai.com/v1/responses). `auth.openai.com/oauth/token` preflight: 200, `allow-origin: *` — [CORS probe](https://auth.openai.com/oauth/token). `chatgpt.com/backend-api/codex/responses` preflight: HTTP 400, no allow-origin — [CORS probe](https://chatgpt.com/backend-api/codex/responses) | Officially supported for open-source tools and selected commercial partners; private `chatgpt.com/backend-api` endpoints prohibited under SIWC — [yage.ai 2026-10-13](https://yage.ai/share/chatgpt-subscription-oauth-en-20261013.html) | Closest to viable, but the documented redirect is loopback-only; hosted-web redirect for plan usage is not documented |
| **Google — Gemini / Google AI Pro/Ultra** | Gemini CLI / Antigravity OAuth client is published in open source but reuse by third-party tools led to account suspensions (Feb 2026) — [The Register 2026-02-23](https://www.theregister.com/2026/02/23/google_antigravity_compute_burden/) | `generativelanguage.googleapis.com` (API-key Gemini API), `oauth2.googleapis.com/token` and `cloudcode-pa.googleapis.com` all return preflight 200 reflecting the origin — [CORS probe](https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent) | Enforced with 403 ToS suspensions affecting "Gemini CLI and any other service that uses the Cloud Code Private API" — [Google AI forum](https://discuss.ai.google.dev/t/explanation-regarding-the-suspension-of-my-account-after-using-my-google-cli-account-with-openclaw/129862) | Technically reachable from a browser; not permitted; highest account risk |
| **GitHub Copilot** | Device flow; officially supported for OpenCode via formal partnership (2026-01-16) — [GitHub changelog](https://github.blog/changelog/2026-01-16-github-copilot-now-supports-opencode/) | `api.githubcopilot.com/chat/completions` preflight: 200, `allow-origin: *` — [CORS probe](https://api.githubcopilot.com/chat/completions). `github.com/login/device/code`, `github.com/login/oauth/access_token`, `api.github.com/copilot_internal/v2/token` preflight: 405, no CORS headers — [CORS probe](https://github.com/login/device/code) | Supported for named partners; no general third-party-client programme found | Inference is browser-callable; the token-issuing steps are not, so a proxy is required for login |
| **xAI — SuperGrok / X Premium+** | Grok Build CLI supports subscription sign-in including `grok login --device-auth` — [Continuum guide](https://continuumcode.ai/guides/grok-cli/); community plugins reuse it — [pi-grok](https://github.com/stnly/pi-grok) | `api.x.ai/v1/chat/completions` preflight: 200, `allow-origin: *`, `allow-headers: *` — [CORS probe](https://api.x.ai/v1/chat/completions) | A user claim (not xAI text) says subscription terms prohibit using login credentials in a custom CLI — [grok-cli issue #205](https://github.com/superagent-ai/grok-cli/issues/205) | API key: browser-callable. Subscription: unofficial, terms unverified |
| **Mistral — Le Chat/Vibe Pro** | No third-party subscription OAuth found; Vibe is available on Pro/Team "with pay-as-you-go credits for power use, or bring your own API key" — [Mistral](https://mistral.ai/news/mistral-vibe-2-0/) | `api.mistral.ai/v1/chat/completions` preflight: 200, `allow-origin: *` — [CORS probe](https://api.mistral.ai/v1/chat/completions) | Subscription and API reported as billed separately — [CloudZero](https://www.cloudzero.com/blog/mistral-api-pricing/) | API key only |
| **Moonshot — Kimi Code membership** | No OAuth; membership issues an API key usable in third-party tools such as Claude Code, Roo Code, OpenCode — [Kimi Help Center](https://www.kimi.com/en-cn/help/kimi-code/membership-guide) | `api.moonshot.ai/v1/chat/completions` preflight: 204 reflecting origin — [CORS probe](https://api.moonshot.ai/v1/chat/completions). The membership route is separate from the Moonshot platform endpoint — [agenticos issue #3118](https://github.com/vstorm-co/agenticos/issues/3118); my guessed coding endpoint returned 404, so its CORS is untested | Tampering with the client identifier (User-Agent) is a violation that may suspend benefits — [Kimi Help Center](https://www.kimi.com/en-cn/help/kimi-code/membership-guide) | Plan API key pasted in browser: plausible, CORS of the plan endpoint unverified |
| **Z.ai — GLM Coding Plan** | No OAuth; plan API key | `api.z.ai/api/coding/paas/v4/chat/completions` preflight: 200 with no `access-control-*` headers — [CORS probe](https://api.z.ai/api/coding/paas/v4/chat/completions) | "Strictly limited to use within officially supported tools and products" — [Z.ai FAQ](https://docs.z.ai/devpack/faq) | Not permitted for a custom app, and likely CORS-blocked |
| **Alibaba — Qwen** | Qwen OAuth free tier discontinued 2026-04-15 — [Qwen Code auth docs](https://cdn.jsdelivr.net/npm/@qwen-code/qwen-code@0.17.0/bundled/qc-helper/docs/configuration/auth.md); [Decrypt](https://decrypt.co/364501/alibaba-shuts-down-free-tier-qwen-code) | `dashscope-intl.aliyuncs.com/compatible-mode/v1` preflight: 200 reflecting origin — [CORS probe](https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions) | Users directed to Alibaba Cloud Coding Plan, OpenRouter, Fireworks or BYOK — [Decrypt](https://decrypt.co/364501/alibaba-shuts-down-free-tier-qwen-code) | API key only |
| **OpenRouter** | Yes: PKCE with "no client registration, no backend, no secrets required" — [OpenRouter OAuth docs](https://openrouter.ai/docs/guides/overview/auth/oauth) | `/api/v1/chat/completions` and `/api/v1/auth/keys` preflight: 204, `allow-origin: *` — [CORS probe](https://openrouter.ai/api/v1/auth/keys) | Officially supported | Fully viable today (user-pays credits, not a chat subscription) |

Other inference endpoints probed (API-key paths): Hugging Face router 200 `*` — [probe](https://router.huggingface.co/v1/chat/completions); Poe API 204 `*` — [probe](https://api.poe.com/v1/chat/completions); Groq 204 `*` — [probe](https://api.groq.com/openai/v1/chat/completions); DeepSeek 200 reflecting origin — [probe](https://api.deepseek.com/chat/completions); GitHub Models 200 with no CORS headers — [probe](https://models.github.ai/inference/chat/completions); Vercel AI Gateway preflight 403 — [probe](https://ai-gateway.vercel.sh/v1/chat/completions).

### Inferences
- Three distinct blockers exist and they differ by provider: (a) terms (Anthropic, Google, Z.ai), (b) no CORS on the token-issuing step (Anthropic, GitHub device flow), (c) redirect URI restricted to loopback (OpenAI SIWC open-source flow). A stateless CORS proxy fixes only (b).
- GitHub Copilot is the one subscription where inference itself is browser-callable and where a third-party client has been officially blessed, so a tiny proxy for only the device-code and token-exchange calls would be technically sufficient. Whether GitHub permits clients other than its named partners is not established.
- The Anthropic Messages API accepting the browser header says nothing about subscription OAuth tokens; the January 2026 block rejects those tokens outside Claude Code regardless of transport.

### Gaps
- I did not test authenticated requests, only preflights. `auth.openai.com/oauth/token` was probed, but the SIWC docs name the token endpoint `auth.openai.com/api/accounts/oauth/token`, which I did not probe.
- GitHub Models and Z.ai returned 200 to OPTIONS without CORS headers; a browser would treat that as blocked, but this should be confirmed in a real browser.
- No primary xAI or Mistral terms text was retrieved on third-party use of subscription credentials.
- The Kimi Code membership endpoint's CORS behaviour is untested.

---

## 2. Terms and enforcement timeline (2026)

### Takeaway
Anthropic and Google tightened and enforced against third-party use of subscription OAuth in early 2026; OpenAI moved the other way and shipped an official programme in September 2026; GitHub partnered with one named client. Anthropic's position changed at least four times in 2026 and its current state is the least certain.

### Cited Findings

**Anthropic**
- 2026-01-09: enforcement began blocking Max OAuth access in third-party clients; third-party tools received an error that the credential is only for Claude Code — [MindStudio](https://www.mindstudio.ai/blog/anthropic-openclaw-ban-oauth-authentication); [WinBuzzer](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/)
- 2026-02-19: documentation update clarified that using OAuth tokens from consumer plans in third-party tools violates the terms, including in the Agent SDK; Anthropic does not permit third-party developers to offer Claude.ai login or route requests through Free/Pro/Max credentials on behalf of users — [WinBuzzer](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/); [AlternativeTo](https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use)
- 2026-04-04 (12 PM PT): subscriptions stopped covering third-party tool usage; users could enable pay-as-you-go "extra usage" or use an API key — [DEV Community](https://dev.to/mcrolly/anthropic-kills-claude-subscription-access-for-third-party-tools-like-openclaw-what-it-means-for-3ipc)
- 2026-05-13: Anthropic announced via @ClaudeDevs that subscribers could again power third-party agents such as OpenClaw and Conductor, authenticating via the Agent SDK, drawing from a separate monthly "Agent SDK" credit at API rates (Pro $20, Max 5x $100, Max 20x $200), effective June 15 — [VentureBeat 2026-05-13](https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch)
- 2026-06-15: the separate-credit change was reported paused; Agent SDK, `claude -p` and third-party app usage reported as still drawing from subscription limits, with Anthropic "reworking" the plan — [Digital Applied, updated 2026-06-16](https://www.digitalapplied.com/blog/anthropic-claude-credit-overhaul-june-15-2026) (third-party blog; Help Center text not reproduced)
- Sources conflict on whether April 2026 was a full block or a move to an "extra usage" billing pool — [Fazm](https://fazm.ai/blog/anthropic-subscription-auth-warning-third-party-extra-usage) versus [Medium](https://medium.com/@SyedAbbasT/anthropic-cuts-off-openclaw-and-third-party-tools-from-claude-subscriptions-a15cf1518fda)

**OpenAI**
- 2026-02-09: a Codex maintainer's informal GitHub Discussions reply was widely read as tacit consent to third-party reuse of the Codex OAuth client — [yage.ai](https://yage.ai/share/chatgpt-subscription-oauth-en-20261013.html)
- 2026-09-29: "Sign in with ChatGPT" announced at DevDay with 16 launch partners — [yage.ai](https://yage.ai/share/chatgpt-subscription-oauth-en-20261013.html); participating tools reported to include Devin, Amp, Warp and OpenClaw — [The New Stack](https://thenewstack.io/sign-in-with-chatgpt/) (page returned 403 to me; details from search summary)
- Plan usage in participating commercial apps requires Go, Plus, Pro or Business; "supported open-source tools are available to all ChatGPT users"; users set a per-app percentage cap of weekly usage; commercial partners apply via an interest form; the programme "launched with a limited set of partners" — [OpenAI Help Center](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)
- SIWC technical shape: scopes `offline_access resource.invoke chatgpt.tokens.use.direct`, resource `https://api.openai.com/v1`, inference via public `POST api.openai.com/v1/responses` with `store:false` and `stream:true`; access token 1 hour, refresh token 30-day sliding with rotation; preview limits include no `temperature`/`max_output_tokens`, no built-in tools, no server-side conversation state — [yage.ai](https://yage.ai/share/chatgpt-subscription-oauth-en-20261013.html)
- Website sign-in is identity-only (`openid profile email`), requires a requested client ID with exact-match registered redirect URIs, supports public clients with PKCE, assumes a backend for code exchange, and is "currently available to selected commercial partners" — [OpenAI SIWC website docs](https://developers.openai.com/siwc/website.md)

**Google**
- February 2026: Google suspended accounts that connected Antigravity / Gemini CLI OAuth to OpenClaw, citing load from third-party platforms — [VentureBeat](https://venturebeat.com/ai/google-clamps-down-on-antigravity-malicious-usage-cutting-off-openclaw-users); [The Register 2026-02-23](https://www.theregister.com/2026/02/23/google_antigravity_compute_burden/)
- Paid Ultra subscribers reported bans without warning — [Google AI forum](https://discuss.ai.google.dev/t/250-mo-ultra-subscriber-banned-without-warning-the-openclaw-mass-ban-wave-shows-a-systemic-failure-in-googles-developer-support/123015); later threads still report lockouts — [Google AI forum](https://discuss.ai.google.dev/t/account-suspended-403-tos-due-to-openclaw-usage-appeal-and-explanation/136321)

**GitHub**
- 2026-01-16: "GitHub Copilot now supports OpenCode" through a formal partnership, for Pro, Pro+, Business and Enterprise, using the GitHub device login flow — [GitHub changelog](https://github.blog/changelog/2026-01-16-github-copilot-now-supports-opencode/)

**Others**
- Alibaba ended free Qwen OAuth on 2026-04-15 after cutting quota from 1,000 to 100 requests/day — [Decrypt](https://decrypt.co/364501/alibaba-shuts-down-free-tier-qwen-code)
- Z.ai restricts the GLM Coding Plan to officially supported tools — [Z.ai FAQ](https://docs.z.ai/devpack/faq)

### Inferences
- For Beamhop, Anthropic's rule targets exactly the proposed design (a third-party app offering Claude login), independent of the billing-pool changes. The May–June 2026 reinstatement concerned users running Agent SDK-based tools locally, not hosted web apps holding OAuth tokens.
- OpenAI is the only frontier provider with a published route to third-party subscription use; an open-source, client-only Beamhop would plausibly fit the "open-source app" category, but the loopback-only callback means a browser tab cannot complete the flow on its own.

### Gaps
- I found no source dated after June 2026 confirming Anthropic's current rule, and did not retrieve Anthropic's Help Center or legal page directly. Treat "paused" as unconfirmed.
- OpenAI's definition of an eligible open-source app, and whether a hosted static web origin can be registered as a redirect for the plan-usage scope, were not found in the pages retrieved. The SIWC docs list further pages (`/siwc/request-client-id`, `/siwc/token-sharing-open-source/preview-limitations`, "Codex app-server", "self-hosted VMs") that I did not read.
- No official GitHub statement was found on Copilot clients other than named partners.

---

## 3. Officially sanctioned user-pays alternatives and BYOK

### Takeaway
OpenRouter PKCE is the only mechanism verified end to end as designed for a backend-less browser app. Puter.js and Hugging Face OAuth are comparable user-pays options. All of these bill a separate account, not the user's Claude/ChatGPT/Gemini subscription.

### Cited Findings
- OpenRouter: the user signs in and authorises the app, which receives an API key tied to their account; PKCE protects the code exchange; no client registration, backend or secret required — [OpenRouter OAuth docs](https://openrouter.ai/docs/guides/overview/auth/oauth)
- OpenRouter key-exchange and inference endpoints both send `access-control-allow-origin: *` — [CORS probe](https://openrouter.ai/api/v1/auth/keys)
- Puter.js "User-Pays Model": each user pays for what they consume through their own Puter account; developers are not billed; no API keys or backend; users get a free allowance and are prompted to sign in to Puter — [Puter docs](https://docs.puter.com/user-pays-model/); [Puter pricing](https://developer.puter.com/pricing/) (vendor claims)
- Hugging Face OAuth offers an `inference-api` scope to "make inference requests on behalf of the user" via Inference Providers, plus a `read-billing` scope — [Hugging Face Hub OAuth docs](https://huggingface.co/docs/hub/en/oauth); the HF router endpoint sends `allow-origin: *` — [CORS probe](https://router.huggingface.co/v1/chat/completions)
- Anthropic's API has supported direct browser calls since August 2024 via `anthropic-dangerous-direct-browser-access: true` — [Simon Willison](https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access)
- Plan-issued API keys usable in third-party tools exist for Kimi Code membership — [Kimi Help Center](https://www.kimi.com/en-cn/help/kimi-code/membership-guide)
- Poe's OpenAI-compatible API endpoint accepts cross-origin preflights (`allow-origin: *`) — [CORS probe](https://api.poe.com/v1/chat/completions)

### Inferences
- BYOK from a browser is technically open for Anthropic, OpenAI, Gemini, xAI, Mistral, Moonshot, DashScope, DeepSeek, Groq, OpenRouter, HF and Poe based on preflight results; GitHub Models, Z.ai and Vercel AI Gateway appear to need a proxy.
- Key-at-rest hardening (wrapping the key with a non-extractable WebCrypto key in IndexedDB, or a key derived from the WebAuthn PRF extension) protects against disk and backup theft but not against script running in Beamhop's origin; on a static GitHub Pages site the residual risk is XSS and supply-chain compromise of the app bundle. This is general security reasoning, not sourced.
- Poe is the one option where a multi-model consumer subscription (points) may be spendable through an API; I did not verify its current terms.

### Gaps
- Not verified: whether Hugging Face's OAuth app registration permits a public SPA client without a secret, and how billing is attributed.
- Not researched: Vercel AI Gateway user-pays OAuth, Cloudflare options, Google AI Studio "sign in" for third-party apps, and any 2026 "connect your account" programmes beyond SIWC.
- No sources retrieved for WebCrypto/passkey-PRF storage practices.

---

## 4. Protocol-level bridges (MCP, MCP Apps, ACP, remote agents)

### Takeaway
Inverting the relationship—exposing Beamhop as a remote MCP server or MCP App so the user's own claude.ai or ChatGPT session is the agent—is the only zero-install way to use a Claude or ChatGPT subscription that stays inside provider-sanctioned surfaces. It requires a server endpoint (not static hosting), and MCP sampling is not a dependable route because it was deprecated in the 2026-07-28 spec.

### Cited Findings
- MCP Apps (announced 2026-01-26) lists Claude (web and desktop) and ChatGPT as supporting clients — [MCP blog](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/); later lists add Cursor and VS Code with Copilot — [eseospace](https://eseospace.com/blog/ai-apps-that-support-mcp/) (secondary)
- ChatGPT added custom MCP servers in September 2025 via Apps & Connectors — [Truthifi](https://truthifi.com/education/state-of-mcp-2026-ai-agents-custom-connectors); one source says full MCP support on web is limited to Business and Enterprise/Edu — [MCP Bundles](https://www.mcpbundles.com/guides/mcp-clients) (secondary, unverified)
- claude.ai and Claude Desktop custom connectors use OAuth 2.1 — [BankBridge](https://bankbridge.money/guides/which-ai-apps-support-mcp) (secondary)
- MCP 2026-07-28: SEP-2577 deprecates Roots, Sampling and Logging; features stay at least twelve months before removal; the new stateless session model has no channel for server-to-client requests — [MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog.md); [WorkOS](https://workos.com/blog/mcp-stateless-spec-2026-07-28)
- Sources disagree on whether Claude clients ever supported sampling: "only major client with sampling" — [Pondero](https://pondero.ai/mcps/guides/mcp-client-comparison/); unsupported — [DEV Community](https://dev.to/serverdex/which-mcp-clients-support-which-features-i-read-the-docs-59kb)
- Claude Code Remote Control connects claude.ai/code or the mobile app to a session running on the user's own machine; it requires Pro/Max/Team/Enterprise, does not support API keys, and the docs describe no public API for starting sessions — [Claude Code docs](https://code.claude.com/docs/en/remote-control); internal endpoints have been reverse-engineered but are undocumented — [DEV Community](https://dev.to/frr149/anatomy-of-claude-codes-remote-control-the-hidden-api-you-cant-use-yet-236l)
- A third-party blog asserts ACP is how third-party tools authenticate with Claude subscriptions — [Digital Applied](https://www.digitalapplied.com/blog/anthropic-claude-credit-overhaul-june-15-2026) (unsourced claim)
- OpenAI's SIWC docs include sections titled "Codex app-server" and "self-hosted VMs" — [OpenAI SIWC docs](https://developers.openai.com/siwc)

### Inferences
- A remote MCP server needs an HTTPS endpoint the provider's cloud can reach, so a GitHub Pages site cannot be one. A small relay (e.g. a Worker) would be needed, and it would see plaintext of whatever it hands to the model unless the MCP App UI does decryption client-side inside the host iframe.
- In the connector model the agent acts only when the user prompts it in claude.ai/ChatGPT; it is turn-driven, not an always-on participant in a group chat. Scheduled tasks in those products could approximate polling, but I did not verify any API for that.
- ACP is an editor-to-local-agent protocol (the agent is a local process), so it does not remove the install requirement; this is from background knowledge, not from a source retrieved here.
- Remote Control still requires Claude Code running on the user's machine, so it is not zero-install.

### Gaps
- No primary Anthropic or OpenAI documentation was retrieved on current connector capabilities, plan gating, or MCP Apps iframe sandbox/CSP rules (which determine whether a Beamhop UI inside claude.ai could open WebSocket/WebRTC connections).
- Not researched: Codex cloud task APIs, Jules API, Copilot coding agent triggering via GitHub issues, ChatGPT agent, Gemini and Le Chat connector support, scheduled-task APIs.
- Sources disagree on whether MCP 2026-07-28 is final or still tagged RC.

---

## 5. Bookmarklets, popups, postMessage and shared-tab tricks

### Takeaway
I found no source showing a sanctioned or working no-install way to drive a provider's web app from another origin; this section is reasoning from web-platform rules plus the CORS results above.

### Cited Findings
- The ChatGPT private backend used by Codex does not return CORS allow-origin headers to a foreign origin — [CORS probe](https://chatgpt.com/backend-api/codex/responses)
- OpenAI's SIWC docs prohibit use of private `chatgpt.com/backend-api` endpoints — [yage.ai](https://yage.ai/share/chatgpt-subscription-oauth-en-20261013.html)
- Google suspended accounts for automated third-party access to consumer-subsidised endpoints — [VentureBeat](https://venturebeat.com/ai/google-clamps-down-on-antigravity-malicious-usage-cutting-off-openclaw-users)

### Inferences
- Cross-origin popups and iframes cannot read or script a provider page unless that page implements a `postMessage` API for the opener; none of the providers is known to offer one for inference. A bookmarklet runs in the provider's origin but must be clicked on every page load, is commonly defeated by strict CSP, and amounts to automating the consumer UI, which the enforcement record above suggests is the riskiest category.

### Gaps
- No tests were run against claude.ai, chatgpt.com or gemini.google.com for frame-ancestors/CSP or anti-automation behaviour.

---

## 6. On-device fallbacks (no subscription)

### Takeaway
Chrome's Prompt API is now a shipped web-platform feature but is desktop-only, hardware-gated and has no native tool calling, so it is a weak fallback for agent work.

### Cited Findings
- The Prompt API is listed as available on the web platform from Chrome 148, using Gemini Nano, with the model downloaded on first use and `LanguageModel.availability()` to check readiness — [Chrome docs](https://developer.chrome.com/docs/ai/prompt-api)
- Not supported on Chrome for Android, iOS, or non-Chromebook-Plus ChromeOS — [Chrome docs](https://developer.chrome.com/docs/ai/prompt-api)
- Reported desktop requirements: 16 GB+ RAM, 4+ CPU cores, 22 GB free storage; JSON-schema structured output and multimodal input — [Impress Watch](https://forest.watch.impress.co.jp/docs/news/2112093.html)
- One open-source integration states the API has no native function calling, so tool use is emulated by prompt injection of tool definitions — [Perfetto plugin source](https://flutter.googlesource.com/third_party/perfetto/+/HEAD/ui/src/plugins/dev.perfetto.LlmProtocolChromePrompt/chrome_prompt_protocol.ts) (undated)

### Inferences
- Structured output via JSON schema makes emulated tool calls workable for simple chat participation; multi-step agent reliability is unproven.

### Gaps
- No benchmarks or sources were found on WebLLM/WebGPU model quality for agent tasks in late 2026.

---

## 7. Minimal-server options

### Takeaway
A stateless CORS proxy resolves only the missing-CORS cases (GitHub device flow, Anthropic token exchange, Z.ai, GitHub Models); it does not make a prohibited use permitted, and it places the user's tokens and prompts in the proxy's path.

### Cited Findings
- Endpoints lacking CORS for a foreign origin on 2026-11-25: GitHub device-code and token endpoints, `api.github.com/copilot_internal/v2/token`, Anthropic OAuth token endpoints, `chatgpt.com/backend-api/codex/responses`, Z.ai coding endpoint, GitHub Models — [CORS probe](https://github.com/login/oauth/access_token)
- Kimi treats client-identifier tampering as a violation — [Kimi Help Center](https://www.kimi.com/en-cn/help/kimi-code/membership-guide)
- OpenAI's SIWC open-source flow requires a listener on `127.0.0.1` — [OpenAI SIWC sign-in docs](https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md)

### Inferences
- For Copilot, a proxy is needed only for the three GitHub token calls; inference can go direct from the browser, keeping prompts off the proxy.
- Any proxy on the inference path sees decrypted prompts, which breaks E2EE toward the proxy operator; a user-self-hosted proxy moves that trust to the user but is no longer "nothing installed".
- A proxy shared by many users presents one IP and may be treated as the abuse pattern providers enforced against in 2026.
- SIWC's loopback requirement means the existing local CLI bridge is the natural place to implement it; a hosted proxy cannot substitute for a loopback redirect.

### Gaps
- No sources were retrieved on provider treatment of shared proxy IPs or on Cloudflare Worker terms for this use.
