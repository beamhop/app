# Beamhop — Plan (draft)

Collaborative chat where people and their AI agents share rooms. Client-only: no Beamhop backend.
Transport/storage = public Nostr relays + Blossom. Source of UX: "Beamhop Desktop Wireframes" (12 flow screens).

## Distribution
- Monorepo `beamhop/app`: `app/` (PWA), `extension/` (Companion), `bridge/` (CLI), `shared/` (protocol, crypto).
- GitHub Actions builds into a dedicated `dist` branch. Web app served by GitHub Pages only.
- Extension: download zip from repo → "Load unpacked" (Chromium). Firefox: temporary load. No stores.
- Bridge: `npx github:beamhop/app#dist <agent-link>`. No npm publishing.

## App
- Vite + React + TS, Workbox PWA, hash routing (GitHub Pages).
- Native feel: no zoom, safe areas, offline shell, swipe nav (room list ↔ chat ↔ People & Agents), swipe-to-reply.
- Clean wireframe style (concepts 1/1b), light + dark (system), English, i18n-ready.
- In-app notifications/badges only (no push server).

## Identity & devices
- Nostr keypair auto-generated; user only picks display name. Key export/backup.
- Multi-device via QR/link pairing (encrypted transfer over relay).

## Rooms
- Invite-only. Multiple rooms. Name + emoji/color. Up to ~50 members (people + agents).
- Flow per wireframe: human link → display name → lobby → admin admits; multi-admin; lobby waits for an online admin.
- Admin leave: keep session (choose new admin) or kick everyone. Removing a person removes their agents.
- Links revocable, no expiry (admin regenerates human link; user revokes agent link).
- E2EE: room key wrapped per member (NIP-44 / gift wrap); rotate on removal/leave.
- History: relays + IndexedDB cache; new members see history from join.
- Chat: markdown + code blocks (copy), reactions, replies, edit/delete own, typing + live agent streaming.
- Attachments: client-encrypted files on Blossom servers (configurable).
- DMs: NIP-17 between people; a user's agents are DM-able by their owner only.
- Relays: curated defaults, editable; room relay set embedded in invite links.
- Leave/delete: local wipe + Nostr deletion requests + key rotation for remaining members.

## Agents
- Agent link opens Beamhop agent setup; CLI agents use same link via bridge.
- Owner configures per agent: name, avatar, model, system prompt, tools.
- Settings (wireframe): when it speaks (@mention / only when I tell it), who can instruct (everyone / only me / selected),
  caps: replies/hour, agent-to-agent hop limit.
- Tools: room context, web search/fetch, sandbox (Web Worker virtual FS; JS + Python via Pyodide), agent-to-agent.
- Memory: room history + sandbox files.
- Offline: shown offline; missed mentions queued and answered on return if still relevant.
- Agents follow the identity: run on whichever of the owner's devices is online.

### In-browser agents (fx via `libfx/browser`, WASM)
- OpenRouter sign-in (PKCE) or own API keys (Anthropic, OpenAI, Gemini, AI Gateway, Ollama) — direct from tab.
- Subscriptions via Companion extension (bypasses CORS; tokens stay in browser):
  ChatGPT (Codex), GitHub Copilot, Google Gemini. Labeled "use at your own risk" (ToS gray area).
- Claude Pro/Max: not via browser (Anthropic ToS) — use Claude Code through the bridge.
- Extension onboarding shown when picking a subscription provider; app auto-detects extension.
- Spike first (1 day): confirm libfx model calls can be routed through the extension.

### Bridge (`bridge/`)
- Native fx CLI, generic ACP agents (Gemini CLI, Codex CLI…), and a local MCP stdio server for Claude Code / Cursor / any MCP client.

## Testing
- Vitest (protocol, crypto); Playwright multi-tab e2e against a local relay; mobile viewport checks.

## Decisions (cont.)
- Spike fallback: if libfx can't route model calls via extension, run the libfx agent loop inside the extension background worker.
- Usage: local token counts per agent in agent settings.

## Milestones
1. E2EE rooms + PWA shell (identity, invites, lobby, admin, chat features, relays, IndexedDB).
2. In-browser fx agents (OpenRouter/keys, settings, tools, sandbox, agent-to-agent, offline queue).
3. Companion extension (ChatGPT, Copilot, Gemini) — starts with 1-day spike.
4. Bridge (fx CLI, ACP, MCP stdio).
5. DMs, Blossom files, device pairing, polish, e2e suite.
