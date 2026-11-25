// Runs real agent CLIs through the bridge against mock model APIs.
// Set BH_CLIS_BIN to a node_modules/.bin holding `gemini` and `claude-code-acp`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
// @ts-ignore
import { startRelay } from '../../../tools/relay.mjs'
// @ts-ignore
import { startMockAnthropic, startMockGemini } from '../../../tools/mock-apis.mjs'
// @ts-ignore
import { startMockLLM } from '../../../tools/mock-llm.mjs'
import { BeamhopClient, MemoryKV, generateSecretKey, agentInviteUrl } from '@beamhop/shared'

const BIN = process.env.BH_CLIS_BIN
const RELAY = 'ws://localhost:7784'
let relay: any, anthropic: any, gemini: any, openai: any
const until = async (pred: () => boolean, ms = 60000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('timeout')
}

async function roundTrip(args: string[], env: Record<string, string>, name: string) {
  const owner = new BeamhopClient({ sk: generateSecretKey(), kv: new MemoryKV(), relays: [RELAY] })
  await owner.start()
  const roomId = await owner.createRoom('Olive')
  const link = agentInviteUrl('http://x/app/', owner.agentInvite(roomId)!)
  let log = ''
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env, PATH: `${BIN}:${process.env.PATH}`, BEAMHOP_HOME: mkdtempSync(join(tmpdir(), 'bh-real-')) }
  delete childEnv.CLAUDECODE // these tests may themselves run inside Claude Code
  delete childEnv.CLAUDE_CODE_ENTRYPOINT
  const p = spawn(process.execPath, [resolve(__dirname, '../dist/beamhop-agent.mjs'), link, ...args, '--name', name, '--relay', RELAY], {
    env: childEnv as any,
    cwd: mkdtempSync(join(tmpdir(), 'bh-cwd-')),
  })
  p.stderr.on('data', (d) => (log += d))
  try {
    await until(() => log.includes('Listening'), 90000)
    const agentPk = Object.keys(owner.state(roomId)!.agents)[0]
    await owner.sendMessage(roomId, `@${name} ping from the room`)
    await until(() => owner.messages(roomId).some((m) => m.pubkey === agentPk && (m.payload as any).t === 'msg'), 90000)
    return owner.messages(roomId).find((m) => m.pubkey === agentPk && (m.payload as any).t === 'msg')!.payload as any
  } finally {
    if (!log.includes('replied')) console.log(log.slice(-3000))
    p.kill()
    await owner.stop()
  }
}

describe.skipIf(!BIN)('real agent CLIs', () => {
  beforeAll(() => {
    relay = startRelay(7784)
    anthropic = startMockAnthropic(7791)
    gemini = startMockGemini(7792)
    openai = startMockLLM(7793)
  })
  afterAll(async () => {
    await relay.close()
    await anthropic.close()
    await gemini.close()
    await openai.close()
  })

  it('Claude Code (claude-code-acp)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bh-claude-home-'))
    const msg = await roundTrip(['--acp', 'claude-code-acp'], { HOME: home, ANTHROPIC_BASE_URL: 'http://localhost:7791', ANTHROPIC_API_KEY: 'sk-ant-test', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }, 'Claude')
    expect(msg.text).toContain('echo:')
  }, 150000)

  it('Codex (codex-acp)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bh-codex-home-'))
    writeFileSync(join(home, 'config.toml'), 'model = "mock-model"\nmodel_provider = "mock"\n[model_providers.mock]\nname = "Mock"\nbase_url = "http://localhost:7793/v1"\nwire_api = "responses"\n')
    const msg = await roundTrip(['--acp', 'codex-acp'], { CODEX_HOME: home, OPENAI_API_KEY: 'sk-test' }, 'Codex')
    expect(msg.text).toContain('echo:')
  }, 150000)

  it('Gemini CLI (--experimental-acp)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bh-gemini-home-'))
    mkdirSync(join(home, '.gemini'), { recursive: true })
    writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } }, selectedAuthType: 'gemini-api-key', usageStatisticsEnabled: false }))
    const msg = await roundTrip(['--agent', 'gemini'], { HOME: home, GEMINI_API_KEY: 'test-key', GOOGLE_GEMINI_BASE_URL: 'http://localhost:7792', GEMINI_CLI_NO_RELAUNCH: 'true' }, 'Gemini')
    expect(msg.text).toContain('echo:')
  }, 150000)
})
