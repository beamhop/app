// Plain-mode network proxy: a CORS proxy. The worker calls
//   <METHOD> /fetch?url=<absolute url>     with the real request headers JSON-encoded in x-sandbox-headers
// (browsers refuse to set user-agent, host, cookie, ... directly) and the proxy replays the request and streams the
// response back with permissive CORS headers. It sees plaintext, so this is the "trusted proxy" mode.
import http from 'node:http';
import https from 'node:https';

export function startCorsProxy({ port = 0, allow = () => true } = {}) {
  const log = [], denied = [];
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*', 'access-control-max-age': '600' };
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__log') { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); return res.end(JSON.stringify(log)); }
    if (url.pathname !== '/fetch') { res.writeHead(404, cors); return res.end('no such route'); }
    let target;
    try { target = new URL(url.searchParams.get('url')); } catch { res.writeHead(400, cors); return res.end('bad url'); }
    if (!allow(target)) { denied.push(req.method + ' ' + target.origin + target.pathname); res.writeHead(403, cors); return res.end('destination not allowed'); }
    let headers = {};
    try { for (const [k, v] of JSON.parse(req.headers['x-sandbox-headers'] || '[]')) headers[k] = k in headers ? [].concat(headers[k], v) : v; } catch {}
    if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
    headers['accept-encoding'] = 'identity'; // the worker has no brotli/zstd decoder
    const entry = { method: req.method, url: target.href, t: Date.now(), bytesUp: 0, bytesDown: 0, chunksDown: 0 };
    log.push(entry);
    const up = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers }, (upRes) => {
      entry.status = upRes.statusCode;
      const out = { ...cors };
      for (const [k, v] of Object.entries(upRes.headers)) { if (['connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(k)) continue; out[k] = v; }
      out['cache-control'] = 'no-store'; out['x-accel-buffering'] = 'no';
      res.writeHead(upRes.statusCode, upRes.statusMessage, out);
      res.flushHeaders();
      upRes.on('data', (c) => { entry.bytesDown += c.length; entry.chunksDown++; res.write(c); });
      upRes.on('end', () => { entry.ms = Date.now() - entry.t; res.end(); });
      upRes.on('error', () => res.destroy());
    });
    up.on('error', (e) => { entry.error = e.message; if (!res.headersSent) res.writeHead(502, { ...cors, 'content-type': 'text/plain' }); res.end('proxy upstream error: ' + e.message); });
    req.on('data', (c) => { entry.bytesUp += c.length; up.write(c); });
    req.on('end', () => up.end());
    res.on('close', () => { if (!res.writableEnded) up.destroy(); });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, log, denied, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) })));
}
