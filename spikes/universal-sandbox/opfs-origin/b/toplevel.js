'use strict';
// B visited as a top-level page: the first-party storage bucket of B, which should be a different
// partition from B-embedded-in-A.
const T = (window.T = { bcSeen: [] });
T.list = async () => {
  const root = await navigator.storage.getDirectory();
  const opfs = [];
  for await (const [name, h] of root.entries()) opfs.push(h.kind === 'directory' ? name + '/' : name);
  const regs = await navigator.serviceWorker.getRegistrations();
  return { opfs: opfs.sort(), idb: (await indexedDB.databases()).map((d) => d.name).sort(), localStorage: Object.keys(localStorage).sort(), serviceWorkerScopes: regs.map((r) => r.scope) };
};
T.writeMarker = async () => {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle('b-marker-toplevel.txt', { create: true });
  const w = await fh.createWritable(); await w.write('toplevel'); await w.close();
  localStorage.setItem('b-marker-toplevel', '1');
  return T.list();
};
T.tryLock = () => new Promise((res) => {
  navigator.locks.request('kernel-leader', { ifAvailable: true }, (lock) => { res({ acquired: !!lock }); });
});
T.bcListen = () => { const bc = new BroadcastChannel('kernel-bus'); bc.onmessage = (e) => T.bcSeen.push(e.data); return true; };
