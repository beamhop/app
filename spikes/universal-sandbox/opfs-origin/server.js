'use strict';
// Three local servers for the spike:
//   A        http://localhost:8101   trusted app origin (static, no COOP/COEP)
//   B        http://127.0.0.1:8102   sandbox kernel origin (static, strict CSP, no COOP/COEP)
//   attacker http://localhost:8103   logs every HTTP request, WS upgrade, TCP connection and UDP datagram
// A and B are cross-site (localhost vs 127.0.0.1). All three are "potentially trustworthy" origins.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');

const PORT_A = 8101;
const PORT_B = 8102;
const PORT_X = 8103;
const ORIGIN_A = `http://localhost:${PORT_A}`;
const ORIGIN_B = `http://127.0.0.1:${PORT_B}`;
const ORIGIN_X = `http://localhost:${PORT_X}`;

const DEFAULT_B_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  `frame-ancestors ${ORIGIN_A}`,
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
  '.txt': 'text/plain',
};

const SQLITE_DIST = path.join(__dirname, 'node_modules', '@sqlite.org', 'sqlite-wasm', 'dist');

function sendFile(res, file, headers) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { ...headers, 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      ...headers,
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'content-length': buf.length,
    });
    res.end(buf);
  });
}

function safeJoin(root, p) {
  const f = path.normalize(path.join(root, p));
  return f.startsWith(root) ? f : null;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
}

async function start() {
  const state = { bCsp: DEFAULT_B_CSP, attackerLog: [], tcpConnections: 0 };

  // ---------- A ----------
  const a = http.createServer((req, res) => {
    const u = new URL(req.url, ORIGIN_A);
    const headers = { 'cache-control': 'no-store' };
    // optional A-side mitigation: restrict where A's frames may navigate
    if (u.searchParams.get('acsp') === '1') {
      headers['content-security-policy'] = `frame-src ${ORIGIN_B}`;
    }
    const p = u.pathname === '/' ? '/index.html' : u.pathname;
    const f = safeJoin(path.join(__dirname, 'a'), p);
    if (!f) { res.writeHead(400); res.end(); return; }
    sendFile(res, f, headers);
  });

  // ---------- B ----------
  const b = http.createServer((req, res) => {
    const u = new URL(req.url, ORIGIN_B);
    let p = u.pathname;
    const headers = {};
    let noCsp = false;
    if (p.startsWith('/nocsp/')) { noCsp = true; p = p.slice('/nocsp'.length); }
    if (!noCsp) headers['content-security-policy'] = state.bCsp;
    if (p === '/__csp') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ csp: state.bCsp }));
      return;
    }
    let f;
    if (p.startsWith('/vendor/sqlite/')) {
      headers['cache-control'] = 'public, max-age=3600';
      f = safeJoin(SQLITE_DIST, p.slice('/vendor/sqlite'.length));
    } else {
      headers['cache-control'] = 'no-cache';
      f = safeJoin(path.join(__dirname, 'b'), p === '/' ? '/kernel.html' : p);
    }
    if (!f) { res.writeHead(400, headers); res.end(); return; }
    sendFile(res, f, headers);
  });

  // ---------- attacker ----------
  const log = (e) => state.attackerLog.push({ t: Date.now(), ...e });
  const x = http.createServer((req, res) => {
    const u = new URL(req.url, ORIGIN_X);
    if (u.pathname !== '/embed.html' && u.pathname !== '/favicon.ico') {
      log({ kind: 'http', method: req.method, url: req.url, origin: req.headers.origin || null, referer: req.headers.referer || null, dest: req.headers['sec-fetch-dest'] || null });
    }
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'cache-control': 'no-store' };
    if (u.pathname === '/embed.html') {
      // an unrelated site trying to embed the kernel origin (frame-ancestors test)
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><title>attacker embedder</title><iframe id="k" src="${ORIGIN_B}/kernel.html"></iframe>`);
      return;
    }
    if (u.pathname.endsWith('/import')) { res.writeHead(200, { ...cors, 'content-type': 'text/javascript' }); res.end('globalThis.__attackerScriptRan = 1; export {};'); return; }
    if (u.pathname.endsWith('.js') || u.pathname.endsWith('/importscripts') || u.pathname.endsWith('/script')) {
      res.writeHead(200, { ...cors, 'content-type': 'text/javascript' });
      res.end('globalThis.__attackerScriptRan = 1;');
      return;
    }
    if (u.pathname.endsWith('/image') || u.pathname.endsWith('/css-bg')) {
      res.writeHead(200, { ...cors, 'content-type': 'image/gif' });
      res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
      return;
    }
    if (u.pathname.endsWith('/css')) { res.writeHead(200, { ...cors, 'content-type': 'text/css' }); res.end('body{}'); return; }
    if (u.pathname.endsWith('/sse')) { res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' }); res.end('data: hi\n\n'); return; }
    res.writeHead(200, { ...cors, 'content-type': 'text/html' });
    res.end('<!doctype html><title>attacker</title>attacker got it');
  });
  x.on('connection', () => { state.tcpConnections++; });
  x.on('upgrade', (req, socket) => {
    log({ kind: 'ws-upgrade', method: req.method, url: req.url, origin: req.headers.origin || null });
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    setTimeout(() => socket.destroy(), 200);
  });
  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, rinfo) => log({ kind: 'udp', bytes: msg.length, from: `${rinfo.address}:${rinfo.port}`, stun: msg.length >= 20 && msg.readUInt32BE(4) === 0x2112a442 }));
  await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(PORT_X, '0.0.0.0', resolve); });

  await listen(a, PORT_A);       // all interfaces: "localhost" may resolve to ::1 or 127.0.0.1
  await listen(b, PORT_B, '127.0.0.1');
  await listen(x, PORT_X);

  return {
    state,
    ORIGIN_A, ORIGIN_B, ORIGIN_X, DEFAULT_B_CSP, SQLITE_DIST,
    setBCsp(csp) { state.bCsp = csp || DEFAULT_B_CSP; },
    async close() {
      for (const s of [a, b, x]) { s.closeAllConnections && s.closeAllConnections(); s.close(); }
      udp.close();
    },
  };
}

module.exports = { start, ORIGIN_A, ORIGIN_B, ORIGIN_X, DEFAULT_B_CSP };

if (require.main === module) {
  start().then((s) => {
    console.log(`A        ${ORIGIN_A}/index.html`);
    console.log(`B        ${ORIGIN_B}/kernel.html (CSP: ${s.state.bCsp})`);
    console.log(`attacker ${ORIGIN_X}`);
    setInterval(() => {
      while (s.state.attackerLog.length) console.log('[attacker]', JSON.stringify(s.state.attackerLog.shift()));
    }, 500);
  });
}
