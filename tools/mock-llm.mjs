// Mock OpenAI-compatible chat completions server for tests.
// Replies "echo: <last user text>" and calls a tool when the prompt contains "use_tool:<name>".
import http from 'node:http'

// OpenAI Responses API (streaming), as used by Codex.
async function responses(j, res) {
  const items = Array.isArray(j.input) ? j.input : [{ role: 'user', content: [{ type: 'input_text', text: String(j.input ?? '') }] }]
  const user = [...items].reverse().find((i) => i.role === 'user')
  const text = typeof user?.content === 'string' ? user.content : (user?.content ?? []).map((p) => p.text ?? '').join('\n')
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('<'))
  const reply = 'echo: ' + (lines.pop() ?? '').slice(0, 200)
  const id = 'resp_' + Date.now()
  const msgId = 'msg_' + Date.now()
  const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 }
  const done = { type: 'message', id: msgId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply, annotations: [] }] }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  let seq = 0
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`)
  const base = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model: j.model, status: 'in_progress', output: [] }
  ev('response.created', { response: base })
  ev('response.output_item.added', { output_index: 0, item: { type: 'message', id: msgId, role: 'assistant', status: 'in_progress', content: [] } })
  ev('response.content_part.added', { item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
  for (const part of reply.match(/.{1,10}/gs) ?? ['']) ev('response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: part })
  ev('response.output_text.done', { item_id: msgId, output_index: 0, content_index: 0, text: reply })
  ev('response.content_part.done', { item_id: msgId, output_index: 0, content_index: 0, part: done.content[0] })
  ev('response.output_item.done', { output_index: 0, item: done })
  ev('response.completed', { response: { ...base, status: 'completed', output: [done], usage } })
  res.end()
}

export function startMockLLM(port = 7790, { log } = {}) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    if (req.method === 'OPTIONS') return res.end()
    if (req.url.endsWith('/models')) {
      res.setHeader('content-type', 'application/json')
      return res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'mock-model-2' }] }))
    }
    let body = ''
    for await (const c of req) body += c
    const j = body ? JSON.parse(body) : {}
    requests.push({ url: req.url, headers: req.headers, body: j })
    if (req.url.endsWith('/responses')) return responses(j, res)
    if (log) console.log(JSON.stringify(j, null, 1).slice(0, 4000))
    const msgs = j.messages || []
    const last = msgs[msgs.length - 1]
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
    const text = typeof lastUser?.content === 'string' ? lastUser.content : (lastUser?.content || []).map((p) => p.text || '').join('')
    const toolMatch = text.match(/use_tool:(\w+)(?:\s+(\{.*?\}))?/)
    let reply = null
    let toolCall = null
    if (last?.role === 'tool') reply = `tool said: ${typeof last.content === 'string' ? last.content.slice(0, 200) : JSON.stringify(last.content).slice(0, 200)}`
    else if (toolMatch && j.tools?.some((t) => t.function?.name === toolMatch[1])) toolCall = { id: 'call_' + Date.now(), name: toolMatch[1], args: toolMatch[2] || '{}' }
    else {
      const lines = text.split('\n').filter(Boolean)
      reply = 'echo: ' + (lines[lines.length - 1] || '').slice(0, 300)
    }
    const id = 'chatcmpl-' + Date.now()
    const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: j.model }
    if (j.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n')
      if (toolCall) {
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: '' } }] } }] })
        send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: toolCall.args } }] } }] })
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        const parts = reply.match(/.{1,8}/gs) || ['']
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
        for (const p of parts) {
          send({ ...base, choices: [{ index: 0, delta: { content: p } }] })
          await new Promise((r) => setTimeout(r, 15))
        }
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      }
      send({ ...base, choices: [], usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 } })
      res.end('data: [DONE]\n\n')
    } else {
      res.setHeader('content-type', 'application/json')
      const message = toolCall
        ? { role: 'assistant', content: null, tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.args } }] }
        : { role: 'assistant', content: reply }
      res.end(JSON.stringify({ id, object: 'chat.completion', model: j.model, choices: [{ index: 0, message, finish_reason: toolCall ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 } }))
    }
  })
  server.listen(port)
  return { server, requests, close: () => new Promise((r) => server.close(r)) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMockLLM(Number(process.argv[2] || 7790), { log: process.argv.includes('--log') })
  console.log('mock llm on', process.argv[2] || 7790)
}
