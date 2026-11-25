// Mock Anthropic Messages and Gemini APIs for testing real agent CLIs (Claude Code, Gemini CLI)
// through the bridge. Both reply "echo: <last line of the last user text>".
import http from 'node:http'

const lastLine = (t) => {
  const lines = String(t).split('\n').map((l) => l.trim()).filter(Boolean)
  return (lines.filter((l) => !l.startsWith('<') && !l.startsWith('(')).pop() ?? lines.pop() ?? '').slice(0, 200)
}

export function startMockAnthropic(port = 7791) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const j = body ? JSON.parse(body) : {}
    requests.push({ url: req.url, body: j })
    if (!req.url.startsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('{}')
    }
    if (req.url.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ input_tokens: 100 }))
    }
    const msgs = j.messages ?? []
    const user = [...msgs].reverse().find((m) => m.role === 'user')
    const text = typeof user?.content === 'string' ? user.content : (user?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n')
    const reply = 'echo: ' + lastLine(text)
    const id = 'msg_' + Date.now()
    const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    if (!j.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', stop_sequence: null, usage }))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    ev('message_start', { message: { id, type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, stop_sequence: null, usage } })
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    for (const part of reply.match(/.{1,12}/gs) ?? ['']) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: part } })
    ev('content_block_stop', { index: 0 })
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    ev('message_stop', {})
    res.end()
  })
  server.listen(port)
  return { server, requests, close: () => new Promise((r) => server.close(r)) }
}

export function startMockGemini(port = 7792) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const j = body ? JSON.parse(body) : {}
    requests.push({ url: req.url, body: j })
    res.setHeader('content-type', 'application/json')
    if (req.url.includes(':countTokens')) return res.end(JSON.stringify({ totalTokens: 100 }))
    const contents = j.contents ?? []
    const user = [...contents].reverse().find((c) => c.role === 'user' && c.parts?.some((p) => p.text))
    const text = (user?.parts ?? []).map((p) => p.text ?? '').join('\n')
    // Gemini CLI asks small JSON questions (e.g. next speaker / routing) with a response schema.
    const wantsJson = j.generationConfig?.responseMimeType === 'application/json' || j.generationConfig?.responseJsonSchema
    const reply = wantsJson ? JSON.stringify({ reasoning: 'done', next_speaker: 'user', model_choice: 'flash' }) : 'echo: ' + lastLine(text)
    const chunk = { candidates: [{ content: { role: 'model', parts: [{ text: reply }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } }
    if (req.url.includes(':streamGenerateContent')) {
      res.setHeader('content-type', 'text/event-stream')
      return res.end('data: ' + JSON.stringify(chunk) + '\r\n\r\n')
    }
    res.end(JSON.stringify(chunk))
  })
  server.listen(port)
  return { server, requests, close: () => new Promise((r) => server.close(r)) }
}
