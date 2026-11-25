// Runs the real fx CLI through the bridge (`--agent fx` → `fx acp`) when FX_BIN is set.
import { it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
// @ts-ignore
import { startRelay } from '../../../tools/relay.mjs'
// @ts-ignore
import { startMockLLM } from '../../../tools/mock-llm.mjs'
import { BeamhopClient, MemoryKV, generateSecretKey, agentInviteUrl } from '@beamhop/shared'

const FX_BIN = process.env.BH_FX_BIN
const FX_HOME = process.env.BH_FX_HOME
const until = async (pred: () => boolean, ms = 30000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('timeout')
}

it.skipIf(!FX_BIN)('real fx agent answers in a room through the bridge', async () => {
  const relay = startRelay(7783)
  const llm = process.env.BH_FX_MOCK_RUNNING ? null : startMockLLM(7790)
  const owner = new BeamhopClient({ sk: generateSecretKey(), kv: new MemoryKV(), relays: ['ws://localhost:7783'] })
  await owner.start()
  const roomId = await owner.createRoom('Olive')
  const link = agentInviteUrl('http://x/app/', owner.agentInvite(roomId)!)
  let log = ''
  const p = spawn(process.execPath, [resolve(__dirname, '../dist/beamhop-agent.mjs'), link, '--agent', 'fx', '--relay', 'ws://localhost:7783'], {
    env: { ...process.env, HOME: FX_HOME, BEAMHOP_HOME: mkdtempSync(join(tmpdir(), 'bh-fx-')), PATH: dirname(FX_BIN!) + ':' + process.env.PATH },
  })
  p.stderr.on('data', (d) => (log += d))
  try {
    await until(() => log.includes('Listening'))
    const agentPk = Object.keys(owner.state(roomId)!.agents)[0]
    expect(owner.state(roomId)!.agents[agentPk].name).toBe('fx')
    await owner.sendMessage(roomId, '@fx hello from the room')
    await until(() => owner.messages(roomId).some((m) => m.pubkey === agentPk && /echo:/.test((m.payload as any).text ?? '')))
  } finally {
    console.log(log)
    p.kill()
    await owner.stop()
    await relay.close()
    await llm?.close()
  }
}, 90000)
