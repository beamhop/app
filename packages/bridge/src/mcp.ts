// MCP stdio server: gives Claude Code, Cursor or any MCP client tools to take part in a Beamhop room.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { displayName, formatTranscript, isMentioned, type Decoded } from '@beamhop/shared'
import { joinRoom } from './room-agent.js'

export async function runMcp(link: string, name: string, relays?: string[]) {
  const j = await joinRoom(link, name, 'bridge', undefined, { relays, quiet: false })
  const { client, roomId } = j
  const mentions: Decoded[] = []
  const waiters: ((d: Decoded) => void)[] = []
  client.on('message', ({ roomId: rid, ev, live }) => {
    const st = client.state(roomId)
    if (rid !== roomId || !live || !st || ev.pubkey === client.pk) return
    if (isMentioned(st, ev, client.pk)) {
      const w = waiters.shift()
      if (w) w(ev)
      else mentions.push(ev)
    }
  })
  const fmt = (e: Decoded) => `[${e.id.slice(0, 8)}] ${client.nameOf(roomId, e.pubkey)}: ${(e.payload as any).text}`

  const server = new McpServer({ name: 'beamhop', version: '0.1.0' })
  server.registerTool(
    'beamhop_read_messages',
    { description: 'Read the most recent messages in the Beamhop room you joined, oldest first.', inputSchema: { limit: z.number().int().min(1).max(200).optional() } },
    async ({ limit }) => {
      const st = client.state(roomId)!
      return { content: [{ type: 'text', text: formatTranscript(st, client.messages(roomId), client.pk, limit ?? 50) || '(no messages)' }] }
    },
  )
  server.registerTool(
    'beamhop_send_message',
    {
      description: 'Post a message to the Beamhop room as yourself (an agent). Markdown works. @Name mentions a person or agent.',
      inputSchema: { text: z.string().min(1), reply_to: z.string().optional().describe('id prefix of a message to reply to') },
    },
    async ({ text, reply_to }) => {
      const reply = reply_to ? client.messages(roomId).find((m) => m.id.startsWith(reply_to))?.id : undefined
      await client.sendMessage(roomId, text, { as: client.pk, reply, trigger: reply, hop: 0 })
      return { content: [{ type: 'text', text: 'Sent.' }] }
    },
  )
  server.registerTool(
    'beamhop_wait_for_mention',
    {
      description: 'Wait until someone @mentions you in the room, then return that message. Use this to take requests from the room.',
      inputSchema: { timeout_seconds: z.number().int().min(1).max(3600).optional() },
    },
    async ({ timeout_seconds }) => {
      const queued = mentions.shift()
      if (queued) return { content: [{ type: 'text', text: fmt(queued) }] }
      const ev = await new Promise<Decoded | null>((resolve) => {
        const t = setTimeout(() => {
          const i = waiters.indexOf(f)
          if (i >= 0) waiters.splice(i, 1)
          resolve(null)
        }, (timeout_seconds ?? 300) * 1000)
        const f = (d: Decoded) => {
          clearTimeout(t)
          resolve(d)
        }
        waiters.push(f)
      })
      return { content: [{ type: 'text', text: ev ? fmt(ev) : 'No mention yet.' }] }
    },
  )
  server.registerTool('beamhop_room_info', { description: 'Who is in the Beamhop room: people and agents.' }, async () => {
    const st = client.state(roomId)!
    const lines = [
      `Room: ${st.name}`,
      `You: ${displayName(st, client.pk)} (agent of ${displayName(st, st.agents[client.pk]?.owner ?? '')})`,
      'People: ' + Object.values(st.members).map((m) => m.name).join(', '),
      'Agents: ' + Object.values(st.agents).map((a) => a.name).join(', '),
    ]
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  })
  await server.connect(new StdioServerTransport())
  process.stdin.on('close', async () => {
    j.kv.flushSync()
    await client.stop().catch(() => {})
    process.exit(0)
  })
}
