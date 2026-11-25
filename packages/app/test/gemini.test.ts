import { describe, it, expect, vi } from 'vitest'
import { makeGeminiFetch } from '../src/agents/gemini'

const sse = (objs: any[]) => new Response(objs.map((o) => 'data: ' + JSON.stringify(o) + '\r\n\r\n').join(''), { headers: { 'content-type': 'text/event-stream' } })

async function readChunks(res: Response) {
  const text = await res.text()
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => JSON.parse(l.slice(6)))
}

describe('gemini adapter', () => {
  it('translates a chat request with tools and streams text + tool calls back', async () => {
    const calls: any[] = []
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) })
      return sse([
        { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] } }] } },
        { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'lo', thought: false }, { functionCall: { name: 'web_search', args: { query: 'x' } }, thoughtSignature: 'SIG' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } } },
      ])
    })
    const f = makeGeminiFetch(async () => ({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6, projectId: 'proj-1' }))
    const body = {
      model: 'gemini-2.5-flash',
      stream: true,
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1~sig~OLD', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
        { role: 'tool', tool_call_id: 'call_1~sig~OLD', content: 'file body' },
      ],
      tools: [{ type: 'function', function: { name: 'web_search', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }],
      max_tokens: 100,
    }
    const res = await f('https://cloudcode-pa.googleapis.com/v1internal/chat/completions', { method: 'POST', body: JSON.stringify(body) })
    const chunks = await readChunks(res)
    const sent = calls[0]
    expect(sent.url).toContain(':streamGenerateContent?alt=sse')
    expect(sent.body.project).toBe('proj-1')
    expect(sent.body.model).toBe('gemini-2.5-flash')
    const req = sent.body.request
    expect(req.systemInstruction.parts[0].text).toBe('be brief')
    expect(req.contents[0]).toEqual({ role: 'user', parts: [{ text: 'hi' }] })
    expect(req.contents[1].parts[0]).toEqual({ functionCall: { name: 'read_file', args: { path: 'a' } }, thoughtSignature: 'OLD' })
    expect(req.contents[2].parts[0]).toEqual({ functionResponse: { name: 'read_file', response: { result: 'file body' } } })
    expect(req.tools[0].functionDeclarations[0].name).toBe('web_search')
    expect(req.generationConfig.maxOutputTokens).toBe(100)

    const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('')
    expect(text).toBe('Hello')
    const tc = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls)!.choices[0].delta.tool_calls[0]
    expect(tc.function.name).toBe('web_search')
    expect(JSON.parse(tc.function.arguments)).toEqual({ query: 'x' })
    expect(tc.id).toContain('~sig~SIG')
    expect(chunks.find((c) => c.choices?.[0]?.finish_reason)!.choices[0].finish_reason).toBe('tool_calls')
    expect(chunks.find((c) => c.usage)!.usage.total_tokens).toBe(13)
    vi.unstubAllGlobals()
  })

  it('passes API errors through as JSON errors', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 }))
    const f = makeGeminiFetch(async () => ({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 }))
    const res = await f('https://x/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }] }) })
    expect(res.status).toBe(429)
    expect((await res.json()).error.message).toBe('quota exceeded')
    vi.unstubAllGlobals()
  })
})

describe('gemini adapter with fx', () => {
  it('runs a full fx turn including a tool call', async () => {
    const { createFxAgent } = await import('libfx/node')
    let turnNo = 0
    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      const req = JSON.parse(init.body).request
      turnNo++
      const last = req.contents[req.contents.length - 1]
      if (last.parts[0].functionResponse) return sse([{ response: { candidates: [{ content: { parts: [{ text: 'The time is ' + last.parts[0].functionResponse.response.result }] }, finishReason: 'STOP' }] } }])
      return sse([{ response: { candidates: [{ content: { parts: [{ functionCall: { name: 'get_time', args: {} } }] }, finishReason: 'STOP' }] } }])
    })
    const agent = createFxAgent({
      provider: { name: 'gemini', baseUrl: 'https://cloudcode-pa.googleapis.com/v1internal', modelDefaults: { contextWindow: 1000000, maxOutputTokens: 8192, supportsToolUse: true } },
      model: 'gemini-2.5-flash',
      fetch: makeGeminiFetch(async () => ({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6, projectId: 'p' })) as any,
      tools: [{ name: 'get_time', description: 'time', inputSchema: { type: 'object', properties: {} }, idempotent: true, execute: async () => 'noon' }],
    } as any)
    const turn = agent.session().prompt('what time is it?')
    let text = ''
    for await (const e of turn as any) if (e.type === 'text_delta') text += e.delta
    const r = await turn.result
    await agent.close()
    vi.unstubAllGlobals()
    expect(r.stopReason).toBe('end_turn')
    expect(text).toBe('The time is noon')
    expect(turnNo).toBe(2)
  }, 30000)
})
