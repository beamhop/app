import { describe, it, expect } from 'vitest'
import { applyOp, initialState, shouldRespond, mentionsName, DEFAULT_CAPS, type Decoded, type RoomState } from '../src/index.js'

const A = 'a'.repeat(64) // owner of agent X
const B = 'b'.repeat(64) // another person
const X = '1'.repeat(64) // A's agent
const Y = '2'.repeat(64) // B's agent

function room(): RoomState {
  let s = initialState('r1', A, 'Alice', 'f'.repeat(64), 100)
  s = applyOp(s, A, { op: 'admit', pubkey: B, name: 'Bob' }, 'o1', 101)!
  s = applyOp(s, A, { op: 'agent-add', pubkey: X, name: 'Xan', kind: 'browser' }, 'o2', 102)!
  s = applyOp(s, B, { op: 'agent-add', pubkey: Y, name: 'Yara', kind: 'bridge' }, 'o3', 103)!
  return s
}
const msg = (from: string, text: string, extra: any = {}): Decoded => ({ id: Math.random().toString(36), pubkey: from, created_at: 200, ms: 200000, payload: { t: 'msg', text, ...extra } as any })

describe('policy', () => {
  it('mentions', () => {
    expect(mentionsName('hey @Xan do it', 'Xan')).toBe(true)
    expect(mentionsName('hey @xan.', 'Xan')).toBe(true)
    expect(mentionsName('hey @Xander', 'Xan')).toBe(false)
    expect(mentionsName('mail me@Xan', 'Xan')).toBe(false)
    expect(mentionsName('@Claude Code review', 'Claude Code')).toBe(true)
    expect(mentionsName('@ClaudeCode review', 'Claude Code')).toBe(true)
  })
  it('responds to mentions from members, not otherwise', () => {
    const s = room()
    expect(shouldRespond(s, X, msg(B, '@Xan hi'), DEFAULT_CAPS, []).respond).toBe(true)
    expect(shouldRespond(s, X, msg(B, 'hi all'), DEFAULT_CAPS, []).respond).toBe(false)
    expect(shouldRespond(s, X, msg('c'.repeat(64), '@Xan hi'), DEFAULT_CAPS, []).respond).toBe(false)
  })
  it('owner-only mode and selected instructors', () => {
    let s = applyOp(room(), A, { op: 'agent-update', pubkey: X, mode: 'owner' }, 'o4', 104)!
    expect(shouldRespond(s, X, msg(B, '@Xan hi'), DEFAULT_CAPS, []).respond).toBe(false)
    expect(shouldRespond(s, X, msg(A, '@Xan hi'), DEFAULT_CAPS, []).respond).toBe(true)
    s = applyOp(room(), A, { op: 'agent-update', pubkey: X, instructors: 'selected', selected: [] }, 'o5', 105)!
    expect(shouldRespond(s, X, msg(B, '@Xan hi'), DEFAULT_CAPS, []).respond).toBe(false)
    s = applyOp(s, A, { op: 'agent-update', pubkey: X, selected: [B] }, 'o6', 106)!
    expect(shouldRespond(s, X, msg(B, '@Xan hi'), DEFAULT_CAPS, []).respond).toBe(true)
    // only the owner can change an agent
    expect(applyOp(s, B, { op: 'agent-update', pubkey: X, mode: 'mention' }, 'o7', 107)).toBeNull()
  })
  it('agent-to-agent hops are limited', () => {
    const s = room()
    const d1 = shouldRespond(s, X, msg(Y, '@Xan your turn', { hop: 0 }), DEFAULT_CAPS, [])
    expect(d1).toEqual({ respond: true, hop: 1 })
    expect(shouldRespond(s, X, msg(Y, '@Xan again', { hop: DEFAULT_CAPS.maxHops }), DEFAULT_CAPS, []).respond).toBe(false)
    expect(shouldRespond(s, X, msg(X, '@Xan me', { hop: 0 }), DEFAULT_CAPS, []).respond).toBe(false)
  })
  it('rate cap', () => {
    const s = room()
    const now = Date.now()
    const recent = Array.from({ length: 3 }, (_, i) => now - i * 1000)
    expect(shouldRespond(s, X, msg(B, '@Xan hi'), { perHour: 3, maxHops: 3 }, recent, now).respond).toBe(false)
    expect(shouldRespond(s, X, msg(B, '@Xan hi'), { perHour: 4, maxHops: 3 }, recent, now).respond).toBe(true)
  })
  it('state rules', () => {
    const s = room()
    expect(applyOp(s, B, { op: 'rename', name: 'nope' }, 'x', 110)).toBeNull()
    expect(applyOp(s, B, { op: 'admit', pubkey: 'c'.repeat(64), name: 'C' }, 'x', 110)).toBeNull()
    const removed = applyOp(s, A, { op: 'remove', pubkey: B }, 'x', 110)!
    expect(removed.agents[Y]).toBeUndefined()
    expect(removed.agents[X]).toBeDefined()
    const left = applyOp(s, B, { op: 'remove', pubkey: B }, 'x', 110)!
    expect(left.members[B]).toBeUndefined()
    expect(applyOp(s, A, { op: 'demote', pubkey: A }, 'x', 110)).toBeNull() // last admin can't step down
  })
})
