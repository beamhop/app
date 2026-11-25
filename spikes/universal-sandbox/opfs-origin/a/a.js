'use strict';
// Origin A: the trusted app. Embeds the kernel iframe from origin B and talks to it only via postMessage.
const B = 'http://127.0.0.1:8102';
const q = new URLSearchParams(location.search);

const A = (window.A = {});

A.mountKernel = (opts = {}) => new Promise((resolve) => {
  const f = document.createElement('iframe');
  f.id = 'kernel';
  f.width = 600; f.height = 200;
  const sandbox = opts.sandbox ?? q.get('sandbox');
  if (sandbox) f.setAttribute('sandbox', sandbox);
  const allow = opts.allow ?? q.get('allow');
  if (allow) f.setAttribute('allow', allow);
  f.src = B + (opts.path || q.get('path') || '/kernel.html');
  f.addEventListener('load', () => resolve(true), { once: true });
  document.getElementById('host').appendChild(f);
  A.frame = f;
});

// Markers in A's own storage that B must not be able to see.
A.writeMarkers = async () => {
  await new Promise((res, rej) => {
    const r = indexedDB.open('a-secret-db', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => {
      const tx = r.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put('A-PRIVATE-KEY-MARKER', 'marker');
      tx.oncomplete = () => { r.result.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
    r.onerror = () => rej(r.error);
  });
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle('a-secret-marker.txt', { create: true });
  const w = await fh.createWritable();
  await w.write('A-PRIVATE-KEY-MARKER');
  await w.close();
  localStorage.setItem('a-secret', 'A-PRIVATE-KEY-MARKER');
  const names = [];
  for await (const [name] of root.entries()) names.push(name);
  return { idb: (await indexedDB.databases()).map((d) => d.name), opfs: names };
};

// Can A reach into the cross-origin frame?
A.probeFrame = () => {
  const f = A.frame;
  const out = {};
  const attempt = (name, fn) => { try { out[name] = { ok: true, value: String(fn()) }; } catch (e) { out[name] = { ok: false, error: `${e.name}: ${e.message}` }; } };
  out.contentDocument = f.contentDocument === null ? 'null' : 'accessible';
  attempt('contentWindow.document', () => f.contentWindow.document.title);
  attempt('contentWindow.location.href', () => f.contentWindow.location.href);
  attempt('contentWindow.spike', () => f.contentWindow.spike);
  attempt('contentWindow.indexedDB', () => f.contentWindow.indexedDB);
  attempt('contentWindow.navigator', () => f.contentWindow.navigator.storage);
  return out;
};

// ---- message bridge: A page <-> B kernel worker over a transferred MessagePort ----
A.connectBridge = () => new Promise((resolve) => {
  const ch = new MessageChannel();
  A.port = ch.port1;
  A.pending = new Map();
  A.port.onmessage = (e) => {
    if (e.data.type === 'bridge-ready') { resolve(true); return; }
    const p = A.pending.get(e.data.id);
    if (p) { A.pending.delete(e.data.id); p(e.data); }
  };
  // targetOrigin pinned to B; the port is transferred, so only the kernel can use the other end
  A.frame.contentWindow.postMessage({ type: 'bridge-port' }, B, [ch.port2]);
});

A.rpc = (payload, transfer) => new Promise((resolve) => {
  const id = (A.nextId = (A.nextId || 0) + 1);
  A.pending.set(id, resolve);
  A.port.postMessage({ id, ...payload }, transfer || []);
});

function stats(a) {
  const s = Float64Array.from(a).sort();
  const pick = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: +s[0].toFixed(3), median: +pick(0.5).toFixed(3), p95: +pick(0.95).toFixed(3), p99: +pick(0.99).toFixed(3), max: +s[s.length - 1].toFixed(3), mean: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(3) };
}

A.benchBridge = async () => {
  const out = {};
  for (let i = 0; i < 200; i++) await A.rpc({ op: 'echo', v: i }); // warm-up
  let lat = [];
  let T0 = performance.now();
  for (let i = 0; i < 5000; i++) { const t = performance.now(); await A.rpc({ op: 'echo', v: i }); lat.push(performance.now() - t); }
  out.smallMs = stats(lat);
  // the clock here ticks in 0.1 ms steps, so also report total time / calls
  out.smallAvgMicroseconds = Math.round((performance.now() - T0) / 5000 * 1000);
  // 1 MB ArrayBuffer transferred A -> worker and transferred back
  lat = [];
  let buf = new ArrayBuffer(1 << 20);
  new Uint8Array(buf).fill(7);
  for (let i = 0; i < 20; i++) buf = (await A.rpc({ op: 'echo', buf }, [buf])).buf;
  T0 = performance.now();
  for (let i = 0; i < 1000; i++) { const t = performance.now(); buf = (await A.rpc({ op: 'echo', buf }, [buf])).buf; lat.push(performance.now() - t); }
  out.transfer1MBMs = stats(lat);
  out.transfer1MBAvgMicroseconds = Math.round((performance.now() - T0) / 1000 * 1000);
  out.transfer1MBIntact = buf.byteLength === 1 << 20 && new Uint8Array(buf)[12345] === 7;
  // 1 MB structured-cloned (copied) both ways, for comparison
  lat = [];
  for (let i = 0; i < 300; i++) { const t = performance.now(); await A.rpc({ op: 'echo', buf }); lat.push(performance.now() - t); }
  out.copy1MBMs = stats(lat);
  // throughput with 32 calls in flight (pipelined)
  const t0 = performance.now();
  const N = 20000;
  let done = 0;
  await new Promise((res) => {
    let sent = 0;
    const pump = () => { while (sent < N && sent - done < 32) { sent++; A.rpc({ op: 'echo' }).then(() => { done++; if (done === N) res(); else pump(); }); } };
    pump();
  });
  out.pipelinedRpcPerSec = Math.round(N / ((performance.now() - t0) / 1000));
  return out;
};

A.kernelReady = new Promise((resolve) => {
  window.addEventListener('message', (e) => { if (e.origin === B && e.data && e.data.type === 'kernel-ready') resolve(true); });
});
// ask the kernel frame to attempt a navigation-style egress; no user activation is transferred
A.sendNav = (kind, tag) => A.frame.contentWindow.postMessage({ type: 'nav-action', kind, tag }, B);

if (!q.has('manual')) A.ready = A.mountKernel();
