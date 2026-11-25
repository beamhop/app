// Static file server for dist/web. Deliberately sends NO COOP/COEP headers (no cross-origin isolation).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.img': 'application/octet-stream', '.wasm': 'application/wasm' };
export function startStatic({ dir, port = 0 }) {
  const log = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const file = path.join(dir, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
    const headers = { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' };
    // Pre-gzipped images are served with Content-Encoding like a static host would.
    const gz = file + '.gz';
    if (fs.existsSync(gz) && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && !url.searchParams.has('raw')) {
      headers['content-encoding'] = 'gzip'; headers['content-length'] = fs.statSync(gz).size;
      log.push({ path: url.pathname, bytesOnWire: fs.statSync(gz).size, encoding: 'gzip' });
      res.writeHead(200, headers); return fs.createReadStream(gz).pipe(res);
    }
    headers['content-length'] = fs.statSync(file).size;
    log.push({ path: url.pathname, bytesOnWire: fs.statSync(file).size });
    res.writeHead(200, headers); fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ port: server.address().port, log, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) })));
}
