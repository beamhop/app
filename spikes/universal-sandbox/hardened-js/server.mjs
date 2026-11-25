// Tiny static server. `?csp=<policy>` on any URL sets a Content-Security-Policy header on
// that response (page and worker script each carry their own), `?coi=1` adds COOP/COEP.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm' };

export function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const rel = path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, '');
    if (!/^(src|dist)[/\\]/.test(rel)) { res.writeHead(404).end('not found'); return; }
    const file = path.join(root, rel);
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': rel.startsWith('dist') ? 'max-age=3600' : 'no-cache' };
      if (u.searchParams.get('csp')) headers['content-security-policy'] = u.searchParams.get('csp');
      if (u.searchParams.get('coi')) { headers['cross-origin-opener-policy'] = 'same-origin'; headers['cross-origin-embedder-policy'] = 'require-corp'; }
      headers['cross-origin-resource-policy'] = 'same-origin';
      res.writeHead(200, headers).end(buf);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startServer(Number(process.env.PORT) || 8787);
  console.log('serving', url + '/src/page.html');
}
