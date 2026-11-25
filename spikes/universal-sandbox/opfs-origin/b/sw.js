'use strict';
// Service worker on origin B, scope /preview/. It answers preview requests with content obtained
// from the kernel worker, over a MessagePort (ids starting "mc") or a BroadcastChannel (ids starting "bc").
const inst = Math.random().toString(36).slice(2, 8);
let port = null;
let portWaiters = [];
let nextId = 1;
let cspPromise = null;
let handled = 0;
const pending = new Map();
const settle = (d) => { const p = pending.get(d.id); if (p) { pending.delete(d.id); p(d); } };
const bc = new BroadcastChannel('preview-rpc');
bc.onmessage = (e) => { if (e.data.dir === 'res') settle(e.data); };

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'kernel-port') {
    port = e.ports[0];
    port.onmessage = (ev) => settle(ev.data);
    portWaiters.splice(0).forEach((r) => r());
  } else if (d.type === 'egress') {
    e.waitUntil(egress(d.tag).then((r) => e.ports[0].postMessage(r)));
  } else if (d.type === 'stats') {
    e.ports[0].postMessage({ inst, handled, hasPort: !!port });
  }
});

const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + what)), ms))]);

async function getPort() {
  if (port) return;
  // The SW was restarted (or never given a port): ask the kernel frame for a new one.
  const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const kernels = cs.filter((c) => new URL(c.url).pathname === '/kernel.html');
  if (!kernels.length) throw new Error('no kernel client found');
  const got = new Promise((r) => portWaiters.push(r));
  for (const c of kernels) c.postMessage({ type: 'need-port' });
  await timeout(got, 3000, 'kernel port');
}
function getCsp() {
  if (!cspPromise) cspPromise = fetch('/__csp').then((r) => r.json()).then((j) => j.csp);
  return cspPromise;
}
async function ask(req, useBC) {
  const msg = { dir: 'req', id: inst + ':' + nextId++, url: req.url, method: req.method };
  const reply = new Promise((r) => pending.set(msg.id, r));
  if (useBC) bc.postMessage(msg); else { await getPort(); port.postMessage(msg); }
  return timeout(reply, 4000, 'kernel reply');
}
async function handle(req, u) {
  handled++;
  const id = u.pathname.split('/')[2] || '';
  const useBC = id.startsWith('bc');
  try {
    let r;
    try { r = await ask(req, useBC); } catch (e) {
      if (useBC) throw e;
      port = null; // stale port (kernel worker restarted): re-handshake once
      r = await ask(req, false);
    }
    const headers = { 'content-type': r.contentType, 'cache-control': 'no-store', 'x-served-by': 'sw-' + inst };
    // A response synthesized by the SW has ONLY the headers set here. A preview document gets no CSP
    // unless the SW adds one.
    if (!id.includes('nocsp')) headers['content-security-policy'] = (await getCsp()) + (id.includes('cspsandbox') ? '; sandbox allow-scripts allow-same-origin' : '');
    return new Response(r.body, { status: r.status, headers });
  } catch (e) {
    return new Response('preview error: ' + e.message, { status: 503, headers: { 'content-type': 'text/plain' } });
  }
}
self.addEventListener('fetch', (event) => {
  const u = new URL(event.request.url);
  if (u.origin !== self.location.origin || !u.pathname.startsWith('/preview/')) return; // let the network handle it
  event.respondWith(handle(event.request, u));
});

async function egress(tag) {
  const X = 'http://localhost:8103/hit/' + tag + '/';
  const out = {};
  const rec = async (name, fn) => { try { out[name] = await timeout(fn(), 2500, name); } catch (e) { out[name] = `throws ${e.name}: ${e.message}`.slice(0, 160); } };
  await rec('fetch', async () => { const r = await fetch(X + 'fetch?d=secret'); return 'ok status ' + r.status; });
  await rec('fetch-nocors', async () => { await fetch(X + 'fetch-nocors', { mode: 'no-cors', method: 'POST', body: 'secret' }); return 'ok (opaque)'; });
  await rec('websocket', () => new Promise((res) => {
    const ws = new WebSocket('ws://localhost:8103/hit/' + tag + '/websocket');
    ws.onopen = () => { res('open'); ws.close(); };
    ws.onerror = () => res('error event');
  }));
  await rec('importScripts', async () => { importScripts(X + 'importscripts'); return 'imported'; });
  return { out };
}
