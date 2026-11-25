'use strict';
// Origin B kernel frame (document side). Hosts the kernel worker, the service worker registration,
// the preview iframes and the leader election. Driven by the Playwright runner through window.spike.
const ORIGIN_A = 'http://localhost:8101';
const X = 'http://localhost:8103/hit/';
const spike = (window.spike = { instance: Math.random().toString(36).slice(2, 8), violations: [], portRequests: 0, bcSeen: [] });

document.addEventListener('securitypolicyviolation', (e) => {
  spike.violations.push(`${e.effectiveDirective} blocked ${e.blockedURI}`);
});

// ---------------- kernel worker RPC ----------------
let worker = null;
let seq = 0;
const pending = new Map();
spike.startWorker = () => {
  if (worker) return false;
  worker = new Worker('/kernel-worker.js', { type: 'module', name: 'kernel' });
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.result); else p.reject(new Error(e.data.error));
  };
  worker.onerror = (e) => { spike.workerError = `${e.message} @${e.filename}:${e.lineno}`; };
  return true;
};
spike.stopWorker = () => { if (worker) worker.terminate(); worker = null; };
spike.call = (cmd, args = {}, transfer = []) => {
  spike.startWorker();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, cmd, args }, transfer);
  });
};

// ---------------- bridge: A hands us a MessagePort, we forward it to the worker ----------------
window.addEventListener('message', (e) => {
  if (e.origin === ORIGIN_A && e.data && e.data.type === 'bridge-port') {
    spike.call('bridgePort', {}, [e.ports[0]]);
  } else if (e.data && e.data.type === 'preview-result') {
    const w = previewWaiters.get(e.data.id + ':' + e.data.kind);
    if (w && e.source === w.frame.contentWindow) { previewWaiters.delete(e.data.id + ':' + e.data.kind); w.resolve(e.data); }
  }
});

// ---------------- environment / isolation (document side) ----------------
async function listOpfs() {
  const root = await navigator.storage.getDirectory();
  const names = [];
  for await (const [name, h] of root.entries()) names.push(h.kind === 'directory' ? name + '/' : name);
  return names.sort();
}
spike.docEnv = async () => {
  const out = {
    origin: location.origin,
    crossOriginIsolated: self.crossOriginIsolated,
    isSecureContext: self.isSecureContext,
    typeofSharedArrayBuffer: typeof SharedArrayBuffer,
    ancestorOrigins: Array.from(location.ancestorOrigins || []),
    cookieEnabled: navigator.cookieEnabled,
    sandboxedOriginOpaque: location.origin !== self.origin,
    selfOrigin: self.origin,
  };
  const attempt = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = `throws ${e.name}: ${e.message}`; } };
  await attempt('hasStorageAccess', () => document.hasStorageAccess());
  await attempt('parent.document', () => String(parent.document.title));
  await attempt('parent.indexedDB', () => String(parent.indexedDB));
  await attempt('parent.localStorage', () => String(parent.localStorage.getItem('a-secret')));
  await attempt('parent.navigator.storage', () => String(parent.navigator.storage));
  await attempt('top.location.href', () => String(top.location.href));
  await attempt('parent.A', () => String(parent.A));
  await attempt('ownIndexedDBDatabases', async () => (await indexedDB.databases()).map((d) => d.name));
  await attempt('openA_secret_db', () => new Promise((res) => {
    // opening "a-secret-db" from B just creates/opens B's own (empty) database of that name
    const r = indexedDB.open('a-secret-db');
    r.onsuccess = () => { const names = Array.from(r.result.objectStoreNames); r.result.close(); indexedDB.deleteDatabase('a-secret-db'); res({ objectStores: names }); };
    r.onerror = () => res('error ' + r.error);
  }));
  await attempt('ownOpfsEntries', listOpfs);
  await attempt('ownLocalStorageKeys', () => Object.keys(localStorage));
  await attempt('storageEstimate', () => navigator.storage.estimate());
  await attempt('persisted', () => navigator.storage.persisted());
  return out;
};
spike.persist = async () => {
  const out = {};
  try { out.persistedBefore = await navigator.storage.persisted(); out.persistResult = await navigator.storage.persist(); out.persistedAfter = await navigator.storage.persisted(); } catch (e) { out.error = `${e.name}: ${e.message}`; }
  try { out.permission = (await navigator.permissions.query({ name: 'persistent-storage' })).state; } catch (e) { out.permission = `throws ${e.name}`; }
  return out;
};
spike.writeMarkers = async (tag) => {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle(`b-marker-${tag}.txt`, { create: true });
  const w = await fh.createWritable();
  await w.write('written by ' + tag);
  await w.close();
  localStorage.setItem('b-marker-' + tag, '1');
  await new Promise((res, rej) => {
    const r = indexedDB.open('b-db-' + tag, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => { r.result.close(); res(); };
    r.onerror = () => rej(r.error);
  });
  return spike.listStorage();
};
spike.listStorage = async () => ({
  opfs: await listOpfs(),
  idb: (await indexedDB.databases()).map((d) => d.name).sort(),
  localStorage: Object.keys(localStorage).sort(),
});
spike.sharedWorkerProbe = () => new Promise((res) => {
  if (typeof SharedWorker === 'undefined') { res({ available: false }); return; }
  try {
    const sw = new SharedWorker('/shared-probe.js');
    sw.port.onmessage = (e) => res({ available: true, ...e.data });
    sw.onerror = (e) => res({ available: true, error: e.message || 'error event' });
    setTimeout(() => res({ available: true, error: 'timeout' }), 3000);
  } catch (e) { res({ available: false, error: `${e.name}: ${e.message}` }); }
});

// ---------------- leader election + cross-tab bus ----------------
spike.elect = () => new Promise((res) => {
  navigator.locks.request('kernel-leader', { ifAvailable: true }, (lock) => {
    if (!lock) { res({ leader: false }); return undefined; }
    spike.isLeader = true;
    res({ leader: true });
    return new Promise(() => {}); // hold until this document goes away
  }).catch((e) => res({ error: `${e.name}: ${e.message}` }));
});
spike.follow = () => {
  const t0 = performance.now();
  spike.followState = { waiting: true };
  navigator.locks.request('kernel-leader', () => {
    spike.followState = { waiting: false, acquiredAfterMs: performance.now() - t0, at: Date.now() };
    spike.isLeader = true;
    return new Promise(() => {});
  });
  return true;
};
spike.locksQuery = async () => {
  const q = await navigator.locks.query();
  return { held: q.held.map((l) => l.name), pending: q.pending.map((l) => l.name) };
};
let bus = null;
spike.bcServe = () => {
  bus = new BroadcastChannel('kernel-bus');
  bus.onmessage = (e) => {
    spike.bcSeen.push(e.data);
    if (e.data.type === 'ping') bus.postMessage({ type: 'pong', n: e.data.n, from: spike.instance });
  };
  return true;
};
spike.bcPing = async (n = 300) => {
  const bc = new BroadcastChannel('kernel-bus');
  const once = (i) => new Promise((res) => {
    const t = performance.now();
    const to = setTimeout(() => { bc.onmessage = null; res(null); }, 1500);
    bc.onmessage = (e) => { if (e.data.type === 'pong' && e.data.n === i) { clearTimeout(to); res({ ms: performance.now() - t, from: e.data.from }); } };
    bc.postMessage({ type: 'ping', n: i });
  });
  const first = await once(-1);
  if (!first) { bc.close(); return { works: false }; }
  const lat = [];
  for (let i = 0; i < n; i++) { const r = await once(i); if (r) lat.push(r.ms); }
  bc.close();
  return { works: true, peer: first.from, roundTripMs: stats(lat) };
};

function stats(a) {
  if (!a.length) return null;
  const s = Float64Array.from(a).sort();
  const pick = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: +s[0].toFixed(3), median: +pick(0.5).toFixed(3), p95: +pick(0.95).toFixed(3), p99: +pick(0.99).toFixed(3), max: +s[s.length - 1].toFixed(3), mean: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(3) };
}
spike.stats = stats;

// ---------------- service worker + previews ----------------
const previewWaiters = new Map();
function waitActivated(reg) {
  const sw = reg.installing || reg.waiting || reg.active;
  if (sw.state === 'activated') return Promise.resolve();
  return new Promise((r) => sw.addEventListener('statechange', () => { if (sw.state === 'activated') r(); }));
}
function loadFrame(src, sandbox) {
  return new Promise((res) => {
    const f = document.createElement('iframe');
    if (sandbox != null) f.setAttribute('sandbox', sandbox);
    f.src = src;
    const t0 = performance.now();
    f.onload = () => res({ frame: f, loadMs: performance.now() - t0 });
    document.getElementById('previews').appendChild(f);
  });
}
function peek(f) {
  try { return { title: f.contentDocument.title, text: f.contentDocument.body.textContent.slice(0, 80), href: f.contentWindow.location.href }; } catch (e) { return { unreadable: `${e.name}: ${e.message}` }; }
}
// First-load caveat: open a preview immediately after register(), before the SW is active.
spike.registerSWRacy = async () => {
  const out = {};
  const t0 = performance.now();
  const existing = await navigator.serviceWorker.getRegistration('/preview/');
  out.alreadyRegistered = !!existing;
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/preview/' });
  out.registerMs = +(performance.now() - t0).toFixed(1);
  const sw = reg.installing || reg.waiting || reg.active;
  out.stateRightAfterRegister = sw.state;
  const { frame, loadMs } = await loadFrame('/preview/mc-early/index.html');
  out.earlyPreview = { loadMs: +loadMs.toFixed(1), swStateAtLoad: sw.state, ...peek(frame) };
  frame.remove();
  await waitActivated(reg);
  out.activatedMs = +(performance.now() - t0).toFixed(1);
  out.scope = reg.scope;
  out.kernelPageControlled = !!navigator.serviceWorker.controller;
  spike.reg = reg;
  return out;
};
spike.registerSW = async () => {
  const t0 = performance.now();
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/preview/' });
  await waitActivated(reg);
  spike.reg = reg;
  return { ms: +(performance.now() - t0).toFixed(1), scope: reg.scope, state: reg.active && reg.active.state };
};
async function sendPortToSW() {
  const ch = new MessageChannel();
  await spike.call('previewPort', {}, [ch.port1]);
  spike.reg.active.postMessage({ type: 'kernel-port' }, [ch.port2]);
}
navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'need-port') { spike.portRequests++; sendPortToSW(); }
});
spike.connectPreview = async (opts = {}) => {
  const r = await spike.call('previewInit', opts);
  await sendPortToSW();
  return r;
};
spike.openPreview = async (id, file = 'index.html', opts = {}) => {
  const kind = opts.kind || 'bench';
  const result = new Promise((resolve) => {
    const w = { resolve, frame: null };
    previewWaiters.set(id + ':' + kind, w);
    spike._w = w;
  });
  const p = loadFrame(`/preview/${id}/${file}`, opts.sandbox);
  // the waiter needs the frame before its first message arrives
  const f = document.getElementById('previews').lastElementChild;
  spike._w.frame = f;
  const { loadMs } = await p;
  const r = await Promise.race([result, new Promise((r2) => setTimeout(() => r2({ timeout: true, peek: peek(f) }), opts.timeout || 20000))]);
  if (!opts.keep) f.remove();
  if (r.lat) { r.latencyMs = stats(r.lat); delete r.lat; }
  return { iframeLoadMs: +loadMs.toFixed(1), ...r };
};
spike.baselineFetch = async (n = 300) => {
  const lat = [];
  for (let i = 0; i < n + 5; i++) { const t = performance.now(); const r = await fetch('/hello.json?i=' + i); await r.json(); if (i >= 5) lat.push(performance.now() - t); }
  return stats(lat);
};
spike.swCall = (msg) => new Promise((res) => {
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => res(e.data);
  spike.reg.active.postMessage(msg, [ch.port2]);
  setTimeout(() => res({ timeout: true }), 15000);
});

// ---------------- egress helpers ----------------
function runWorker(w, tag) {
  return new Promise((res) => {
    w.onmessage = (e) => { res(e.data); w.terminate(); };
    w.onerror = (e) => res({ workerError: e.message || 'error event' });
    w.postMessage({ tag });
    setTimeout(() => res({ timeout: true }), 30000);
  });
}
spike.workerEgress = (url, tag) => runWorker(new Worker(url), tag);
spike.blobWorkerEgress = async (tag) => {
  const src = await (await fetch('/egress-worker.js')).text();
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  return runWorker(new Worker(url), tag);
};
spike.docEgress = (tag) => runDocEgress(tag);

// navigation-style egress; "armed" variants run from a real click (user activation)
spike.navAction = (kind, tag) => {
  const url = X + tag + '/' + kind;
  try {
    switch (kind) {
      case 'self-nav': setTimeout(() => { location.href = url + '?d=secret'; }, 0); return 'scheduled';
      case 'top-nav': top.location.href = url; return 'assigned';
      case 'window-open': { const w = window.open(url); return w ? 'opened' : 'returned null'; }
      case 'anchor-blank': { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); return 'clicked'; }
      default: return 'unknown';
    }
  } catch (e) { return `throws ${e.name}: ${e.message}`; }
};
spike.arm = (kind, tag) => { spike.armed = { kind, tag }; spike.armedResult = null; return true; };
document.getElementById('act').addEventListener('click', () => {
  if (spike.armed) spike.armedResult = spike.navAction(spike.armed.kind, spike.armed.tag);
});
