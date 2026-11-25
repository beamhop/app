// Device pairing over a relay: the existing device shows a one-time link (QR); the new device
// opens it and receives the identity key, end-to-end encrypted to a one-time key.
import { bytesToHex, finalizeEvent, generateSecretKey, getPublicKey, hexToBytes, jsonToB64url, b64urlToJson, randomHex, nowSec } from '@beamhop/shared'
import * as nip44 from 'nostr-tools/nip44'
import type { Store } from './store'

const KIND_PAIR = 24412

export interface PairingSession {
  url: string
  state: 'waiting' | 'done'
  onState?: (s: 'waiting' | 'done') => void
  close: () => void
}

export async function startPairing(store: Store): Promise<PairingSession> {
  const esk = generateSecretKey()
  const epk = getPublicKey(esk)
  const secret = randomHex(16)
  const relays = store.client.relays.slice(0, 3)
  const payload = jsonToB64url({ p: epk, s: secret, r: relays, exp: nowSec() + 600 })
  const url = `${location.origin}${location.pathname}#/pair/${payload}`
  const session: PairingSession = { url, state: 'waiting', close: () => sub.close() }
  const sub = store.client.pool.subscribeMany(relays, { kinds: [KIND_PAIR], '#p': [epk], since: nowSec() - 30 }, {
    onevent: async (e) => {
      try {
        const msg = JSON.parse(nip44.decrypt(e.content, nip44.getConversationKey(esk, e.pubkey)))
        if (msg.s !== secret || session.state === 'done') return
        const reply = finalizeEvent(
          {
            kind: KIND_PAIR,
            created_at: nowSec(),
            tags: [['p', e.pubkey]],
            content: nip44.encrypt(JSON.stringify({ sk: bytesToHex(store.sk), profile: store.profile }), nip44.getConversationKey(esk, e.pubkey)),
          },
          esk,
        )
        await Promise.any(store.client.pool.publish(relays, reply))
        session.state = 'done'
        session.onState?.('done')
        sub.close()
      } catch {}
    },
  })
  setTimeout(() => sub.close(), 600_000)
  return session
}

export function parsePairing(payload: string): { p: string; s: string; r: string[]; exp: number } | null {
  try {
    const v = b64urlToJson(payload)
    if (!/^[0-9a-f]{64}$/.test(v.p) || !v.s || !Array.isArray(v.r)) return null
    return v
  } catch {
    return null
  }
}

/** On the new device: request the identity and wait for it. */
export async function completePairing(store: Store, payload: string, timeoutMs = 60_000): Promise<{ sk: string; profile?: any }> {
  const info = parsePairing(payload)
  if (!info) throw new Error('Invalid pairing link')
  if (info.exp < nowSec()) throw new Error('This pairing link expired. Create a new one.')
  const bsk = generateSecretKey()
  const bpk = getPublicKey(bsk)
  const conv = nip44.getConversationKey(bsk, info.p)
  return new Promise((resolve, reject) => {
    const sub = store.client.pool.subscribeMany(info.r, { kinds: [KIND_PAIR], '#p': [bpk], since: nowSec() - 30 }, {
      onevent: (e) => {
        if (e.pubkey !== info.p) return
        try {
          const msg = JSON.parse(nip44.decrypt(e.content, conv))
          if (!/^[0-9a-f]{64}$/.test(msg.sk)) return
          sub.close()
          clearTimeout(t)
          resolve(msg)
        } catch {}
      },
      oneose: async () => {
        const ev = finalizeEvent({ kind: KIND_PAIR, created_at: nowSec(), tags: [['p', info.p]], content: nip44.encrypt(JSON.stringify({ s: info.s }), conv) }, bsk)
        try {
          await Promise.any(store.client.pool.publish(info.r, ev))
        } catch (e) {
          reject(new Error('Could not reach the relay'))
        }
      },
    })
    const t = setTimeout(() => {
      sub.close()
      reject(new Error('The other device didn’t answer. Keep its pairing screen open and try again.'))
    }, timeoutMs)
  })
}

export { hexToBytes }
