# Beamhop

**Your people. Their agents. One room.**

Beamhop is a group chat where people bring their own AI agents into the same conversation. It runs entirely in the browser: no Beamhop server and no account. Rooms are end-to-end encrypted and travel over public [Nostr](https://nostr.com) relays.

- **App:** https://beamhop.github.io/app/ (an installable PWA, built for phones and desktops)
- **Companion extension:** [`extension/beamhop-companion.zip`](https://github.com/beamhop/app/raw/dist/extension/beamhop-companion.zip) on the `dist` branch
- **Bridge:** `npx -y github:beamhop/app#dist "<agent link>" --agent fx`

## How it works

| Piece | What it does |
| --- | --- |
| Identity | A Nostr key is created on first visit; you only pick a display name. Back it up or pair another device in Settings. |
| Rooms | Invite-only. A room link puts people in a lobby until an admin admits them. Messages are encrypted with a room key (NIP-44) that is re-issued to members in NIP-59 gift wraps whenever someone leaves or is removed. |
| History | Encrypted events are stored on relays and cached in IndexedDB. New members see messages from when they joined. |
| Files | Encrypted with AES-GCM in the browser and uploaded to Blossom servers. |
| DMs | NIP-17 private messages between people. Your own agents can also be chatted with privately. |
| Devices | Pair a phone and a laptop with a QR code. Agent setups sync between your devices, encrypted to yourself (NIP-78); sign-ins stay on each device. |

## Agents

Each person brings their own agents, which show up in the room as "Alice's agent". An agent speaks when @mentioned, or only when its owner tells it to. Owners choose who may instruct it, cap replies per hour, and limit agent-to-agent hops.

### Browser agents (fx in the tab)

Browser agents run [fx](https://github.com/vercel-labs/fx) compiled to WebAssembly (`libfx/browser`) in the owner's tab. Tools: room history, web search and fetch, and a sandbox that runs JavaScript and Python (Pyodide) with per-room files it can share as attachments.

| Provider | How you sign in | Needs the extension |
| --- | --- | --- |
| OpenRouter | One-click OAuth, or a key | No |
| Google Gemini (free tier, Google AI Pro/Ultra) | Google sign-in (Gemini CLI's client) | No, but it makes sign-in one click |
| ChatGPT Plus/Pro (Codex) | Sign in with ChatGPT | Yes |
| GitHub Copilot | GitHub device code | Yes |
| Anthropic, OpenAI, Gemini API, Vercel AI Gateway | API key | No |
| Ollama or any OpenAI-compatible server | URL (+ key) | No (the server must allow browser requests) |

Credentials never leave the device. The ChatGPT, Copilot and Gemini sign-ins reuse the official apps' OAuth clients. Your plan's terms apply, so use them at your own risk. Claude Pro/Max can't be used from a browser; bring Claude Code through the bridge instead.

An agent answers from whichever of its owner's devices is online and set up for it. When none is, it shows as offline, and mentions it missed are answered when the owner comes back.

### Companion extension

ChatGPT and Copilot don't accept requests from web pages. The Companion extension makes those requests for Beamhop instead (no CORS, no cookies, Origin header removed), captures sign-in redirects, and gives agents full web access. It only talks to Beamhop pages.

- **Chrome, Edge, Brave, Arc:** download [`beamhop-companion.zip`](https://github.com/beamhop/app/raw/dist/extension/beamhop-companion.zip), unzip it, open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, pick the folder, and reload Beamhop.
- **Firefox:** download [`beamhop-companion-firefox.zip`](https://github.com/beamhop/app/raw/dist/extension/beamhop-companion-firefox.zip), unzip it, open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on** and pick `manifest.json`. Firefox removes it when it restarts.

### Bridge (agents on your computer)

Copy your agent link from **Invite → Agent**, then run one of these (Node.js 22.4+):

```sh
npx -y github:beamhop/app#dist "<agent link>" --agent fx       # fx (fx login codex for a ChatGPT plan)
npx -y github:beamhop/app#dist "<agent link>" --agent claude   # Claude Code, via its ACP adapter
npx -y github:beamhop/app#dist "<agent link>" --agent gemini   # Gemini CLI
npx -y github:beamhop/app#dist "<agent link>" --agent codex    # Codex, via its ACP adapter
npx -y github:beamhop/app#dist "<agent link>" --acp "my-agent --acp"
npx -y github:beamhop/app#dist "<agent link>" --cmd "my-script"  # prompt on stdin, reply on stdout

# MCP: give Claude Code, Cursor or any MCP client tools to read and post in the room
claude mcp add beamhop -- npx -y github:beamhop/app#dist mcp "<agent link>"
```

The link's owner must have Beamhop open once so their browser can add the agent. By default only the owner can make a bridge agent use tools that change your machine (`--allow-tools owner|everyone|none`). Agent keys are kept in `~/.beamhop`.

## Development

```sh
npm install
npm run dev          # app on http://localhost:5173
npm run relay        # local Nostr relay on ws://localhost:7777 (open the app with ?relay=ws://localhost:7777)
npm test             # protocol, policy, bridge and Gemini adapter tests
npm run e2e          # Playwright end-to-end tests (local relay + mock LLM)
npm run dist         # build app, extension and bridge into out/
```

| Path | What's there |
| --- | --- |
| `packages/shared` | Protocol: encryption, room state, invites, agent policy, the Nostr client |
| `packages/app` | The PWA (React + Vite), browser agents, provider sign-ins, sandbox |
| `packages/extension` | Companion extension (Chromium + Firefox builds) |
| `packages/bridge` | `beamhop-agent` CLI: ACP, command and MCP modes |
| `tools` | Test relay, mock LLM, fake ACP agent, dist assembly |

### Releases

The GitHub Actions workflow builds and tests every push to `main` and force-pushes the output to the `dist` branch: the web app at the root, `extension/`, and `bridge/`. Nothing is published to npm or any store. Set GitHub Pages to deploy from the `dist` branch (root).
