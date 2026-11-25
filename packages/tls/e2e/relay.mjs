// TEST-ONLY WebSocket-to-TCP relay. Speaks the tunnel mode of packages/proxy/PROTOCOL.md (v1)
// without tokens, and only connects to an explicit allowlist of host:port pairs. Not the proxy.
import net from 'node:net'
import { WebSocketServer } from 'ws'

/** @param {{ allow: string[] }} opts  allow: exact "host:port" strings */
export function startRelay({ allow }) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: (p) => (p.has('bh1') ? 'bh1' : false) })
  const live = new Set()
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://relay')
    const host = url.searchParams.get('host')
    const port = Number(url.searchParams.get('port'))
    const refuse = (code, message) => {
      ws.send(JSON.stringify({ ok: false, code, message }))
      ws.close()
    }
    if (url.pathname !== '/v1/tcp' || !allow.includes(`${host}:${port}`)) return refuse('policy', 'destination not allowed by the test relay')
    const sock = net.connect({ host, port })
    live.add(sock)
    let up = false
    const timer = setTimeout(() => sock.destroy(new Error('timeout')), 10_000)
    sock.on('connect', () => {
      clearTimeout(timer)
      up = true
      ws.send(JSON.stringify({ ok: true }))
    })
    sock.on('data', (d) => {
      ws.send(d, { binary: true })
      if (ws.bufferedAmount > 1 << 20) {
        sock.pause()
        const t = setInterval(() => {
          if (ws.bufferedAmount <= 1 << 20 || ws.readyState !== ws.OPEN) {
            clearInterval(t)
            sock.resume()
          }
        }, 2)
      }
    })
    sock.on('end', () => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ end: true })))
    sock.on('error', (e) => {
      clearTimeout(timer)
      if (!up && ws.readyState === ws.OPEN) refuse(e.message === 'timeout' ? 'timeout' : e.code === 'ENOTFOUND' ? 'dns' : 'connect', e.message)
    })
    sock.on('close', () => {
      live.delete(sock)
      ws.close()
    })
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (!sock.write(data)) {
          ws.pause()
          sock.once('drain', () => ws.resume())
        }
      } else if (JSON.parse(data.toString()).end === true) sock.end()
    })
    ws.on('close', () => sock.destroy())
    ws.on('error', () => sock.destroy())
  })
  return new Promise((resolve) =>
    wss.on('listening', () =>
      resolve({
        port: wss.address().port,
        close() {
          for (const s of live) s.destroy()
          for (const c of wss.clients) c.terminate()
          wss.close()
        },
      }),
    ),
  )
}
