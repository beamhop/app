// Minimal in-memory Nostr relay for tests and local development.
// Usage: node tools/relay.mjs [port]
import { WebSocketServer } from 'ws'
import { verifyEvent } from 'nostr-tools/pure'

export function startRelay(port = 7777) {
  const events = []
  const wss = new WebSocketServer({ port })
  const subs = new Map() // ws -> Map(subId, filters)

  const matches = (f, e) => {
    if (f.ids && !f.ids.includes(e.id)) return false
    if (f.kinds && !f.kinds.includes(e.kind)) return false
    if (f.authors && !f.authors.includes(e.pubkey)) return false
    if (f.since && e.created_at < f.since) return false
    if (f.until && e.created_at > f.until) return false
    for (const [k, v] of Object.entries(f)) {
      if (k[0] === '#' && Array.isArray(v)) {
        const name = k.slice(1)
        if (!e.tags.some((t) => t[0] === name && v.includes(t[1]))) return false
      }
    }
    return true
  }

  wss.on('connection', (ws) => {
    subs.set(ws, new Map())
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      const [type, ...rest] = msg
      if (type === 'EVENT') {
        const e = rest[0]
        if (!verifyEvent(e)) return ws.send(JSON.stringify(['OK', e.id, false, 'invalid: bad signature']))
        const ephemeral = e.kind >= 20000 && e.kind < 30000
        if (!ephemeral) {
          if (events.some((x) => x.id === e.id)) return ws.send(JSON.stringify(['OK', e.id, true, 'duplicate:']))
          if (e.kind >= 30000 && e.kind < 40000) {
            const d = e.tags.find((t) => t[0] === 'd')?.[1] ?? ''
            for (let i = events.length - 1; i >= 0; i--) {
              const x = events[i]
              if (x.kind === e.kind && x.pubkey === e.pubkey && (x.tags.find((t) => t[0] === 'd')?.[1] ?? '') === d) events.splice(i, 1)
            }
          }
          if (e.kind === 5) {
            const ids = e.tags.filter((t) => t[0] === 'e').map((t) => t[1])
            for (let i = events.length - 1; i >= 0; i--) if (ids.includes(events[i].id) && events[i].pubkey === e.pubkey) events.splice(i, 1)
          }
          events.push(e)
        }
        ws.send(JSON.stringify(['OK', e.id, true, '']))
        for (const [client, m] of subs) {
          for (const [sid, filters] of m) if (filters.some((f) => matches(f, e))) client.send(JSON.stringify(['EVENT', sid, e]))
        }
      } else if (type === 'REQ') {
        const [sid, ...filters] = rest
        subs.get(ws).set(sid, filters)
        for (const f of filters) {
          let out = events.filter((e) => matches(f, e)).sort((a, b) => b.created_at - a.created_at)
          if (f.limit) out = out.slice(0, f.limit)
          for (const e of out.reverse()) ws.send(JSON.stringify(['EVENT', sid, e]))
        }
        ws.send(JSON.stringify(['EOSE', sid]))
      } else if (type === 'CLOSE') {
        subs.get(ws)?.delete(rest[0])
      }
    })
    ws.on('close', () => subs.delete(ws))
  })
  // wss.close() only resolves once every client has disconnected, so drop the ones still connected first.
  const close = () => new Promise((r) => {
    for (const c of wss.clients) c.terminate()
    wss.close(r)
  })
  return { wss, events, close }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 7777)
  startRelay(port)
  console.log(`relay listening on ws://localhost:${port}`)
}
