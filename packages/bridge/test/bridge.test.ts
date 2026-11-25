import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
// @ts-ignore
import { startRelay } from '../../../tools/relay.mjs'
import { BeamhopClient, MemoryKV, generateSecretKey, agentInviteUrl } from '@beamhop/shared'

const PORT = 7782
const RELAY = `ws://localhost:${PORT}`
let relay: any
const procs: ChildProcess[] = []
const until = async (pred: () => boolean, ms = 20000) => {
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
  procs.forEach((p) => p.kill())
  await relay.close()
})

const BRIDGE = resolve(__dirname, '../dist/beamhop-agent.mjs')
const FAKE = resolve(__dirname, '../../../tools/fake-acp-agent.mjs')

function runBridge(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'bh-bridge-'))
  const p = spawn(process.execPath, [BRIDGE, ...args, '--relay', RELAY], { env: { ...process.env, BEAMHOP_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
  let log = ''
  p.stderr.on('data', (d) => (log += d))
  procs.push(p)
  return { p, log: () => log }
}

describe('bridge', () => {
  it('joins via agent link and answers mentions through an ACP agent, with tool permissions', async () => {
    const owner = new BeamhopClient({ sk: generateSecretKey(), kv: new MemoryKV(), relays: [RELAY] })
    const guest = new BeamhopClient({ sk: generateSecretKey(), kv: new MemoryKV(), relays: [RELAY] })
    await owner.start()
    await guest.start()
    const roomId = await owner.createRoom('Olive')
    await guest.knock(owner.humanInvite(roomId)! as any, 'Gus')
    await until(() => owner.lobby(roomId).length === 1)
    await owner.admit(roomId, guest.pk, 'Gus')
    await until(() => !!guest.state(roomId))
    const link = agentInviteUrl('http://x/app/', owner.agentInvite(roomId)!)
    const b = runBridge([link, '--acp', `${process.execPath} ${FAKE}`, '--name', 'Fakey'])
    await until(() => Object.values(owner.state(roomId)!.agents).some((a) => a.name === 'Fakey'), 30000)
    const agentPk = Object.keys(owner.state(roomId)!.agents)[0]
    expect(owner.state(roomId)!.agents[agentPk].kind).toBe('bridge')
    await until(() => b.log().includes('Listening'), 15000)

    await guest.sendMessage(roomId, '@Fakey hello there')
    await until(() => guest.messages(roomId).some((m) => m.pubkey === agentPk && (m.payload as any).text?.startsWith('acp says:')), 20000)

    // tool permission: guest is not the owner -> rejected
    await guest.sendMessage(roomId, '@Fakey need_tool please')
    await until(() => guest.messages(roomId).some((m) => (m.payload as any).text?.includes('[permission:no]')), 20000)
    // owner -> allowed
    await owner.sendMessage(roomId, '@Fakey need_tool now')
    await until(() => owner.messages(roomId).some((m) => (m.payload as any).text?.includes('[permission:yes]')), 20000)
    await owner.stop()
    await guest.stop()
  }, 90000)

  it('mcp mode', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const owner = new BeamhopClient({ sk: generateSecretKey(), kv: new MemoryKV(), relays: [RELAY] })
    await owner.start()
    const roomId = await owner.createRoom('Olive')
    await owner.sendMessage(roomId, 'first message')
    const link = agentInviteUrl('http://x/app/', owner.agentInvite(roomId)!)
    const home = mkdtempSync(join(tmpdir(), 'bh-mcp-'))
    const transport = new StdioClientTransport({ command: process.execPath, args: [BRIDGE, 'mcp', link, '--name', 'Claude Code', '--relay', RELAY], env: { ...process.env, BEAMHOP_HOME: home } as any, stderr: 'ignore' })
    const mcp = new Client({ name: 'test', version: '1' })
    await mcp.connect(transport)
    const tools = await mcp.listTools()
    expect(tools.tools.map((t) => t.name)).toContain('beamhop_send_message')
    await mcp.callTool({ name: 'beamhop_send_message', arguments: { text: 'hi from mcp' } })
    await until(() => owner.messages(roomId).some((m) => (m.payload as any).text === 'hi from mcp'))
    const wait = mcp.callTool({ name: 'beamhop_wait_for_mention', arguments: { timeout_seconds: 20 } })
    await new Promise((r) => setTimeout(r, 300))
    await owner.sendMessage(roomId, '@Claude Code please review')
    const r: any = await wait
    expect(r.content[0].text).toContain('please review')
    await mcp.close()
    await owner.stop()
  }, 60000)

  it('command backend', async () => {
    const owner = new BeamhopClient({ sk: generateSecretKey(), kv: new MemoryKV(), relays: [RELAY] })
    await owner.start()
    const roomId = await owner.createRoom('Olive')
    const link = agentInviteUrl('http://x/app/', owner.agentInvite(roomId)!)
    runBridge([link, '--cmd', 'wc -l | sed "s/^/lines: /"', '--name', 'Counter'])
    await until(() => Object.values(owner.state(roomId)!.agents).some((a) => a.name === 'Counter'), 30000)
    await new Promise((r) => setTimeout(r, 1500))
    await owner.sendMessage(roomId, '@Counter count')
    await until(() => owner.messages(roomId).some((m) => (m.payload as any).text?.startsWith('lines:')), 20000)
    await owner.stop()
  }, 60000)
})
