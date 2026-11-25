// Mock model server. Speaks three wire protocols with one scripted conversation:
//   OpenAI chat completions (SSE)      POST /v1/chat/completions
//   Anthropic Messages (SSE)           POST /v1/messages
//   Gemini streamGenerateContent (SSE) POST /v1beta/models/<m>:streamGenerateContent
// Script (decided by how many tool results the request already carries):
//   0 results -> call the write tool      (hello.txt)
//   1 result  -> call the shell tool      (cat hello.txt)
//   2 results -> final text that echoes the last tool result
import http from 'node:http';

export const FILE_NAME = 'hello.txt';
export const FILE_TEXT = 'hello from the universal sandbox\n';
export const SHELL_CMD = `cat ${FILE_NAME} && echo lines=$(wc -l < ${FILE_NAME})`;
export const FINAL_PREFIX = 'FINAL ANSWER: the shell printed: ';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
const textOf = (c) =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p.text ?? textOf(p.content) ?? '')).join('') : c == null ? '' : JSON.stringify(c);

export function startMock({ port = 0, delayMs = 15 } = {}) {
  const log = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/__log') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(log));
    }
    const raw = await readBody(req);
    let body = {};
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch {}
    const entry = { method: req.method, path: url.pathname, headers: req.headers, via: req.headers['x-via'] || null, remotePort: req.socket.remotePort };
    log.push(entry);
    const sse = (obj, event) => res.write((event ? `event: ${event}\n` : '') + `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`);
    const sseHead = () => res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });

    // ---------------- OpenAI chat completions ----------------
    if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      const toolMsgs = (body.messages || []).filter((m) => m.role === 'tool');
      const tools = (body.tools || []).map((t) => t.function?.name ?? t.name);
      entry.kind = 'openai'; entry.step = toolMsgs.length; entry.tools = tools; entry.stream = !!body.stream;
      const id = 'chatcmpl-mock' + log.length, base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
      const chunk = (delta, finish = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });
      sseHead();
      const call = async (name, args) => {
        sse(chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_' + log.length, type: 'function', function: { name, arguments: '' } }] }));
        const s = JSON.stringify(args);
        for (let i = 0; i < s.length; i += 12) { await sleep(delayMs); sse(chunk({ tool_calls: [{ index: 0, function: { arguments: s.slice(i, i + 12) } }] })); }
        sse(chunk({}, 'tool_calls'));
      };
      if (toolMsgs.length === 0) await call(tools.includes('write') ? 'write' : tools.find((t) => /write/i.test(t)) || 'write', { path: FILE_NAME, content: FILE_TEXT });
      else if (toolMsgs.length === 1) await call('bash', { command: SHELL_CMD });
      else {
        const last = textOf(toolMsgs.at(-1).content).trim();
        entry.lastToolResult = last;
        sse(chunk({ role: 'assistant', content: '' }));
        for (const w of (FINAL_PREFIX + last).split(/(?<= )/)) { await sleep(delayMs); sse(chunk({ content: w })); }
        sse(chunk({}, 'stop'));
      }
      sse({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
      sse('[DONE]');
      return res.end();
    }

    // ---------------- Anthropic Messages ----------------
    if (req.method === 'POST' && url.pathname.endsWith('/v1/messages')) {
      const results = (body.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === 'tool_result');
      const tools = (body.tools || []).map((t) => t.name);
      entry.kind = 'anthropic'; entry.step = results.length; entry.tools = tools; entry.stream = !!body.stream; entry.model = body.model;
      const hasAgentTools = tools.includes('Write') && tools.includes('Bash');
      entry.agentRequest = hasAgentTools;
      const msg = { id: 'msg_mock' + log.length, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
      let plan;
      if (!hasAgentTools) plan = { text: 'ok' }; // auxiliary requests (titles, quota probes, ...)
      else if (results.length === 0) plan = { tool: 'Write', input: { file_path: '/work/' + FILE_NAME, content: FILE_TEXT } };
      else if (results.length === 1) plan = { tool: 'Bash', input: { command: SHELL_CMD, description: 'Read the file back' } };
      else { const last = textOf(results.at(-1).content).trim(); entry.lastToolResult = last; plan = { text: FINAL_PREFIX + last }; }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ...msg, content: plan.text != null ? [{ type: 'text', text: plan.text }] : [{ type: 'tool_use', id: 'toolu_' + log.length, name: plan.tool, input: plan.input }], stop_reason: plan.text != null ? 'end_turn' : 'tool_use', usage: { ...msg.usage, output_tokens: 20 } }));
      }
      sseHead();
      sse({ type: 'message_start', message: msg }, 'message_start');
      if (plan.text != null) {
        sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start');
        for (const w of plan.text.split(/(?<= )/)) { await sleep(delayMs); sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } }, 'content_block_delta'); }
      } else {
        sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_' + log.length, name: plan.tool, input: {} } }, 'content_block_start');
        const s = JSON.stringify(plan.input);
        for (let i = 0; i < s.length; i += 12) { await sleep(delayMs); sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: s.slice(i, i + 12) } }, 'content_block_delta'); }
      }
      sse({ type: 'content_block_stop', index: 0 }, 'content_block_stop');
      sse({ type: 'message_delta', delta: { stop_reason: plan.text != null ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }, 'message_delta');
      sse({ type: 'message_stop' }, 'message_stop');
      return res.end();
    }
    if (req.method === 'POST' && url.pathname.endsWith('/v1/messages/count_tokens')) {
      entry.kind = 'anthropic-count';
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 100 }));
    }

    // ---------------- Gemini ----------------
    const gm = url.pathname.match(/\/models\/([^:/]+):(\w+)$/);
    if (req.method === 'POST' && gm) {
      const [, model, method] = gm;
      const parts = (body.contents || []).flatMap((c) => c.parts || []);
      const results = parts.filter((p) => p.functionResponse);
      const tools = (body.tools || []).flatMap((t) => (t.functionDeclarations || []).map((f) => f.name));
      entry.kind = 'gemini'; entry.method = method; entry.model = model; entry.step = results.length; entry.tools = tools;
      const usageMetadata = { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 };
      if (method === 'countTokens') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ totalTokens: 100 })); }
      const hasAgentTools = tools.includes('write_file') && tools.includes('run_shell_command');
      entry.agentRequest = hasAgentTools;
      let outParts;
      if (!hasAgentTools) outParts = [{ text: body.generationConfig?.responseMimeType === 'application/json' ? '{}' : 'ok' }];
      else if (results.length === 0) outParts = [{ functionCall: { name: 'write_file', args: { file_path: '/work/' + FILE_NAME, content: FILE_TEXT } } }];
      else if (results.length === 1) outParts = [{ functionCall: { name: 'run_shell_command', args: { command: SHELL_CMD, description: 'Read the file back' } } }];
      else { const r = results.at(-1).functionResponse.response; const last = (typeof r?.output === 'string' ? r.output : JSON.stringify(r)).trim(); entry.lastToolResult = last; outParts = [{ text: FINAL_PREFIX + last }]; }
      const cand = (p, finish) => ({ candidates: [{ content: { role: 'model', parts: p }, index: 0, ...(finish ? { finishReason: 'STOP' } : {}) }], usageMetadata, modelVersion: model });
      if (method === 'generateContent') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(cand(outParts, true))); }
      sseHead();
      if (outParts[0].text) { for (const w of outParts[0].text.split(/(?<= )/)) { await sleep(delayMs); sse(cand([{ text: w }], false)); } sse(cand([{ text: '' }], true)); }
      else { await sleep(delayMs); sse(cand(outParts, true)); }
      return res.end();
    }

    entry.kind = 'unhandled';
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock: no route for ' + req.method + ' ' + url.pathname, type: 'not_found' } }));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, log, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startMock({ port: Number(process.env.PORT || 4010) });
  console.log('mock model server on http://127.0.0.1:' + m.port);
}
