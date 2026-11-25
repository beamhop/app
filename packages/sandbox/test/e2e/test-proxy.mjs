// Test-only proxy that speaks packages/proxy/PROTOCOL.md v1: tunnel mode (GET /v1/tcp, WebSocket) and plain
// mode (/v1/http). It is not the real proxy. Its destination policy is an allow-list of exact host:port pairs,
// and it refuses everything else before any DNS lookup or connection is made: a harness under test must never
// be able to reach a real endpoint through it.
import http from 'node:http'
import net from 'node:net'
import { WebSocketServer } from 'ws'

const b64url = (s) => Buffer.from(s).toString('base64url')

export function startTestProxy({ allow, token = 'test-token' }) {
  const allowed = new Set(allow)
  const stats = { tcpConnections: 0, httpRequests: 0, denied: [], authFailures: 0, bytesUp: 0, bytesDown: 0 }
  const permitted = (host, port) => allowed.has(`${host}:${port}`)
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*', 'access-control-max-age': '600' }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://proxy')
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end()
    if (url.pathname === '/v1/health') return res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, v: 1, modes: ['tcp', 'http'] }))
    if (url.pathname !== '/v1/http') return res.writeHead(404, cors).end()
    const fail = (code, message) => res.writeHead(502, { ...cors, 'x-bh-error': code, 'content-type': 'application/json' }).end(JSON.stringify({ code, message }))
    if (req.headers['x-bh-token'] !== token) {
      stats.authFailures++
      return fail('auth', 'bad token')
    }
    let target
    try {
      target = new URL(String(req.headers['x-bh-url']))
    } catch {
      return fail('policy', 'x-bh-url is not a URL')
    }
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
    if (target.protocol !== 'http:' || !permitted(target.hostname, port)) {
      stats.denied.push(`${target.hostname}:${port}`)
      return fail('policy', `destination ${target.hostname}:${port} is not allowed by this test proxy`)
    }
    stats.httpRequests++
    if (process.env.E2E_DEBUG) console.error('[proxy] http', req.method, String(target), 'headers', Buffer.from(String(req.headers['x-bh-headers'] ?? ''), 'base64url').toString('utf8').slice(0, 600))
    let headers = []
    try {
      headers = JSON.parse(Buffer.from(String(req.headers['x-bh-headers'] ?? ''), 'base64url').toString('utf8') || '[]')
    } catch {
      return fail('policy', 'x-bh-headers is not base64url JSON')
    }
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    stats.bytesUp += body.length
    const out = http.request({ host: target.hostname, port, path: target.pathname + target.search, method: req.method, agent: false, headers: { connection: 'close' } }, (upstream) => {
      const pairs = []
      for (let i = 0; i < upstream.rawHeaders.length; i += 2) pairs.push([upstream.rawHeaders[i], upstream.rawHeaders[i + 1]])
      if (process.env.E2E_DEBUG) console.error('[proxy] upstream status', upstream.statusCode)
      res.writeHead(upstream.statusCode, { ...cors, 'x-bh-status': String(upstream.statusCode), 'x-bh-resp-headers': b64url(JSON.stringify(pairs)), 'content-type': upstream.headers['content-type'] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      upstream.on('data', (c) => {
        stats.bytesDown += c.length
        res.write(c)
      })
      upstream.on('end', () => res.end())
      upstream.on('error', () => res.destroy())
    })
    for (const [k, v] of headers) {
      try {
        out.setHeader(k, v)
      } catch {
        // a header Node refuses to send
      }
    }
    out.setHeader('x-via', 'plain-proxy')
    out.on('error', (e) => (res.headersSent ? res.destroy() : fail('connect', e.message)))
    res.on('close', () => out.destroy())
    out.end(body)
  })

  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has('bh1') ? 'bh1' : false) })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://proxy')
    if (url.pathname !== '/v1/tcp') return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => {
      const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim())
      const host = url.searchParams.get('host') ?? ''
      const port = Number(url.searchParams.get('port'))
      const refuse = (code, message) => {
        ws.send(JSON.stringify({ ok: false, code, message }))
        ws.close()
      }
      if (!offered.includes('bh1.' + token)) {
        stats.authFailures++
        return refuse('auth', 'bad token')
      }
      if (!permitted(host, port)) {
        stats.denied.push(`${host}:${port}`)
        return refuse('policy', `destination ${host}:${port} is not allowed by this test proxy`)
      }
      stats.tcpConnections++
      const tcp = net.connect(port, host)
      let connected = false
      tcp.on('connect', () => {
        connected = true
        ws.send(JSON.stringify({ ok: true }))
      })
      tcp.on('data', (d) => {
        stats.bytesDown += d.length
        ws.send(d)
      })
      tcp.on('end', () => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ end: true })))
      tcp.on('close', () => ws.close())
      tcp.on('error', (e) => {
        if (!connected && ws.readyState === ws.OPEN) refuse('connect', e.message)
      })
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          stats.bytesUp += data.length
          tcp.write(data)
        } else if (JSON.parse(data.toString()).end) tcp.end()
      })
      ws.on('close', () => tcp.destroy())
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        token,
        stats,
        reset() {
          Object.assign(stats, { tcpConnections: 0, httpRequests: 0, denied: [], authFailures: 0, bytesUp: 0, bytesDown: 0 })
        },
        close: () => new Promise((r) => (server.closeAllConnections(), wss.close(), server.close(r))),
      }),
    ),
  )
}
