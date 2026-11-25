import { describe, it, expect, beforeAll, afterAll } from 'vitest'
// @ts-ignore
import { startRelay } from '../../../tools/relay.mjs'
import { BeamhopClient, MemoryKV, generateSecretKey, getPublicKey, parseInvite, humanInviteUrl, agentInviteUrl, shouldRespond, DEFAULT_CAPS } from '../src/index.js'

const PORT = 7781
const RELAY = `ws://localhost:${PORT}`
let relay: any

const mk = (agentMode = false) => new BeamhopClient({ sk: generateSecretKey(), kv: new MemoryKV(), relays: [RELAY], agentMode })
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

describe('beamhop protocol', () => {
  it('create, knock, admit, chat, remove with rotation', async () => {
    const alice = mk()
    const bob = mk()
    const carol = mk()
    await Promise.all([alice.start(), bob.start(), carol.start()])
    const roomId = await alice.createRoom('Alice')
    await alice.stateOp(roomId, { op: 'rename', name: 'Launch' })
    expect(alice.state(roomId)!.name).toBe('Launch')

    const inv = parseInvite(humanInviteUrl('https://x/app/', alice.humanInvite(roomId)!))
    expect(inv?.type).toBe('human')
    await bob.knock(inv as any, 'Bob')
    await until(() => alice.lobby(roomId).length === 1)
    expect((alice.lobby(roomId)[0].payload as any).name).toBe('Bob')

    await alice.admit(roomId, bob.pk, 'Bob')
    await until(() => !!bob.state(roomId))
    expect(bob.state(roomId)!.members[bob.pk].name).toBe('Bob')
    expect(bob.state(roomId)!.name).toBe('Launch')
    expect(alice.lobby(roomId).length).toBe(0)

    await bob.sendMessage(roomId, 'hello @Alice')
    await until(() => alice.messages(roomId).some((m) => m.payload.t === 'msg' && m.payload.text === 'hello @Alice'))
    const m = alice.messages(roomId).find((m) => m.payload.t === 'msg')!
    expect((m.payload as any).mentions).toContain(alice.pk)

    // carol joins too
    await carol.knock(alice.humanInvite(roomId)! as any, 'Carol')
    await until(() => alice.lobby(roomId).length === 1)
    await alice.admit(roomId, carol.pk, 'Carol')
    await until(() => !!carol.state(roomId) && bob.currentKey(roomId)!.epoch === carol.currentKey(roomId)!.epoch)
    // carol does not see bob's earlier message
    expect(carol.messages(roomId).some((m) => m.payload.t === 'msg')).toBe(false)

    // remove carol -> rotation; carol can't read new messages
    await alice.removeMember(roomId, carol.pk)
    await until(() => bob.currentKey(roomId)!.epoch === alice.currentKey(roomId)!.epoch)
    expect(carol.currentKey(roomId)!.epoch).toBeLessThan(alice.currentKey(roomId)!.epoch)
    await alice.sendMessage(roomId, 'secret after carol left')
    await until(() => bob.messages(roomId).some((m) => (m.payload as any).text === 'secret after carol left'))
    await new Promise((r) => setTimeout(r, 300))
    expect(carol.messages(roomId).some((m) => (m.payload as any).text === 'secret after carol left')).toBe(false)

    // reactions, edit, delete
    const id = await bob.sendMessage(roomId, 'typo')
    await bob.edit(roomId, id, 'fixed')
    await alice.react(roomId, id, '👍')
    await until(() => alice.messages(roomId).some((m) => m.payload.t === 'edit') && bob.messages(roomId).some((m) => m.payload.t === 'react'))

    // bridge agent joins through the agent link
    const agent = mk(true)
    await agent.start()
    const ainv = parseInvite(agentInviteUrl('https://x/app/', bob.agentInvite(roomId)!)) as any
    expect(ainv.type).toBe('agent')
    await agent.requestAgentJoin(ainv, 'Helper', 'bridge')
    await until(() => !!agent.state(roomId) && !!alice.state(roomId)!.agents[agent.pk])
    expect(alice.state(roomId)!.agents[agent.pk].owner).toBe(bob.pk)
    await alice.sendMessage(roomId, '@Helper what time is it?')
    await until(() => agent.messages(roomId).some((m) => (m.payload as any).text === '@Helper what time is it?'))
    const trigger = agent.messages(roomId).find((m) => (m.payload as any).text === '@Helper what time is it?')!
    expect(shouldRespond(agent.state(roomId)!, agent.pk, trigger, DEFAULT_CAPS, []).respond).toBe(true)
    await agent.sendMessage(roomId, 'noon', { trigger: trigger.id, hop: 0 })
    await until(() => alice.messages(roomId).some((m) => (m.payload as any).text === 'noon' && m.pubkey === agent.pk))

    // revoked agent link no longer works
    bob.revokeAgentLink(roomId)
    const agent2 = mk(true)
    await agent2.start()
    await agent2.requestAgentJoin(ainv, 'Other', 'bridge')
    await new Promise((r) => setTimeout(r, 800))
    expect(alice.state(roomId)!.agents[agent2.pk]).toBeUndefined()

    // bob leaves -> alice auto rotates; agent (bob's) removed
    const epoch = alice.currentKey(roomId)!.epoch
    await bob.leave(roomId)
    await until(() => !alice.state(roomId)!.members[bob.pk])
    expect(alice.state(roomId)!.agents[agent.pk]).toBeUndefined()
    await until(() => alice.currentKey(roomId)!.epoch > epoch, 8000)

    // DMs
    await alice.sendDM(alice.pk, carol.pk, 'hi carol')
    await until(() => carol.dmMessages(carol.pk, alice.pk).length === 1)

    // multi-device: second device with the same key sees the room
    const alice2 = new BeamhopClient({ sk: alice.sk, kv: new MemoryKV(), relays: [RELAY] })
    await alice2.start()
    await until(() => !!alice2.state(roomId))
    expect(alice2.state(roomId)!.admins).toContain(alice.pk)

    // self app data
    await alice.saveAppData('test', { a: 1 })
    expect(await alice2.loadAppData('test')).toEqual({ a: 1 })

    for (const c of [alice, bob, carol, agent, agent2, alice2]) await c.stop()
  }, 60000)

  it('admin handover on leave', async () => {
    const a = mk()
    const b = mk()
    await Promise.all([a.start(), b.start()])
    const roomId = await a.createRoom('A')
    await b.knock(a.humanInvite(roomId)! as any, 'B')
    await until(() => a.lobby(roomId).length === 1)
    await a.admit(roomId, b.pk, 'B')
    await until(() => !!b.state(roomId))
    await a.leave(roomId, { newAdmin: b.pk })
    await until(() => b.state(roomId)!.admins.includes(b.pk) && !b.state(roomId)!.members[a.pk])
    const st = b.state(roomId)!
    expect(st.admins).toEqual([b.pk])
    await a.stop()
    await b.stop()
  }, 30000)

  it('close room', async () => {
    const a = mk()
    const b = mk()
    await Promise.all([a.start(), b.start()])
    const roomId = await a.createRoom('A')
    await b.knock(a.humanInvite(roomId)! as any, 'B')
    await until(() => a.lobby(roomId).length === 1)
    await a.admit(roomId, b.pk, 'B')
    await until(() => !!b.state(roomId))
    await a.leave(roomId, { closeRoom: true })
    await until(() => !!b.state(roomId)!.closed)
    await a.stop()
    await b.stop()
  }, 30000)
})

it('unique keys', () => {
  expect(getPublicKey(generateSecretKey())).toHaveLength(64)
})
