import { finalizeEvent, getPublicKey, verifyEvent, getEventHash, generateSecretKey } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import type { Event, EventTemplate } from 'nostr-tools/pure'
import { KIND, type Decoded, type InnerEvent, type Payload } from './types.js'
import { bytesToHex, hexToBytes, hmacSha256, nowSec, sha256Hex, randomBytes } from './util.js'

export { getPublicKey, generateSecretKey, finalizeEvent, verifyEvent }
export type { Event, EventTemplate }

// ---------- room keys ----------
export const roomTag = (keyHex: string) => sha256Hex('beamhop-tag:' + keyHex)
const roomConvKey = (keyHex: string) => hmacSha256(hexToBytes(keyHex), 'beamhop-room-v1')

export const MAX_PLAINTEXT = 60000

/** Sign an inner event as `sk` for room `roomId`. */
export function signInner(sk: Uint8Array, roomId: string, payload: Payload, createdAt = nowSec()): InnerEvent {
  const ms = Date.now()
  const p = { ...payload } as any
  if (p.ms === undefined) p.ms = ms
  return finalizeEvent(
    { kind: KIND.INNER, created_at: createdAt, tags: [['room', roomId]], content: JSON.stringify(p) },
    sk,
  ) as InnerEvent
}

/** Deterministic outer signing key so the author can later request deletion. */
export function outerKeyFor(sk: Uint8Array, innerId: string) {
  return hmacSha256(sk, 'beamhop-outer:' + innerId)
}

export function wrapRoomEvent(sk: Uint8Array, inner: InnerEvent, keyHex: string, ephemeral = false): Event {
  const plaintext = JSON.stringify(inner)
  if (plaintext.length > MAX_PLAINTEXT) throw new Error('Message too large')
  const content = nip44.encrypt(plaintext, roomConvKey(keyHex))
  const outerSk = ephemeral ? generateSecretKey() : outerKeyFor(sk, inner.id)
  return finalizeEvent(
    {
      kind: ephemeral ? KIND.ROOM_EPHEMERAL : KIND.ROOM,
      created_at: inner.created_at,
      tags: [['h', roomTag(keyHex)]],
      content,
    },
    outerSk,
  )
}

export function unwrapRoomEvent(outer: Event, keyHex: string, roomId: string): Decoded | null {
  try {
    const inner = JSON.parse(nip44.decrypt(outer.content, roomConvKey(keyHex))) as InnerEvent
    if (inner.kind !== KIND.INNER) return null
    if (!inner.tags.some((t) => t[0] === 'room' && t[1] === roomId)) return null
    if (!verifyEvent(inner as any)) return null
    const payload = JSON.parse(inner.content) as Payload
    if (!payload || typeof (payload as any).t !== 'string') return null
    const ms = typeof (payload as any).ms === 'number' ? (payload as any).ms : inner.created_at * 1000
    return { id: inner.id, pubkey: inner.pubkey, created_at: inner.created_at, ms, payload, outerId: outer.id }
  } catch {
    return null
  }
}

// ---------- NIP-59 gift wraps ----------
export interface Rumor {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
}

const randomPast = (maxSec: number) => nowSec() - Math.floor(Math.random() * maxSec)

export function makeRumor(sk: Uint8Array, kind: number, content: string, tags: string[][] = []): Rumor {
  const r: any = { kind, content, tags, created_at: nowSec(), pubkey: getPublicKey(sk) }
  r.id = getEventHash(r)
  return r
}

export function giftWrap(rumor: Rumor, senderSk: Uint8Array, recipient: string): Event {
  const seal = finalizeEvent(
    {
      kind: KIND.SEAL,
      created_at: randomPast(600),
      tags: [],
      content: nip44.encrypt(JSON.stringify(rumor), nip44.getConversationKey(senderSk, recipient)),
    },
    senderSk,
  )
  const ephemeral = generateSecretKey()
  return finalizeEvent(
    {
      kind: KIND.GIFT_WRAP,
      created_at: randomPast(600),
      tags: [['p', recipient]],
      content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(ephemeral, recipient)),
    },
    ephemeral,
  )
}

export function unwrapGift(wrap: Event, sk: Uint8Array): Rumor | null {
  try {
    if (wrap.kind !== KIND.GIFT_WRAP) return null
    const seal = JSON.parse(nip44.decrypt(wrap.content, nip44.getConversationKey(sk, wrap.pubkey))) as Event
    if (seal.kind !== KIND.SEAL || !verifyEvent(seal)) return null
    const rumor = JSON.parse(nip44.decrypt(seal.content, nip44.getConversationKey(sk, seal.pubkey))) as Rumor
    if (rumor.pubkey !== seal.pubkey) return null
    if (getEventHash(rumor as any) !== rumor.id) return null
    return rumor
  } catch {
    return null
  }
}

// ---------- self-encrypted data ----------
export function encryptToSelf(sk: Uint8Array, plaintext: string) {
  return nip44.encrypt(plaintext, nip44.getConversationKey(sk, getPublicKey(sk)))
}
export function decryptFromSelf(sk: Uint8Array, payload: string) {
  return nip44.decrypt(payload, nip44.getConversationKey(sk, getPublicKey(sk)))
}

// ---------- files (AES-GCM) ----------
export async function encryptFile(data: Uint8Array) {
  const key = randomBytes(32)
  const iv = randomBytes(12)
  const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt'])
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, k, data as BufferSource))
  return { ciphertext: ct, key: bytesToHex(key), iv: bytesToHex(iv), sha256: sha256Hex(ct) }
}
export async function decryptFile(ct: Uint8Array, keyHex: string, ivHex: string) {
  const k = await crypto.subtle.importKey('raw', hexToBytes(keyHex) as BufferSource, 'AES-GCM', false, ['decrypt'])
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(ivHex) as BufferSource }, k, ct as BufferSource))
}

export const newKey = () => bytesToHex(randomBytes(32))
