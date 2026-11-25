// Blind tunnel mode: WebSocket-to-TCP relay. One WebSocket = one TCP connection to ?host=&port=. The relay copies
// bytes both ways and never parses them (with TLS inside the worker it could not read them either).
import { WebSocketServer } from 'ws';
import net from 'node:net';

export function startRelay({ port = 0, allow = () => true } = {}) {
  const log = [];
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const host = url.searchParams.get('host'), dport = Number(url.searchParams.get('port'));
    const entry = { host, port: dport, bytesUp: 0, bytesDown: 0, t: Date.now(), firstBytesUp: null };
    log.push(entry);
    if (!allow(host, dport)) { entry.denied = true; return ws.close(1008, 'destination not allowed'); }
    const sock = net.connect({ host, port: dport });
    const pending = [];
    sock.on('connect', () => { for (const b of pending.splice(0)) sock.write(b); });
    ws.on('message', (data) => { entry.bytesUp += data.length; entry.firstBytesUp ??= data.subarray(0, 60).toString('latin1'); if (sock.connecting) pending.push(data); else sock.write(data); });
    sock.on('data', (d) => { entry.bytesDown += d.length; if (ws.readyState === 1) ws.send(d); });
    sock.on('end', () => ws.close(1000));
    sock.on('error', (e) => { entry.error = e.message; ws.close(1011, e.message.slice(0, 100)); });
    ws.on('close', () => { entry.ms = Date.now() - entry.t; sock.destroy(); });
    ws.on('error', () => sock.destroy());
  });
  return new Promise((resolve) => wss.on('listening', () => resolve({ port: wss.address().port, log, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }) })));
}
