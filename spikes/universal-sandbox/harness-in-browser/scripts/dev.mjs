// Development driver: run one harness invocation in the browser worker and dump everything.
//   node scripts/dev.mjs <pi|gemini> [--ses] [--tunnel] -- <harness args...>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { startMock } from '../servers/mock-model.mjs';
import { startStatic } from '../servers/static.mjs';
import { startCorsProxy } from '../servers/cors-proxy.mjs';
import { startRelay } from '../servers/ws-relay.mjs';
import { scenario } from './scenarios.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const flags = split === -1 ? argv : argv.slice(0, split), args = split === -1 ? null : argv.slice(split + 1);
const harness = flags.find((f) => !f.startsWith('--')) || 'pi';
const [mock, stat, proxy, relay] = await Promise.all([startMock(), startStatic({ dir: path.join(root, 'dist/web') }), startCorsProxy(), startRelay()]);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => console.error('[browser]', m.text().slice(0, 2000)));
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${stat.port}/`);
const cfg = scenario(harness, { mockPort: mock.port, proxyPort: proxy.port, relayPort: relay.port, variant: flags.includes('--ses') ? 'ses' : 'plain', lockdownOptions: process.env.LOCKDOWN ? JSON.parse(process.env.LOCKDOWN) : undefined, sesBuild: process.env.SESBUILD, netMode: flags.includes('--tunnel') ? 'tunnel' : 'bridge', args, timeoutMs: Number(process.env.TIMEOUT || 30000) });
if (process.env.LIVE) cfg.debugLive = true;
if (process.env.TRACE) cfg.trace = Number(process.env.TRACE);
if (process.env.PATCH) cfg.debugPatches = JSON.parse((await import('node:fs')).readFileSync(process.env.PATCH, 'utf8'));
if (process.env.KEEPALIVE) cfg.keepAlive = true;
if (process.env.SCRIPT) { cfg.files['/work/test.cjs'] = (await import('node:fs')).readFileSync(process.env.SCRIPT, 'utf8').replaceAll('__MOCK__', 'http://127.0.0.1:' + mock.port); cfg.entry = '/work/test.cjs'; cfg.args = []; }
const out = await page.evaluate((c) => window.runHarness(c), cfg);
const rep = out.report || {};
console.log('--- stdout ---\n' + out.stdout.slice(0, Number(process.env.OUT || 3000)));
console.log('--- stderr ---\n' + out.stderr.slice(0, 6000));
if (rep.liveLog) console.log(rep.liveLog.slice(-Number(process.env.LIVE)).join('\n'));
if (rep.trace) console.log(rep.trace.join('\n'));
console.log('--- result ---');
console.log(JSON.stringify({ exit: rep.exit, timedOut: out.timedOut, fatal: out.fatal, workerError: out.workerError, totalMs: out.totalMs, firstStdoutMs: out.firstStdoutMs, liveHandles: rep.liveHandles, loader: rep.loader, usage: rep.usage, net: rep.net && { ...rep.net, requests: rep.net.requests.slice(0, 8) }, cp: rep.childProcess, fsChecks: rep.fsChecks, dirs: rep.dirs, install: rep.installFailures, ses: rep.ses, metrics: process.env.METRICS ? rep.metrics : undefined, mock: mock.log.map((l) => ({ path: l.path, kind: l.kind, step: l.step, agent: l.agentRequest, last: l.lastToolResult })), proxy: proxy.log.length, relay: relay.log.map((l) => ({ ...l })) }, null, 1));
await browser.close();
await Promise.all([mock.close(), stat.close(), proxy.close(), relay.close()]);
