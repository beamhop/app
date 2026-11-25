// Joins a Beamhop room as an agent identity, using an agent link.
import './ws-polyfill.js'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  BeamhopClient,
  bytesToHex,
  generateSecretKey,
  hexToBytes,
  parseInvite,
  type AgentInvite,
  type KV,
} from '@beamhop/shared'

export const HOME = process.env.BEAMHOP_HOME || join(homedir(), '.beamhop')

export class FileKV implements KV {
  private data: Record<string, any> = {}
  private timer: any
  constructor(private file: string) {
    try {
      this.data = JSON.parse(readFileSync(file, 'utf8'))
    } catch {}
  }
  async get(k: string) {
    const v = this.data[k]
    return v === undefined ? undefined : structuredClone(v)
  }
  async set(k: string, v: any) {
    this.data[k] = structuredClone(v)
    this.save()
  }
  async del(k: string) {
    delete this.data[k]
    this.save()
  }
  private save() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flushSync(), 300)
  }
  flushSync() {
    clearTimeout(this.timer)
    writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 })
  }
}

export interface Joined {
  client: BeamhopClient
  inv: AgentInvite
  kv: FileKV
  roomId: string
}

const log = (...a: any[]) => console.error('[beamhop]', ...a)

/** Load or create this agent's key for (room, owner, name), connect, and join if needed. */
export async function joinRoom(link: string, name: string, agentKind: 'bridge' = 'bridge', model?: string, opts: { relays?: string[]; quiet?: boolean } = {}): Promise<Joined> {
  const inv = parseInvite(link)
  if (!inv || inv.type !== 'agent') throw new Error('That is not a Beamhop agent link. Copy it from Invite → Agent in Beamhop.')
  mkdirSync(HOME, { recursive: true, mode: 0o700 })
  const idFile = join(HOME, 'identities.json')
  const ids: Record<string, string> = existsSync(idFile) ? JSON.parse(readFileSync(idFile, 'utf8')) : {}
  const idKey = `${inv.roomId}:${inv.owner}:${name.toLowerCase()}`
  let skHex = ids[idKey]
  if (!skHex) {
    skHex = bytesToHex(generateSecretKey())
    ids[idKey] = skHex
    writeFileSync(idFile, JSON.stringify(ids, null, 2), { mode: 0o600 })
  }
  const sk = hexToBytes(skHex)
  const kv = new FileKV(join(HOME, `state-${idKey.replace(/[^\w]/g, '_').slice(0, 120)}.json`))
  const relays = opts.relays?.length ? opts.relays : inv.relays
  const client = new BeamhopClient({ sk, kv, relays, agentMode: true, deviceId: 'bridge-' + skHex.slice(0, 8) })
  await client.start()
  const inRoom = () => !!client.state(inv.roomId)?.agents[client.pk]
  if (!inRoom()) {
    if (!opts.quiet) log(`Asking ${inv.ownerName} to add "${name}" to ${inv.name}…`)
    await client.requestAgentJoin(inv, name, agentKind, model)
    let tries = 0
    while (!inRoom()) {
      const ok = await client.waitFor(inRoom, 20000)
      if (ok) break
      tries++
      if (tries === 1 && !opts.quiet) log(`Waiting for ${inv.ownerName}'s Beamhop to be open (it adds the agent)…`)
      await client.requestAgentJoin(inv, name, agentKind, model)
      if (tries > 30) throw new Error('Timed out. Is Beamhop open in the browser of the link’s owner? Was the link revoked?')
    }
  }
  if (!opts.quiet) log(`Joined ${client.state(inv.roomId)!.name} as ${client.state(inv.roomId)!.agents[client.pk].name}.`)
  return { client, inv, kv, roomId: inv.roomId }
}
