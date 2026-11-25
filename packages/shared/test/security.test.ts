import { describe, it, expect, beforeAll, afterAll } from 'vitest'
// @ts-ignore
import { startRelay } from '../../../tools/relay.mjs'
import {
  BeamhopClient, MemoryKV, generateSecretKey, getPublicKey, makeRumor, giftWrap, newKey, KIND, nowSec,
  splitText, fitTail, encodedSize, MAX_TEXT_ENCODED, resolveMentions, applyOp, initialState, reduceState,
} from '../src/index.js'

const PORT = 7785
const RELAY = `ws://localhost:${PORT}`
let relay: any
const mk = () => new BeamhopClient({ sk: generateSecretKey(), kv: new MemoryKV(), relays: [RELAY] })
const until = async (pred: () => boolean, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('timeout')
}
beforeAll(() => {
  relay = startRelay(PORT)
})
afterAll(async () => {
  await relay.close()
})

async function roomWithBob() {
  const alice = mk()
  const bob = mk()
  await alice.start()
  await bob.start()
  const roomId = await alice.createRoom('Alice')
  await bob.knock(alice.humanInvite(roomId)! as any, 'Bob')
  await until(() => alice.lobby(roomId).length === 1)
  await alice.admit(roomId, bob.pk, 'Bob')
  await until(() => !!bob.state(roomId))
  return { alice, bob, roomId }
}

describe('security fixes', () => {
  it('ignores a forged key/snapshot for a room the device already knows', async () => {
    const { alice, bob, roomId } = await roomWithBob()
    const malSk = generateSecretKey()
    const mal = getPublicKey(malSk)
    const st = bob.state(roomId)!
    const forged = { ...st, admins: [mal], members: { ...st.members, [mal]: { name: 'Mal', joinedAt: nowSec() } }, epoch: 99, ts: nowSec() + 5 }
    const key = newKey()
    const rumor = makeRumor(malSk, KIND.CONTROL, JSON.stringify({ t: 'key', roomId, epoch: 99, key, snapshot: forged, relays: [RELAY] }))
    await Promise.any(bob.pool.publish([RELAY], giftWrap(rumor, malSk, bob.pk)))
    await new Promise((r) => setTimeout(r, 800))
    expect(bob.state(roomId)!.admins).not.toContain(mal)
    expect(bob.currentKey(roomId)!.key).not.toBe(key)
    await alice.stop()
    await bob.stop()
  }, 30000)

  it('hides messages a removed member sends with an old key', async () => {
    const { alice, bob, roomId } = await roomWithBob()
    await bob.sendMessage(roomId, 'before removal')
    await until(() => alice.messages(roomId).some((m) => (m.payload as any).text === 'before removal'))
    await alice.removeMember(roomId, bob.pk)
    await until(() => !alice.state(roomId)!.members[bob.pk])
    await new Promise((r) => setTimeout(r, 1100)) // a later second than the removal
    // Bob still holds the old key and posts with it
    await bob.send(roomId, { t: 'msg', text: 'after removal' } as any).catch(() => {})
    await until(() => [...(alice as any).events.get(roomId).values()].some((e: any) => e.payload.text === 'after removal'))
    expect(alice.messages(roomId).some((m) => (m.payload as any).text === 'after removal')).toBe(false)
    expect(alice.messages(roomId).some((m) => (m.payload as any).text === 'before removal')).toBe(true)
    await alice.stop()
    await bob.stop()
  }, 30000)

  it('marks a message whose publish failed, and retries it', async () => {
    const a = new BeamhopClient({ sk: generateSecretKey(), kv: new MemoryKV(), relays: ['ws://localhost:1'] })
    await a.start()
    const roomId = await a.createRoom('A').catch(() => '')
    const rid = roomId || [...a.rooms.keys()][0]
    await expect(a.sendMessage(rid, 'lost')).rejects.toThrow()
    const m = a.messages(rid).find((x) => (x.payload as any).text === 'lost')!
    expect(m.failed).toBe(true)
    a.rooms.get(rid)!.relays = [RELAY]
    await a.retry(rid, m.id)
    expect(a.messages(rid).find((x) => x.id === m.id)!.failed).toBeUndefined()
    await a.stop()
  }, 30000)

  it('splits long texts into event-sized pieces', async () => {
    const text = ('"quoted" \\ line\n').repeat(9000)
    const parts = splitText(text)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join('')).toBe(text)
    for (const p of parts) expect(encodedSize(p)).toBeLessThanOrEqual(MAX_TEXT_ENCODED)
    expect(encodedSize(fitTail(text))).toBeLessThanOrEqual(MAX_TEXT_ENCODED)
    const { alice, bob, roomId } = await roomWithBob()
    await bob.sendMessage(roomId, text, { trigger: 'x' })
    await until(() => alice.messages(roomId).filter((m) => m.pubkey === bob.pk && m.payload.t === 'msg').length === parts.length)
    await alice.stop()
    await bob.stop()
  }, 30000)
})

describe('state and mentions', () => {
  it('longest mention wins', () => {
    let s = initialState('r', 'a'.repeat(64), 'Alice', 'f'.repeat(64), 1)
    s = applyOp(s, 'a'.repeat(64), { op: 'agent-add', pubkey: '1'.repeat(64), name: 'Claude', kind: 'browser' }, 'o1', 2)!
    s = applyOp(s, 'a'.repeat(64), { op: 'agent-add', pubkey: '2'.repeat(64), name: 'Claude Code', kind: 'bridge' }, 'o2', 3)!
    expect(resolveMentions(s, '@Claude Code please review')).toEqual(['2'.repeat(64)])
    expect(resolveMentions(s, '@Claude hi')).toEqual(['1'.repeat(64)])
    expect(resolveMentions(s, '@ClaudeCode and @Claude').sort()).toEqual(['1'.repeat(64), '2'.repeat(64)].sort())
  })
  it('applies an op made shortly before a snapshot it is missing from', () => {
    const A = 'a'.repeat(64)
    const D = 'd'.repeat(64)
    const base = { ...initialState('r', A, 'Alice', 'f'.repeat(64), 1000), ts: 1010 }
    const op = { id: 'op-admit', pubkey: A, created_at: 1005, ms: 1005000, payload: { t: 'state', op: 'admit', pubkey: D, name: 'Dan' } as any }
    expect(reduceState(base, [op]).members[D]?.name).toBe('Dan')
    const old = { ...op, id: 'old', created_at: 100, ms: 100000 }
    expect(reduceState(base, [old]).members[D]).toBeUndefined()
  })
})
