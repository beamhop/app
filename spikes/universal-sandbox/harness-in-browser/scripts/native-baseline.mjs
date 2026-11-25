// Runs the same pi turn on real Node.js against the mock, as a reference for the browser run.
import { startMock } from '../servers/mock-model.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mock = await startMock();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-'));
const agentDir = path.join(tmp, 'home/.pi/agent'), work = path.join(tmp, 'work');
fs.mkdirSync(agentDir, { recursive: true }); fs.mkdirSync(work);
fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, api: 'openai-completions', apiKey: 'mock-key', models: [{ id: 'mock-model' }] } } }));
const t0 = Date.now();
const child = spawn(process.execPath, [path.join(root, 'harnesses/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), ...(process.argv.slice(2).length ? process.argv.slice(2) : ['--mode', 'json', '--model', 'mock/mock-model', '--no-session', '--offline', 'Write hello.txt then read it back with bash.'])],
  { cwd: work, env: { PATH: process.env.PATH, HOME: path.join(tmp, 'home'), PI_OFFLINE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '', err = '';
child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
child.on('close', async (code) => {
  const events = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  console.log(JSON.stringify({ code, ms: Date.now() - t0, eventTypes: events.map((e) => e.type || e.raw).filter((t) => t !== 'message_update'), file: fs.existsSync(path.join(work, 'hello.txt')) && fs.readFileSync(path.join(work, 'hello.txt'), 'utf8'), stderr: err.slice(0, 2000), mock: mock.log.map((l) => ({ path: l.path, step: l.step, tools: l.tools, last: l.lastToolResult, ua: l.headers['user-agent'] })) }, null, 1));
  if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, out);
  await mock.close();
});
