// Runs the user's in-browser agents (fx via libfx WebAssembly) in rooms and DMs.
import { agentInstructions, displayName, formatTranscript, randomHex, shouldRespond, type Decoded, type FileRef } from '@beamhop/shared'
import type { Store } from '../core/store'
import type { AgentDef, Usage } from '../core/types'
import { kv } from '../core/kv'
import { canRun, fxProviderOptions } from './providers'
import { makeTools } from './tools'

type FxMod = typeof import('libfx/browser')
let fxMod: Promise<FxMod> | null = null
const loadFx = () => (fxMod ??= import('libfx/browser'))

interface FxHandle {
  agent: any
  sig: string
  pendingFiles: Map<string, FileRef[]>
}

export class AgentRunner {
  private fx = new Map<string, FxHandle>()
  private queues = new Map<string, Promise<void>>()
  private replies = new Map<string, number[]>()
  private lastIncluded = new Map<string, number>()
  private runnable = new Set<string>() // agent ids runnable on this device
  private busy = new Set<string>() // trigger ids in progress
  status = new Map<string, string>() // agent pk -> status line for UI
  constructor(private store: Store) {}

  start() {
    const c = this.store.client
    c.on('message', ({ roomId, ev, live }) => {
      if (live) this.onRoomMessage(roomId, ev)
    })
    c.on('dm', ({ identity, peer, item, live }) => {
      if (live) this.onDM(identity, peer, item)
    })
    c.on('key-received', () => this.refreshCapabilities())
    this.refreshCapabilities()
    setInterval(() => this.refreshCapabilities(), 20_000)
    setTimeout(() => this.catchUp().catch((e) => console.warn('catch-up', e)), 12_000)
  }

  async refreshCapabilities() {
    const c = this.store.client
    const run = new Set<string>()
    for (const a of this.store.liveAgents()) if (await canRun(a.provider)) run.add(a.id)
    this.runnable = run
    for (const roomId of c.rooms.keys()) {
      const st = c.state(roomId)
      if (!st) continue
      const local = this.store
        .liveAgents()
        .filter((a) => run.has(a.id) && st.agents[a.pk]?.owner === this.store.pk)
        .map((a) => a.pk)
      c.setLocalAgents(roomId, local)
    }
    this.store.bump()
  }

  canRunHere(def: AgentDef) {
    return this.runnable.has(def.id)
  }

  invalidate(id: string) {
    const h = this.fx.get(id)
    if (h) {
      this.fx.delete(id)
      h.agent.close?.().catch?.(() => {})
    }
    this.refreshCapabilities()
  }

  private async fxFor(def: AgentDef): Promise<FxHandle> {
    const sig = JSON.stringify([def.provider, def.model, def.tools, def.instructions])
    const cur = this.fx.get(def.id)
    if (cur && cur.sig === sig) return cur
    if (cur) cur.agent.close?.().catch?.(() => {})
    const { createFxAgent, memory } = await loadFx()
    const pendingFiles = new Map<string, FileRef[]>()
    const opts = await fxProviderOptions(def.provider, def.model)
    const agent = createFxAgent({
      name: `bh_${def.id}_${Math.abs(hash(sig)).toString(36)}`,
      durability: memory(),
      tools: makeTools(this.store, def, pendingFiles),
      ...opts,
    } as any)
    const h = { agent, sig, pendingFiles }
    this.fx.set(def.id, h)
    return h
  }

  /** Is this device the one that should run `def` in `roomId`? */
  private elected(roomId: string, def: AgentDef) {
    const devices = this.store.client.agentRunnerDevices(roomId, def.pk, this.store.pk)
    return devices.length === 0 || devices[0] === this.store.deviceId
  }

  private alreadyAnswered(roomId: string, agentPk: string, triggerId: string) {
    return this.store.client.messages(roomId).some((m) => m.pubkey === agentPk && m.payload.t === 'msg' && m.payload.trigger === triggerId)
  }

  private onRoomMessage(roomId: string, ev: Decoded) {
    if (ev.payload.t !== 'msg') return
    const st = this.store.client.state(roomId)
    if (!st || st.closed) return
    for (const def of this.store.liveAgents()) {
      if (!st.agents[def.pk] || st.agents[def.pk].owner !== this.store.pk) continue
      if (!this.runnable.has(def.id)) continue
      const d = shouldRespond(st, def.pk, ev, def.caps, this.replies.get(def.pk) ?? [])
      if (!d.respond) continue
      if (!this.elected(roomId, def)) continue
      this.enqueue(def, () => this.runRoomTurn(def, roomId, ev, d.hop, false))
    }
  }

  private async catchUp() {
    const c = this.store.client
    const dayAgo = Date.now() - 86400_000
    for (const roomId of c.rooms.keys()) {
      const st = c.state(roomId)
      if (!st || st.closed) continue
      const msgs = c.messages(roomId)
      for (const def of this.store.liveAgents()) {
        if (!st.agents[def.pk] || st.agents[def.pk].owner !== this.store.pk || !this.runnable.has(def.id)) continue
        if (!this.elected(roomId, def)) continue
        let n = 0
        for (const m of msgs) {
          if (m.ms < dayAgo || m.payload.t !== 'msg' || n >= 3) continue
          if (m.ms < (st.agents[def.pk]?.addedAt ?? 0) * 1000) continue
          const d = shouldRespond(st, def.pk, m, def.caps, this.replies.get(def.pk) ?? [])
          if (!d.respond || this.alreadyAnswered(roomId, def.pk, m.id)) continue
          // skip if the agent already spoke after this message
          if (msgs.some((x) => x.pubkey === def.pk && x.ms > m.ms && x.payload.t === 'msg')) continue
          n++
          this.enqueue(def, () => this.runRoomTurn(def, roomId, m, d.hop, true))
        }
      }
    }
  }

  private enqueue(def: AgentDef, job: () => Promise<void>) {
    const prev = this.queues.get(def.id) ?? Promise.resolve()
    const next = prev.then(job).catch((e) => console.error('agent job', e))
    this.queues.set(def.id, next)
  }

  private setStatus(pk: string, s: string | null) {
    if (s) this.status.set(pk, s)
    else this.status.delete(pk)
    this.store.bump()
  }

  private async runRoomTurn(def: AgentDef, roomId: string, trigger: Decoded, hop: number, catchUp: boolean) {
    const c = this.store.client
    if (this.busy.has(trigger.id) || this.alreadyAnswered(roomId, def.pk, trigger.id)) return
    this.busy.add(trigger.id)
    const sid = randomHex(8)
    let text = ''
    let lastSent = 0
    const pushStream = (status?: string, done = false) => c.stream(roomId, def.pk, sid, text, { trigger: trigger.id, status, done })
    try {
      await pushStream('Thinking…')
      this.setStatus(def.pk, 'Thinking…')
      const h = await this.fxFor(def)
      const st = c.state(roomId)!
      const key = `${def.id}:${roomId}`
      const since = this.lastIncluded.get(key) ?? 0
      const all = c.messages(roomId).filter((m) => m.payload.t === 'msg' && m.ms <= trigger.ms)
      const fresh = all.filter((m) => m.ms > since).slice(-40)
      this.lastIncluded.set(key, trigger.ms)
      const who = displayName(st, trigger.pubkey)
      const prompt = [
        since ? 'New messages in the room since your last reply:' : 'Recent room transcript:',
        formatTranscript(st, fresh, def.pk, 40) || '(none)',
        '',
        `${who} mentioned you in the last message. Write your reply to the room now.`,
        catchUp ? '(This message arrived while you were offline. Reply only if it is still useful; otherwise briefly acknowledge it.)' : '',
      ].join('\n')
      const session = h.agent.session(`room-${roomId}`, {
        instructions: agentInstructions(st, def.pk, def.instructions),
        context: { roomId },
      })
      const turn = session.prompt(prompt)
      for await (const e of turn) {
        if (e.type === 'text_delta') {
          text += e.delta
          if (Date.now() - lastSent > 450) {
            lastSent = Date.now()
            pushStream()
          }
        } else if (e.type === 'tool_start') {
          this.setStatus(def.pk, `Using ${e.name}…`)
          pushStream(`Using ${e.name}…`)
        } else if (e.type === 'tool_end') {
          this.setStatus(def.pk, 'Thinking…')
        }
      }
      const result = await turn.result
      await this.recordUsage(def, result?.usage)
      if (result?.stopReason === 'error') throw new Error(result.error?.message ?? 'The model returned an error')
      const files = h.pendingFiles.get(roomId) ?? []
      h.pendingFiles.delete(roomId)
      const final = text.trim() || (files.length ? 'Here you go.' : '…')
      await c.sendMessage(roomId, final.slice(0, 50000), { as: def.pk, trigger: trigger.id, hop, sid, files })
      const arr = (this.replies.get(def.pk) ?? []).filter((t) => t > Date.now() - 3600_000)
      arr.push(Date.now())
      this.replies.set(def.pk, arr)
    } catch (e: any) {
      console.error(e)
      const msg = e?.message ?? String(e)
      await c.sendMessage(roomId, `⚠️ I couldn't answer: ${msg.slice(0, 400)}`, { as: def.pk, trigger: trigger.id, hop, sid }).catch(() => {})
    } finally {
      pushStream(undefined, true)
      this.busy.delete(trigger.id)
      this.setStatus(def.pk, null)
    }
  }

  private async onDM(identity: string, peer: string, item: { from: string; text: string; id: string }) {
    const def = this.store.liveAgents().find((a) => a.pk === identity)
    if (!def || item.from !== this.store.pk || peer !== this.store.pk) return // owner-only
    if (!this.runnable.has(def.id)) return
    // let one of my devices answer: the lowest device id seen running this agent anywhere
    const devices = new Set<string>()
    for (const roomId of this.store.client.rooms.keys())
      this.store.client.agentRunnerDevices(roomId, def.pk, this.store.pk).forEach((d) => devices.add(d))
    const first = [...devices].sort()[0]
    if (first && first !== this.store.deviceId) return
    this.enqueue(def, async () => {
      this.setStatus(def.pk, 'Thinking…')
      try {
        const h = await this.fxFor(def)
        const session = h.agent.session('dm', {
          instructions: `You are "${def.name}", the personal AI agent of ${this.store.profile.name || 'your owner'}, talking privately with them in Beamhop.\n\n${def.instructions}`,
          context: { dm: true },
        })
        const turn = session.prompt(item.text)
        let text = ''
        for await (const e of turn) if (e.type === 'text_delta') text += e.delta
        const result = await turn.result
        await this.recordUsage(def, result?.usage)
        if (result?.stopReason === 'error') throw new Error(result.error?.message ?? 'model error')
        await this.store.client.sendDM(def.pk, this.store.pk, text.trim() || '…')
      } catch (e: any) {
        await this.store.client.sendDM(def.pk, this.store.pk, `⚠️ ${e?.message ?? e}`).catch(() => {})
      } finally {
        this.setStatus(def.pk, null)
      }
    })
  }

  private async recordUsage(def: AgentDef, usage?: { inputTokens?: number; outputTokens?: number }) {
    const u = (await kv.get<Usage>('usage:' + def.id)) ?? { turns: 0, input: 0, output: 0 }
    u.turns++
    u.input += usage?.inputTokens ?? 0
    u.output += usage?.outputTokens ?? 0
    u.lastAt = Date.now()
    await kv.set('usage:' + def.id, u)
  }
}

function hash(s: string) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}
