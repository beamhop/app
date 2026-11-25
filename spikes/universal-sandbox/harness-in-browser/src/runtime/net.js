// Networking. Browsers cannot open sockets, so everything leaves through a proxy we control:
//
//   mode 'bridge' (plain CORS proxy): net.Socket / tls.connect do not carry bytes to the destination. The socket
//       parses the HTTP/1.1 request the harness writes, replays it with the browser's fetch() against the CORS
//       proxy, and feeds a synthesized HTTP/1.1 (chunked) response back into the socket as the body streams in.
//       Any Node HTTP client that speaks HTTP/1.1 over net/tls (undici, node:http emulation) works unchanged; the
//       proxy sees plaintext.
//   mode 'tunnel' (blind relay): net.Socket is a byte pipe over a WebSocket-to-TCP relay. The HTTP/1.1 bytes
//       written by the harness's own HTTP client reach the destination verbatim. TLS would have to be done
//       inside the worker (not implemented; tls.connect fails in this mode).
import { Buffer } from 'buffer';

const CRLF = '\r\n';
const HOP = new Set(['content-length', 'transfer-encoding', 'content-encoding', 'connection', 'keep-alive']);

export function createNet({ EventEmitter, stream, process, track, host, config }) {
  const netCfg = config.net || { mode: 'none' };
  const log = { mode: netCfg.mode, sockets: 0, tlsSockets: 0, bridgeRequests: 0, tunnelConnections: 0, bytesOut: 0, bytesIn: 0, requests: [], hostFetches: 0 };

  // ---- the only two primitives that actually leave the worker ----
  const proxiedFetch = (url, { method = 'GET', headers = [], body, signal } = {}) => {
    log.hostFetches++;
    const hasBody = body != null && !['GET', 'HEAD'].includes(method.toUpperCase());
    return host.fetch(netCfg.proxyUrl + '/fetch?url=' + encodeURIComponent(url), {
      method, signal, cache: 'no-store',
      headers: { 'x-sandbox-headers': JSON.stringify(headers) },
      body: hasBody ? body : undefined,
    });
  };
  const openTunnel = (hostName, port) => {
    log.tunnelConnections++;
    const ws = new host.WebSocket(netCfg.relayUrl + '/?host=' + encodeURIComponent(hostName) + '&port=' + port);
    ws.binaryType = 'arraybuffer';
    return ws;
  };

  // ---------------- net.Socket ----------------
  class Socket extends stream.Duplex {
    constructor(opts = {}) {
      super({ allowHalfOpen: opts.allowHalfOpen ?? false, emitClose: true });
      this.connecting = false; this.pending = true; this.remoteAddress = undefined; this.remotePort = undefined; this.remoteFamily = 'IPv4';
      this.localAddress = '127.0.0.1'; this.localPort = 0; this.bytesRead = 0; this.bytesWritten = 0; this.timeout = 0;
      this._secure = !!opts.__secure; this._refed = false; this._ws = null; this._bridge = null; this._timer = null; this._servername = opts.servername;
      this.encrypted = this._secure || undefined; this.authorized = this._secure; this.alpnProtocol = false;
      log.sockets++;
    }
    _ref() { if (!this._refed && this._wantRef !== false) { this._refed = true; process.__ref(); } }
    _unrefHandle() { if (this._refed) { this._refed = false; process.__unref(); } }
    ref() { track('socket.ref'); this._wantRef = true; if (!this.destroyed && (this.connecting || !this.pending)) this._ref(); return this; }
    unref() { track('socket.unref', (new Error().stack||'').split('\n').slice(2,6).join(' | ')); this._wantRef = false; this._unrefHandle(); return this; }
    connect(...args) {
      let opts = {}, cb;
      if (typeof args[args.length - 1] === 'function') cb = args.pop();
      if (args[0] && typeof args[0] === 'object') opts = args[0]; else { opts.port = args[0]; opts.host = args[1]; }
      if (opts.path) { track('net.connect(unix socket)', opts.path); queueMicrotask(() => this.destroy(Object.assign(new Error('connect ENOENT ' + opts.path), { code: 'ENOENT', syscall: 'connect' }))); return this; }
      const hostName = opts.host || opts.hostname || 'localhost', port = Number(opts.port);
      this.remoteAddress = hostName; this.remotePort = port; this.connecting = true; this._host = hostName;
      if (cb) this.once(this._secure ? 'secureConnect' : 'connect', cb);
      this._ref();
      const connected = () => {
        if (this.destroyed) return;
        this.connecting = false; this.pending = false; this.readyState = 'open';
        this.emit('connect'); this.emit('ready');
        if (this._secure) this.emit('secureConnect');
        if (this._connectCb) { const f = this._connectCb; this._connectCb = null; f(); }
      };
      if (netCfg.mode === 'tunnel') {
        if (this._secure) { track('tls.connect in tunnel mode (no in-worker TLS)', hostName + ':' + port); queueMicrotask(() => this.destroy(Object.assign(new Error('TLS over the blind tunnel is not implemented in this spike'), { code: 'ERR_TLS_NOT_AVAILABLE' }))); return this; }
        const ws = (this._ws = openTunnel(hostName, port));
        ws.onopen = connected;
        ws.onmessage = (ev) => { const b = Buffer.from(ev.data); this.bytesRead += b.length; log.bytesIn += b.length; this._touch(); this.push(b); };
        ws.onerror = () => { if (!this.destroyed) this.destroy(Object.assign(new Error(`connect ECONNREFUSED ${hostName}:${port}`), { code: 'ECONNREFUSED', syscall: 'connect', address: hostName, port })); };
        ws.onclose = (ev) => { if (this.destroyed) return; if (this.connecting) return ws.onerror(); this.push(null); if (!this.allowHalfOpen) this.end(); this._unrefHandle(); };
      } else if (netCfg.mode === 'bridge') {
        this._bridge = new HttpBridge(this, (this._secure ? 'https' : 'http'), hostName, port);
        queueMicrotask(connected);
      } else {
        track('net.connect with networking disabled', hostName + ':' + port);
        queueMicrotask(() => this.destroy(Object.assign(new Error(`connect ENETUNREACH ${hostName}:${port}`), { code: 'ENETUNREACH', syscall: 'connect' })));
      }
      return this;
    }
    _touch() { if (this.timeout) { host.clearTimeout(this._timer); this._timer = host.setTimeout(() => this.emit('timeout'), this.timeout); } }
    _read() {}
    _write(chunk, enc, cb) {
      const doWrite = () => {
        const b = typeof chunk === 'string' ? Buffer.from(chunk, enc) : chunk;
        this.bytesWritten += b.length; log.bytesOut += b.length; this._touch();
        try { if (this._ws) this._ws.send(b); else if (this._bridge) this._bridge.write(b); cb(); } catch (e) { cb(e); }
      };
      if (this.connecting) this._connectCb = doWrite; else doWrite();
    }
    _final(cb) { if (this._ws && this._ws.readyState <= 1) { /* TCP half-close is not expressible over WebSocket; keep reading */ } cb(); }
    _destroy(err, cb) {
      track('socket.destroy', String(err && (err.stack || err.message)).slice(0, 3000).replace(/file:\/\/\/opt\/pi\/node_modules\/@earendil-works\/pi-coding-agent\/dist\/bundle\/chunks\//g, "") + " @ " + (new Error().stack || '').split('\n').slice(2, 9).map((l) => l.trim().slice(0, 100)).join(' | '));
      host.clearTimeout(this._timer);
      if (this._ws) { try { this._ws.onclose = null; this._ws.close(); } catch {} }
      if (this._bridge) this._bridge.destroy();
      this._unrefHandle();
      cb(err);
    }
    setTimeout(ms, cb) { this.timeout = ms; host.clearTimeout(this._timer); if (ms) { this._touch(); if (cb) this.once('timeout', cb); } return this; }
    setNoDelay() { return this; } setKeepAlive() { return this; }
    address() { return { address: this.localAddress, family: 'IPv4', port: this.localPort }; }
    get readyState_() { return this.connecting ? 'opening' : 'open'; }
    getPeerCertificate() { return {}; } getProtocol() { return 'TLSv1.3'; } getCipher() { return { name: 'TLS_AES_128_GCM_SHA256', version: 'TLSv1.3' }; } getSession() { return undefined; } isSessionReused() { return false; }
    setSession() {} getPeerX509Certificate() { return undefined; } setServername() {} exportKeyingMaterial() { return Buffer.alloc(0); } enableTrace() {} disableRenegotiation() {} setMaxSendFragment() { return true; }
  }

  // Parses HTTP/1.1 requests written to a socket and answers them through fetch() + the CORS proxy.
  class HttpBridge {
    constructor(socket, scheme, hostName, port) { this.socket = socket; this.scheme = scheme; this.host = hostName; this.port = port; this.buf = Buffer.alloc(0); this.state = 'head'; this.req = null; this.busy = false; this.queue = []; this.controller = null; this.dead = false; }
    write(b) {
      this.buf = this.buf.length ? Buffer.concat([this.buf, b]) : b;
      this.parse();
    }
    parse() {
      for (;;) {
        if (this.state === 'head') {
          const idx = this.buf.indexOf('\r\n\r\n');
          if (idx === -1) return;
          const lines = this.buf.subarray(0, idx).toString('latin1').split(CRLF);
          this.buf = this.buf.subarray(idx + 4);
          const [method, target] = lines[0].split(' ');
          const headers = lines.slice(1).map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; });
          const get = (n) => { const h = headers.find(([k]) => k.toLowerCase() === n); return h && h[1]; };
          this.req = { method, target, headers, chunks: [], remaining: 0 };
          if ((get('transfer-encoding') || '').toLowerCase().includes('chunked')) this.state = 'chunk-size';
          else { this.req.remaining = Number(get('content-length') || 0); this.state = this.req.remaining ? 'body' : 'done'; }
        } else if (this.state === 'body') {
          if (!this.buf.length) return;
          const take = this.buf.subarray(0, this.req.remaining);
          this.req.chunks.push(take); this.req.remaining -= take.length; this.buf = this.buf.subarray(take.length);
          if (this.req.remaining === 0) this.state = 'done';
        } else if (this.state === 'chunk-size') {
          const idx = this.buf.indexOf(CRLF);
          if (idx === -1) return;
          const size = parseInt(this.buf.subarray(0, idx).toString('latin1'), 16);
          this.buf = this.buf.subarray(idx + 2);
          if (size === 0) this.state = 'chunk-trailer'; else { this.req.remaining = size; this.state = 'chunk-data'; }
        } else if (this.state === 'chunk-data') {
          if (this.buf.length < this.req.remaining + 2) return;
          this.req.chunks.push(this.buf.subarray(0, this.req.remaining));
          this.buf = this.buf.subarray(this.req.remaining + 2); this.state = 'chunk-size';
        } else if (this.state === 'chunk-trailer') {
          const idx = this.buf.indexOf(CRLF);
          if (idx === -1) return;
          const line = this.buf.subarray(0, idx); this.buf = this.buf.subarray(idx + 2);
          if (line.length === 0) this.state = 'done';
        } else if (this.state === 'done') {
          const req = this.req; this.req = null; this.state = 'head';
          this.queue.push(req); this.pump();
        }
      }
    }
    async pump() {
      if (this.busy || this.dead) return;
      const req = this.queue.shift();
      if (!req) return;
      this.busy = true;
      const s = this.socket;
      const hostHeader = (req.headers.find(([k]) => k.toLowerCase() === 'host') || [])[1] || (this.host + ':' + this.port);
      const url = /^https?:\/\//.test(req.target) ? req.target : `${this.scheme}://${hostHeader}${req.target}`;
      const entry = { via: 'bridge', method: req.method, url, t0: host.performance.now() };
      log.bridgeRequests++; log.requests.push(entry);
      this.controller = new AbortController();
      try {
        const body = req.chunks.length ? Buffer.concat(req.chunks) : undefined;
        const fwd = req.headers.filter(([k]) => !['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'expect'].includes(k.toLowerCase()));
        const res = await proxiedFetch(url, { method: req.method, headers: fwd, body, signal: this.controller.signal });
        entry.status = res.status; entry.tHeaders = host.performance.now() - entry.t0;
        const upstreamStatus = res.headers.get('x-sandbox-status');
        let head = `HTTP/1.1 ${res.status} ${res.statusText || 'OK'}${CRLF}`;
        for (const [k, v] of res.headers) { if (HOP.has(k) || k.startsWith('access-control-') || k.startsWith('x-sandbox-')) continue; head += `${k}: ${v}${CRLF}`; }
        const noBody = req.method === 'HEAD' || res.status === 204 || res.status === 304 || !res.body;
        head += noBody ? `content-length: 0${CRLF}${CRLF}` : `transfer-encoding: chunked${CRLF}${CRLF}`;
        if (this.dead) return;
        s.bytesRead += head.length; s.push(Buffer.from(head, 'latin1'));
        if (!noBody) {
          const reader = res.body.getReader();
          entry.chunks = 0; entry.bytes = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (this.dead) { reader.cancel().catch(() => {}); return; }
            if (done) break;
            if (entry.chunks === 0) entry.tFirstChunk = host.performance.now() - entry.t0;
            entry.chunks++; entry.bytes += value.length; log.bytesIn += value.length; s.bytesRead += value.length;
            s.push(Buffer.concat([Buffer.from(value.length.toString(16) + CRLF, 'latin1'), Buffer.from(value.buffer, value.byteOffset, value.byteLength), Buffer.from(CRLF, 'latin1')]));
          }
          s.push(Buffer.from('0' + CRLF + CRLF, 'latin1'));
        }
        entry.tEnd = host.performance.now() - entry.t0;
      } catch (e) {
        entry.error = String(e && e.message || e);
        if (!this.dead) s.destroy(Object.assign(new Error('bridge fetch failed: ' + entry.error), { code: 'ECONNRESET' }));
        return;
      } finally { this.busy = false; this.controller = null; }
      this.pump();
    }
    destroy() { this.dead = true; if (this.controller) this.controller.abort(); }
  }

  const isIPv4 = (s) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s) && s.split('.').every((n) => Number(n) <= 255);
  const isIPv6 = (s) => typeof s === 'string' && s.includes(':') && /^[0-9a-fA-F:.]+$/.test(s);
  class Server extends EventEmitter {
    constructor(opts, handler) { super(); if (typeof opts === 'function') handler = opts; if (handler) this.on(this._event || 'connection', handler); this.listening = false; }
    listen(...args) { const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null; const o = args[0] && typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] }; this._port = o.port || 49152 + Math.floor(Math.random() * 1000); track('net/http Server.listen (accepted, but nothing can connect)', String(o.port ?? o.path ?? 0)); this.listening = true; queueMicrotask(() => { this.emit('listening'); cb && cb(); }); return this; }
    address() { return this.listening ? { address: '127.0.0.1', family: 'IPv4', port: this._port } : null; }
    close(cb) { this.listening = false; queueMicrotask(() => { this.emit('close'); cb && cb(); }); return this; }
    ref() { return this; } unref() { return this; } closeAllConnections() {} closeIdleConnections() {} setTimeout() { return this; }
    getConnections(cb) { cb(null, 0); }
    [Symbol.asyncDispose]() { return new Promise((r) => this.close(r)); }
  }
  const net = {
    Socket, Stream: Socket, Server,
    connect: (...args) => { const opts = args[0] && typeof args[0] === 'object' ? args[0] : {}; return new Socket(opts).connect(...args); },
    createServer: (o, h) => new Server(o, h),
    isIP: (s) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0), isIPv4, isIPv6,
    getDefaultAutoSelectFamily: () => false, setDefaultAutoSelectFamily: () => {}, getDefaultAutoSelectFamilyAttemptTimeout: () => 250, setDefaultAutoSelectFamilyAttemptTimeout: () => {},
    BlockList: class BlockList { addAddress() {} addRange() {} addSubnet() {} check() { return false; } }, SocketAddress: class SocketAddress { constructor(o = {}) { Object.assign(this, { address: '127.0.0.1', port: 0, family: 'ipv4' }, o); } },
  };
  net.createConnection = net.connect;

  const tls = {
    TLSSocket: Socket,
    connect: (...args) => {
      let opts = {}, cb;
      if (typeof args[args.length - 1] === 'function') cb = args.pop();
      if (args[0] && typeof args[0] === 'object') opts = args[0]; else opts = { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined, ...(typeof args[1] === 'object' ? args[1] : args[2]) };
      log.tlsSockets++;
      const s = new Socket({ ...opts, __secure: true });
      if (opts.socket) { // upgrade of an existing (bridge) socket: reuse its destination
        s.connect({ host: opts.host || opts.servername || opts.socket._host, port: opts.port || opts.socket.remotePort }, cb);
      } else s.connect({ host: opts.host || opts.servername, port: opts.port || 443 }, cb);
      return s;
    },
    createSecureContext: () => ({ context: {} }), rootCertificates: [], getCACertificates: () => [], setDefaultCACertificates: () => {},
    DEFAULT_MIN_VERSION: 'TLSv1.2', DEFAULT_MAX_VERSION: 'TLSv1.3', DEFAULT_ECDH_CURVE: 'auto', DEFAULT_CIPHERS: 'TLS_AES_256_GCM_SHA384',
    checkServerIdentity: () => undefined, createServer: (o, h) => new Server(o, h), Server, getCiphers: () => [], SecureContext: class SecureContext {},
  };

  // ---------------- fetch-shaped transports ----------------
  // Minimal HTTP/1.1 client over a net.Socket (used by the emulated fetch/http in tunnel mode).
  function socketFetch(url, { method = 'GET', headers = [], body, signal } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      if (u.protocol !== 'http:') return reject(Object.assign(new TypeError('fetch failed: only http:// is reachable through the blind tunnel in this spike (no in-worker TLS)'), { code: 'ERR_TLS_NOT_AVAILABLE' }));
      const entry = { via: 'tunnel-fetch', method, url, t0: host.performance.now() };
      log.requests.push(entry);
      const sock = net.connect({ host: u.hostname, port: Number(u.port || 80) });
      const bodyBuf = body == null ? null : Buffer.from(body);
      let head = `${method} ${u.pathname}${u.search} HTTP/1.1${CRLF}host: ${u.host}${CRLF}connection: close${CRLF}`;
      for (const [k, v] of headers) if (!['host', 'connection', 'content-length', 'transfer-encoding'].includes(k.toLowerCase())) head += `${k}: ${v}${CRLF}`;
      if (bodyBuf) head += `content-length: ${bodyBuf.length}${CRLF}`;
      sock.on('connect', () => { sock.write(head + CRLF); if (bodyBuf) sock.write(bodyBuf); });
      let buf = Buffer.alloc(0), state = 'head', remaining = 0, controller, settled = false;
      const fail = (e) => { if (!settled) { settled = true; reject(e); } else { try { controller.error(e); } catch {} } sock.destroy(); };
      const finish = () => { if (state !== 'end') { state = 'end'; entry.tEnd = host.performance.now() - entry.t0; try { controller.close(); } catch {} sock.destroy(); } };
      if (signal) signal.addEventListener('abort', () => fail(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), { once: true });
      const bodyStream = new ReadableStream({ start(c) { controller = c; }, cancel() { sock.destroy(); } });
      const feed = () => {
        for (;;) {
          if (state === 'head') {
            const idx = buf.indexOf('\r\n\r\n');
            if (idx === -1) return;
            const lines = buf.subarray(0, idx).toString('latin1').split(CRLF);
            buf = buf.subarray(idx + 4);
            const m = lines[0].match(/^HTTP\/1\.\d (\d+) ?(.*)$/);
            const hs = new Headers();
            for (const l of lines.slice(1)) { const i = l.indexOf(':'); hs.append(l.slice(0, i).trim(), l.slice(i + 1).trim()); }
            const status = Number(m[1]);
            entry.status = status; entry.tHeaders = host.performance.now() - entry.t0;
            const chunked = (hs.get('transfer-encoding') || '').toLowerCase().includes('chunked');
            const noBody = method === 'HEAD' || status === 204 || status === 304;
            state = noBody ? 'end' : chunked ? 'chunk-size' : hs.has('content-length') ? 'length' : 'close';
            remaining = Number(hs.get('content-length') || 0);
            settled = true;
            const res = new Response(noBody ? null : bodyStream, { status, statusText: m[2], headers: hs });
            Object.defineProperty(res, 'url', { value: url });
            resolve(res);
            if (noBody || (state === 'length' && remaining === 0)) { state = 'x'; finish(); return; }
          } else if (state === 'length') {
            if (!buf.length) return;
            const take = buf.subarray(0, remaining); remaining -= take.length; buf = buf.subarray(take.length);
            controller.enqueue(new Uint8Array(take));
            if (remaining === 0) return finish();
          } else if (state === 'close') { if (buf.length) { controller.enqueue(new Uint8Array(buf)); buf = Buffer.alloc(0); } return; }
          else if (state === 'chunk-size') {
            const idx = buf.indexOf(CRLF);
            if (idx === -1) return;
            remaining = parseInt(buf.subarray(0, idx).toString('latin1'), 16); buf = buf.subarray(idx + 2);
            if (remaining === 0) return finish();
            state = 'chunk-data';
          } else if (state === 'chunk-data') {
            if (buf.length < remaining + 2) return;
            if (entry.tFirstChunk == null) entry.tFirstChunk = host.performance.now() - entry.t0;
            controller.enqueue(new Uint8Array(buf.subarray(0, remaining))); buf = buf.subarray(remaining + 2); state = 'chunk-size';
          } else return;
        }
      };
      sock.on('data', (d) => { buf = buf.length ? Buffer.concat([buf, d]) : d; try { feed(); } catch (e) { fail(e); } });
      sock.on('end', () => { if (state === 'head') fail(new TypeError('fetch failed: connection closed before response')); else finish(); });
      sock.on('error', (e) => fail(Object.assign(new TypeError('fetch failed'), { cause: e })));
    });
  }
  const transportFetch = (url, init) => {
    if (netCfg.mode === 'bridge') { const entry = { via: 'proxied-fetch', method: init.method || 'GET', url }; log.requests.push(entry); return proxiedFetch(url, init).then((r) => { entry.status = r.status; return r; }); }
    if (netCfg.mode === 'tunnel') return socketFetch(url, init);
    track('fetch with networking disabled', url);
    return Promise.reject(new TypeError('fetch failed: networking is disabled'));
  };

  // Emulated global fetch (what `fetch` is before a harness replaces it with its own, e.g. undici).
  async function fetch(input, init = {}) {
    const isReq = typeof Request !== 'undefined' && input instanceof Request;
    const url = isReq ? input.url : String(input instanceof URL ? input.href : input);
    const method = (init.method || (isReq ? input.method : 'GET')).toUpperCase();
    const hs = new Headers(init.headers || (isReq ? input.headers : undefined));
    let body = init.body !== undefined ? init.body : isReq ? input.body : undefined;
    if (url.startsWith('data:') || url.startsWith('blob:')) return host.fetch(url);
    if (body != null && typeof body !== 'string') {
      if (body instanceof URLSearchParams) { if (!hs.has('content-type')) hs.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8'); body = body.toString(); }
      else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) body = new Uint8Array(body.buffer || body, body.byteOffset || 0, body.byteLength);
      else { const r = new Response(body); if (!hs.has('content-type') && r.headers.get('content-type')) hs.set('content-type', r.headers.get('content-type')); body = new Uint8Array(await r.arrayBuffer()); }
    } else if (typeof body === 'string' && !hs.has('content-type')) hs.set('content-type', 'text/plain;charset=UTF-8');
    const signal = init.signal || (isReq ? input.signal : undefined);
    // The request holds the process open until its response body has been fully read or cancelled (as a socket would).
    process.__ref();
    let released = false;
    const release = () => { if (!released) { released = true; process.__unref(); } };
    try {
      const res = await transportFetch(url, { method, headers: [...hs], body, signal });
      const noBody = res.status === 204 || res.status === 304 || method === 'HEAD' || !res.body;
      let outBody = null;
      if (noBody) release();
      else {
        const reader = res.body.getReader();
        outBody = new ReadableStream({
          async pull(c) { try { const { done, value } = await reader.read(); if (done) { release(); c.close(); } else c.enqueue(value); } catch (e) { release(); c.error(e); } },
          cancel(reason) { release(); return reader.cancel(reason); },
        });
        if (signal) signal.addEventListener('abort', release, { once: true });
      }
      const out = new Response(outBody, { status: res.status, statusText: res.statusText, headers: [...res.headers].filter(([k]) => !k.startsWith('access-control-') && !k.startsWith('x-sandbox-')) });
      Object.defineProperty(out, 'url', { value: url });
      return out;
    } catch (e) { release(); throw e; }
  }

  // ---------------- node:http / node:https (client only) ----------------
  const STATUS_CODES = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' };
  class Agent extends EventEmitter { constructor(opts = {}) { super(); this.options = opts; this.maxSockets = opts.maxSockets ?? Infinity; this.sockets = {}; this.requests = {}; this.freeSockets = {}; this.keepAlive = !!opts.keepAlive; } destroy() {} createConnection(o, cb) { return net.connect(o, cb); } getName() { return 'agent'; } }
  class IncomingMessage extends stream.Readable {
    constructor() { super({ read() { this._pull && this._pull(); } }); this.headers = {}; this.rawHeaders = []; this.trailers = {}; this.httpVersion = '1.1'; this.httpVersionMajor = 1; this.httpVersionMinor = 1; this.complete = false; this.aborted = false; }
    setTimeout(ms, cb) { return this; }
  }
  class ClientRequest extends stream.Writable {
    constructor(defaultProtocol, args) {
      super();
      let opts = {}, cb;
      if (typeof args[args.length - 1] === 'function') cb = args.pop();
      for (const a of args) {
        if (typeof a === 'string' || a instanceof URL) { const u = new URL(a); opts = { ...opts, protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search, auth: u.username ? decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password) : undefined }; }
        else if (a && typeof a === 'object') opts = { ...opts, ...a };
      }
      const protocol = opts.protocol || defaultProtocol;
      const hostName = opts.hostname || opts.host || 'localhost';
      this.method = (opts.method || 'GET').toUpperCase(); this.path = opts.path || '/'; this.host = hostName; this.protocol = protocol;
      this._url = `${protocol}//${hostName.includes(':') && !hostName.startsWith('[') ? `[${hostName}]` : hostName}${opts.port ? ':' + opts.port : ''}${this.path}`;
      this._headers = new Map(); this._chunks = []; this._controller = new AbortController(); this.aborted = false; this.reusedSocket = false; this.finished = false;
      for (const [k, v] of Object.entries(opts.headers || {})) this.setHeader(k, v);
      if (opts.auth && !this.hasHeader('authorization')) this.setHeader('authorization', 'Basic ' + Buffer.from(opts.auth).toString('base64'));
      if (opts.signal) opts.signal.addEventListener('abort', () => this.destroy(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })), { once: true });
      if (opts.timeout) this.setTimeout(opts.timeout);
      if (cb) this.once('response', cb);
      const sock = new EventEmitter();
      Object.assign(sock, { setTimeout() { return sock; }, setNoDelay() { return sock; }, setKeepAlive() { return sock; }, ref() { return sock; }, unref() { return sock; }, destroy() {}, end() {}, remoteAddress: hostName, remotePort: Number(opts.port) || (protocol === 'https:' ? 443 : 80), encrypted: protocol === 'https:', authorized: true, writable: true, readable: true, connecting: false, destroyed: false });
      this.socket = this.connection = sock;
      queueMicrotask(() => this.emit('socket', sock));
      track('http.request', this.method + ' ' + protocol + '//' + hostName);
    }
    setHeader(k, v) { this._headers.set(String(k).toLowerCase(), [k, v]); return this; }
    getHeader(k) { const h = this._headers.get(String(k).toLowerCase()); return h && h[1]; }
    hasHeader(k) { return this._headers.has(String(k).toLowerCase()); }
    removeHeader(k) { this._headers.delete(String(k).toLowerCase()); }
    getHeaders() { return Object.fromEntries([...this._headers].map(([k, [, v]]) => [k, v])); }
    getHeaderNames() { return [...this._headers.keys()]; } getRawHeaderNames() { return [...this._headers.values()].map(([k]) => k); }
    flushHeaders() {} setNoDelay() {} setSocketKeepAlive() {}
    setTimeout(ms, cb) { if (cb) this.once('timeout', cb); host.clearTimeout(this._timer); if (ms) this._timer = host.setTimeout(() => this.emit('timeout'), ms); return this; }
    abort() { this.aborted = true; this.destroy(); }
    _write(chunk, enc, cb) { this._chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, enc) : chunk); cb(); }
    _final(cb) {
      this.finished = true; cb();
      const headers = [];
      for (const [, [k, v]] of this._headers) for (const one of [].concat(v)) headers.push([k, String(one)]);
      process.__ref();
      let released = false;
      const release = () => { if (!released) { released = true; process.__unref(); host.clearTimeout(this._timer); } };
      transportFetch(this._url, { method: this.method, headers, body: this._chunks.length ? Buffer.concat(this._chunks) : undefined, signal: this._controller.signal }).then((res) => {
        const msg = new IncomingMessage();
        msg.statusCode = res.status; msg.statusMessage = res.statusText || STATUS_CODES[res.status] || ''; msg.socket = msg.connection = this.socket; msg.req = this; this.res = msg;
        for (const [k, v] of res.headers) { if (k.startsWith('access-control-') || k.startsWith('x-sandbox-') || k === 'content-encoding') continue; msg.rawHeaders.push(k, v); if (k === 'set-cookie') (msg.headers[k] ||= []).push(v); else msg.headers[k] = k in msg.headers ? msg.headers[k] + ', ' + v : v; }
        const reader = res.body ? res.body.getReader() : null;
        let reading = false;
        msg._pull = () => {
          if (reading) return; reading = true;
          if (!reader) { msg.complete = true; msg.push(null); release(); return; }
          reader.read().then(({ done, value }) => { reading = false; if (done) { msg.complete = true; msg.push(null); release(); } else if (msg.push(Buffer.from(value))) msg._pull(); }, (e) => { release(); msg.destroy(e); });
        };
        msg.on('close', () => { release(); if (reader && !msg.complete) reader.cancel().catch(() => {}); });
        this.emit('response', msg);
        if (this.listenerCount('response') === 0) msg.resume();
      }, (e) => { release(); if (!this.destroyed) { const err = e && e.name === 'AbortError' ? Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) : Object.assign(new Error((e && e.message) || 'request failed'), { code: (e && e.code) || 'ECONNREFUSED', cause: e }); this.emit('error', err); this.emit('close'); } });
    }
    _destroy(err, cb) { this._controller.abort(); host.clearTimeout(this._timer); cb(err); }
  }
  const mkHttp = (protocol) => {
    const mod = {
      request: (...args) => new ClientRequest(protocol, args),
      get: (...args) => { const r = new ClientRequest(protocol, args); r.end(); return r; },
      Agent, globalAgent: new Agent(), ClientRequest, IncomingMessage, STATUS_CODES,
      METHODS: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'],
      Server: class HttpServer extends Server { constructor(o, h) { super(o, undefined); if (typeof o === 'function') h = o; if (h) this.on('request', h); } },
      ServerResponse: class ServerResponse extends stream.Writable {}, OutgoingMessage: class OutgoingMessage extends stream.Writable {},
      maxHeaderSize: 16384, validateHeaderName() {}, validateHeaderValue() {}, setMaxIdleHTTPParsers() {},
    };
    mod.createServer = (o, h) => new mod.Server(o, h);
    return mod;
  };
  return { net, tls, http: mkHttp('http:'), https: mkHttp('https:'), fetch, log };
}
