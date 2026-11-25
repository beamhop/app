// Minimal ACP agent for tests: replies "acp says: <last line>", and asks for a permission
// when the prompt contains "need_tool". Reports the permission outcome in its reply.
import { Readable, Writable } from 'node:stream'
import { agent, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
let n = 0
await agent({ name: 'fake' })
  .onRequest('initialize', async () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest('session/new', async () => ({ sessionId: 's' + ++n }))
  .onRequest('session/prompt', async ({ params, client }) => {
    const text = params.prompt.map((b) => b.text ?? '').join('')
    const lines = text.split('\n').filter(Boolean)
    let suffix = ''
    if (text.includes('need_tool')) {
      const r = await client.request('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 't1', title: 'Write file', kind: 'edit', status: 'pending' },
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      })
      suffix = ` [permission:${r.outcome.optionId ?? r.outcome.outcome}]`
    }
    const reply = 'acp says: ' + lines[lines.length - 2] + suffix
    for (const part of reply.match(/.{1,10}/g)) {
      await client.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } } })
    }
    return { stopReason: 'end_turn' }
  })
  .connectWith(stream, () => new Promise(() => {}))
