// performance.memory does not exist in workers and measureUserAgentSpecificMemory() needs cross-origin isolation,
// so worker heap is sampled from outside over the DevTools protocol (Runtime.getHeapUsage on the worker target).
import WebSocket from 'ws';
import net from 'node:net';

export const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

export async function connectSampler(port, pageUrlPrefix) {
  let info;
  for (let i = 0; i < 50; i++) { try { info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const pending = new Map(), workers = new Map();
  const send = (method, params = {}, sessionId) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || { error: m.error }); pending.delete(m.id); }
    else if (m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'worker') workers.set(m.params.sessionId, { samples: [] });
    else if (m.method === 'Target.detachedFromTarget') { const w = workers.get(m.params.sessionId); if (w) w.gone = true; }
  });
  const { targetInfos } = await send('Target.getTargets');
  const pageTarget = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(pageUrlPrefix));
  const { sessionId } = await send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  let timer = null;
  return {
    // Sample every worker alive during fn(); returns per-run { peakUsedMB, lastUsedMB, peakTotalMB, samples }.
    async during(fn) {
      workers.clear();
      const tick = async () => { for (const [sid, w] of workers) { if (w.gone) continue; const r = await Promise.race([send('Runtime.getHeapUsage', {}, sid), new Promise((res) => setTimeout(() => res(null), 400))]); if (r && r.usedSize) w.samples.push(r); } };
      let stop = false;
      const loop = (async () => { while (!stop) { await tick(); await new Promise((r) => setTimeout(r, 40)); } })();
      const out = await fn();
      stop = true; await loop;
      const all = [...workers.values()].flatMap((w) => w.samples);
      const mbv = (x) => Math.round((x / 1048576) * 10) / 10;
      return { out, heap: all.length ? { samples: all.length, peakUsedMB: mbv(Math.max(...all.map((s) => s.usedSize))), lastUsedMB: mbv(all.at(-1).usedSize), peakTotalMB: mbv(Math.max(...all.map((s) => s.totalSize))), peakBackingStoreMB: all[0].backingStorageSize != null ? mbv(Math.max(...all.map((s) => s.backingStorageSize))) : null } : null };
    },
    close() { clearInterval(timer); ws.close(); },
  };
}
