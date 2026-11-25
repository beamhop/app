// Carries the machine's TCP through a Beamhop proxy in tunnel mode: one WebSocket per connection,
// raw bytes, TLS inside the machine. The proxy resolves names, so DNS answers here are stable
// placeholders (198.18.0.0/15, as the Wisp backend does) that connect() maps back to the name.
import { openTunnel, type Tunnel } from '@beamhop/proxy'
import type { NetBackend, NetConnection, NetConnectionEvents } from 'unkernel/web'

const FAKE_BASE = ((198 << 24) | (18 << 16)) >>> 0
const FAKE_SIZE = 1 << 17

export function beamhopProxyBackend(proxyUrl: string, token?: string): NetBackend {
  const byName = new Map<string, string>()
  const byAddr = new Map<string, string>()
  const addrOf = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
  return {
    async lookup(name: string) {
      let a = byName.get(name)
      if (!a) {
        a = addrOf(FAKE_BASE + 1 + (byName.size % (FAKE_SIZE - 2)))
        byName.set(name, a)
        byAddr.set(a, name)
      }
      return [a]
    },
    connect({ host, port }, ev: NetConnectionEvents): NetConnection {
      const target = byAddr.get(host) ?? host
      let tunnel: Tunnel | null = null
      let dead = false
      let buffered = 0
      const pending: Uint8Array[] = []
      let endPending = false
      const ac = new AbortController()
      const send = (bytes: Uint8Array) => {
        buffered += bytes.length
        tunnel!.write(bytes).then(
          () => {
            buffered -= bytes.length
            ev.onDrain()
          },
          () => {},
        )
      }
      openTunnel({ proxyUrl, token, host: target, port, signal: ac.signal }).then(
        (t) => {
          if (dead) return t.close()
          tunnel = t
          t.onData = (b) => ev.onData(b)
          t.onEnd = () => ev.onEnd()
          t.onClose = (info) => {
            if (dead) return
            dead = true
            ev.onClose(info.code === 1000 ? null : new Error(info.reason || `closed (${info.code})`))
          }
          ev.onConnect()
          for (const b of pending.splice(0)) send(b)
          if (endPending) t.end()
        },
        (e) => {
          if (dead) return
          dead = true
          ev.onClose(e instanceof Error ? e : new Error(String(e)))
        },
      )
      return {
        write(data) {
          if (dead) return
          const copy = data.slice()
          if (tunnel) send(copy)
          else pending.push(copy)
        },
        end() {
          if (tunnel) tunnel.end()
          else endPending = true
        },
        destroy() {
          dead = true
          ac.abort()
          tunnel?.close()
        },
        pause() {},
        resume() {},
        get buffered() {
          return buffered
        },
      }
    },
    close() {},
  }
}
