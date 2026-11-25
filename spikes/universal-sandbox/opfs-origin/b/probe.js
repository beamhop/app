'use strict';
// Capability probes used to show what each CSP relaxation buys. The runner reloads this page under
// policy variants with one token removed at a time.
window.probe = async () => {
  const out = {};
  const T = (p, ms = 2000) => Promise.race([p, new Promise((r) => setTimeout(() => r('blocked: timeout'), ms))]);
  const rec = async (name, fn) => { try { out[name] = await T(fn()); } catch (e) { out[name] = 'blocked: ' + e.name; } };
  const workerSrc = "self.onmessage=()=>{const o={};try{new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));o.wasm='ok'}catch(e){o.wasm='blocked: '+e.name}try{o.eval='ok '+(0,eval)('1+1')}catch(e){o.eval='blocked: '+e.name}postMessage(o)}";
  const runW = (url) => new Promise((res) => { const w = new Worker(url); w.onmessage = (e) => res(e.data); w.onerror = () => res('blocked: error event'); w.postMessage(1); });

  await rec('doc.wasmCompile', async () => { new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); return 'ok'; });
  await rec('doc.eval', async () => 'ok ' + (0, eval)('1+1'));
  await rec('doc.newFunction', async () => 'ok ' + new Function('return 2')());
  await rec('worker(self)', async () => { const r = await runW('/probe-worker.js'); return typeof r === 'string' ? r : 'ok'; });
  await rec('worker(self).wasm', async () => (await runW('/probe-worker.js')).wasm || 'blocked');
  await rec('worker(self).eval', async () => (await runW('/probe-worker.js')).eval || 'blocked');
  const blobUrl = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
  await rec('worker(blob:)', async () => { const r = await runW(blobUrl); return typeof r === 'string' ? r : 'ok'; });
  await rec('worker(blob:).wasm', async () => (await runW(blobUrl)).wasm || 'blocked');
  await rec('worker(blob:).eval', async () => (await runW(blobUrl)).eval || 'blocked');
  await rec('import(blob:)', async () => { const u = URL.createObjectURL(new Blob(['export const x = 41 + 1;'], { type: 'text/javascript' })); return 'ok ' + (await import(u)).x; });
  await rec('script src=blob:', () => new Promise((res) => { const s = document.createElement('script'); s.src = URL.createObjectURL(new Blob(['window.__blobScript = 1;'], { type: 'text/javascript' })); s.onload = () => res('ok'); s.onerror = () => res('blocked: error event'); document.head.appendChild(s); }));
  await rec('inline <script>', async () => { const s = document.createElement('script'); s.textContent = 'window.__inlineScript = 1;'; document.head.appendChild(s); return window.__inlineScript ? 'ok' : 'blocked'; });
  await rec('inline style attr', async () => { const d = document.createElement('div'); d.setAttribute('style', 'width:37px'); document.body.appendChild(d); return getComputedStyle(d).width === '37px' ? 'ok' : 'blocked'; });
  await rec('<style> element', async () => { const s = document.createElement('style'); s.textContent = '#probe-x{width:41px}'; document.head.appendChild(s); const d = document.createElement('div'); d.id = 'probe-x'; document.body.appendChild(d); return getComputedStyle(d).width === '41px' ? 'ok' : 'blocked'; });
  const img = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res('ok'); i.onerror = () => res('blocked: error event'); i.src = src; });
  const gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  await rec('img data:', () => img('data:image/gif;base64,' + gif));
  await rec('img blob:', () => img(URL.createObjectURL(new Blob([Uint8Array.from(atob(gif), (c) => c.charCodeAt(0))], { type: 'image/gif' }))));
  await rec('fetch(self)', async () => 'ok ' + (await fetch('/hello.json')).status);
  await rec('fetch(blob:)', async () => 'ok ' + (await (await fetch(URL.createObjectURL(new Blob(['x'])))).text()));
  const frame = (src) => new Promise((res) => {
    const f = document.createElement('iframe'); f.src = src;
    f.onload = () => { let r; try { r = f.contentDocument && f.contentDocument.body && f.contentDocument.body.textContent.includes('static file') ? 'ok' : (f.contentDocument && f.contentDocument.body && f.contentDocument.body.textContent.includes('blobframe') ? 'ok' : 'blocked: empty/err doc'); } catch (e) { r = 'blocked: ' + e.name; } res(r); };
    document.body.appendChild(f);
  });
  await rec('iframe(self)', () => frame('/hello.json'));
  await rec('iframe(blob:)', () => frame(URL.createObjectURL(new Blob(['<!doctype html><body>blobframe</body>'], { type: 'text/html' }))));
  await rec('serviceWorker.register', async () => { const r = await navigator.serviceWorker.register('/sw.js', { scope: '/preview/' }); return 'ok ' + r.scope; });
  await rec('opfs.getDirectory', async () => { await navigator.storage.getDirectory(); return 'ok'; });
  return out;
};
