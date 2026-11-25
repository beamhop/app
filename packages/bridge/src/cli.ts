#!/usr/bin/env node
// Beamhop bridge: brings an agent on this computer into a Beamhop room.
//
//   npx github:beamhop/app#dist "<agent link>" --agent fx|claude|gemini|codex
//   npx github:beamhop/app#dist "<agent link>" --cmd "my-agent --stdin"
//   npx github:beamhop/app#dist mcp "<agent link>"      (MCP stdio server for Claude Code, Cursor…)
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import {
  agentInstructions,
  DEFAULT_CAPS,
  displayName,
  formatTranscript,
  randomHex,
  shouldRespond,
  type Decoded,
} from '@beamhop/shared'
import { joinRoom, type Joined } from './room-agent.js'
import { AcpBackend, CommandBackend, PRESETS, type Backend } from './backends.js'
import { runMcp } from './mcp.js'

const HELP = `Beamhop bridge: brings an agent on this computer into a Beamhop room.

Usage:
  beamhop-agent "<agent link>" [--agent fx|claude|gemini|codex] [options]
  beamhop-agent "<agent link>" --cmd "<command>"     prompt on stdin, reply on stdout
  beamhop-agent mcp "<agent link>" [--name <name>]   MCP server (stdio) for Claude Code, Cursor…

Options:
  --agent <id>       fx (default), claude, gemini, codex
  --acp "<command>"  any other ACP agent command
  --name <name>      name shown in the room (default: the agent's name)
  --cwd <dir>        working directory for the agent (default: current directory)
  --allow-tools <who>  who may make the agent use tools that change this machine:
                     owner (default) | everyone | none
  --per-hour <n>     max replies per hour (default ${DEFAULT_CAPS.perHour})
  --max-hops <n>     agent-to-agent hop limit (default ${DEFAULT_CAPS.maxHops})
  --relay <url>      override relays (repeatable)

The agent link comes from Beamhop: Invite → Agent → Copy.`

const log = (...a: any[]) => console.error('[beamhop]', ...a)

async function main() {
  const argv = process.argv.slice(2)
  const mcp = argv[0] === 'mcp'
  const { values, positionals } = parseArgs({
    args: mcp ? argv.slice(1) : argv,
    allowPositionals: true,
    options: {
      agent: { type: 'string', default: 'fx' },
      acp: { type: 'string' },
      cmd: { type: 'string' },
      name: { type: 'string' },
      cwd: { type: 'string' },
      'allow-tools': { type: 'string', default: 'owner' },
      'per-hour': { type: 'string' },
      'max-hops': { type: 'string' },
      relay: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help || !positionals[0]) {
    console.error(HELP)
    process.exit(values.help ? 0 : 1)
  }
  const link = positionals[0]
  if (mcp) return runMcp(link, values.name ?? 'Claude Code', values.relay)

  const cwd = resolve(values.cwd ?? process.cwd())
  let backend: Backend
  let defaultName: string
  if (values.cmd) {
    backend = new CommandBackend('command', values.cmd, cwd)
    defaultName = values.cmd.split(/\s+/)[0].split('/').pop() || 'Agent'
  } else if (values.acp) {
    const [cmd, ...args] = values.acp.split(/\s+/)
    backend = new AcpBackend(cmd, cmd, args, cwd)
    defaultName = cmd
  } else {
    const p = PRESETS[values.agent!]
    if (!p) throw new Error(`Unknown --agent ${values.agent}. Use fx, claude, gemini or codex, or --acp "<command>".`)
    backend = new AcpBackend(p.label, p.cmd, p.args, cwd)
    defaultName = p.label
  }
  const name = values.name ?? defaultName
  const caps = {
    perHour: Number(values['per-hour'] ?? DEFAULT_CAPS.perHour),
    maxHops: Number(values['max-hops'] ?? DEFAULT_CAPS.maxHops),
  }
  const allowTools = values['allow-tools'] as 'owner' | 'everyone' | 'none'
  const joined = await joinRoom(link, name, 'bridge', undefined, { relays: values.relay })
  await serve(joined, backend, { caps, allowTools })
}

export async function serve(j: Joined, backend: Backend, o: { caps: typeof DEFAULT_CAPS; allowTools: 'owner' | 'everyone' | 'none' }) {
  const { client, roomId } = j
  const replies: number[] = []
  let queue = Promise.resolve()
  let lastIncluded = 0
  const answered = new Set<string>()

  const runTurn = async (ev: Decoded, hop: number) => {
    const st = client.state(roomId)
    if (!st || answered.has(ev.id)) return
    answered.add(ev.id)
    const sid = randomHex(8)
    let text = ''
    let last = 0
    const push = (status?: string, done = false) => client.stream(roomId, client.pk, sid, text, { trigger: ev.id, status, done })
    try {
      await push('Thinking…')
      const msgs = client.messages(roomId).filter((m) => m.payload.t === 'msg' && m.ms <= ev.ms && m.ms > lastIncluded)
      const first = lastIncluded === 0
      lastIncluded = ev.ms
      const owner = st.agents[client.pk]?.owner
      const prompt = [
        first ? agentInstructions(st, client.pk, '') : '',
        first ? 'Recent room transcript:' : 'New messages in the room since your last reply:',
        formatTranscript(st, msgs, client.pk, 40) || '(none)',
        '',
        `${displayName(st, ev.pubkey)} mentioned you in the last message. Reply with the message to post in the room.`,
      ]
        .filter(Boolean)
        .join('\n')
      const allow = o.allowTools === 'everyone' || (o.allowTools === 'owner' && ev.pubkey === owner)
      log(`→ ${displayName(st, ev.pubkey)}: ${(ev.payload as any).text.slice(0, 80)}`)
      const out = await backend.run({
        prompt,
        allowTools: allow,
        onText: (d) => {
          text += d
          if (Date.now() - last > 500) {
            last = Date.now()
            push()
          }
        },
        onStatus: (s) => push(s),
      })
      await client.sendMessage(roomId, (out || text).trim() || '…', { as: client.pk, trigger: ev.id, hop, sid })
      replies.push(Date.now())
      log(`← replied (${(out || text).length} chars)`)
    } catch (e: any) {
      log('error:', e?.message ?? e)
      await client.sendMessage(roomId, `⚠️ ${String(e?.message ?? e).slice(0, 400)}`, { as: client.pk, trigger: ev.id, hop, sid }).catch(() => {})
    } finally {
      push(undefined, true)
    }
  }

  client.on('message', ({ roomId: rid, ev, live }) => {
    if (rid !== roomId || !live) return
    const st = client.state(roomId)
    if (!st) return
    if (!st.agents[client.pk]) {
      log('This agent was removed from the room. Exiting.')
      shutdown(0)
      return
    }
    if (st.closed) {
      log('The room was closed. Exiting.')
      shutdown(0)
      return
    }
    const d = shouldRespond(st, client.pk, ev, o.caps, replies)
    if (!d.respond) return
    queue = queue.then(() => runTurn(ev, d.hop))
  })

  const shutdown = async (code: number) => {
    await backend.close().catch(() => {})
    j.kv.flushSync()
    await client.stop().catch(() => {})
    process.exit(code)
  }
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
  log('Listening. @mention the agent in the room. Ctrl+C to stop.')
}

const isMain = !process.env.BEAMHOP_NO_MAIN
if (isMain)
  main().catch((e) => {
    log(e?.message ?? e)
    process.exit(1)
  })
