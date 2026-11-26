// Runs the user's in-browser agents in rooms and DMs: fx compiled to WebAssembly (runtime 'tab'),
// or a coding-agent harness in the Linux machine in the tab (runtime 'machine', see ../machine).
import { agentInstructions, triggerLine, displayName, formatTranscript, randomHex, shouldRespond, type Decoded, type FileRef } from '@beamhop/shared'
import type { Store } from '../core/store'
import type { AgentDef, Usage } from '../core/types'
import { kv } from '../core/kv'
import { canRun, fxProviderOptions } from './providers'
import { HARNESSES, type HarnessId } from '@beamhop/shared'
import { HarnessAgent, type HarnessModel } from '../machine/acp'
import { machine, machineSupported } from '../machine/machine'
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
  private harnesses = new Map<string, { agent: HarnessAgent; sig: string }>()
  private queues = new Map<string, Promise<void>>()
  private replies = new Map<string, number[]>()
  private lastIncluded = new Map<string, number>()
  private runnable = new Set<string>() // agent ids runnable on this device
  private busy = new Set<string>() // trigger ids in progress
  private dmClaims = new Map<string, Set<string>>() // dm id -> devices that claimed answering it
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
    c.on('dm-claim', ({ dm, device }) => {
      const set = this.dmClaims.get(dm) ?? new Set<string>()
      set.add(device)
      this.dmClaims.set(dm, set)
    })
    this.refreshCapabilities()
    setInterval(() => this.refreshCapabilities(), 20_000)
    setTimeout(() => this.catchUp().catch((e) => console.warn('catch-up', e)), 12_000)
  }

  async refreshCapabilities() {
    const c = this.store.client
    const run = new Set<string>()
    for (const a of this.store.liveAgents()) if (await this.canRunDef(a)) run.add(a.id)
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

  private async canRunDef(def: AgentDef) {
    if (def.runtime === 'machine') return !!def.harness && machineSupported().ok && (await machine.harnessReady(def.harness))
    return canRun(def.provider)
  }

  canRunHere(def: AgentDef) {
    return this.runnable.has(def.id)
  }

  /**
   * The user changed a provider's sign-in or key: the next turn of each agent on that provider
   * builds a fresh fx agent that reads the new credentials. Agents on other providers keep their
   * conversations, and a turn already running finishes on the handle it started with.
   */
  invalidateProvider(provider: string) {
    for (const def of this.store.agents) if (def.provider === provider) this.fx.delete(def.id)
  }

  invalidate(id: string) {
    const m = this.harnesses.get(id)
    if (m) {
      this.harnesses.delete(id)
      m.agent.close()
    }
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

  /** Starts `harness` in the machine just long enough to ask which models it offers. */
  async listHarnessModels(harness: HarnessId, customCommand = ''): Promise<HarnessModel[]> {
    const sup = machineSupported()
    if (!sup.ok) throw new Error(sup.why)
    await machine.ensure()
    if (harness === 'custom') await machine.writeFile('/root/.beamhop/custom-agent', `#!/bin/sh\n${customCommand}\n`)
    const env: Record<string, string> = {}
    const k = HARNESSES[harness].keyEnv
    const key = k ? await machine.harnessKey(harness) : ''
    if (k && key) env[k.name] = key
    const a = new HarnessAgent('models-' + harness, harness, env)
    try {
      return await a.listModels()
    } finally {
      a.close()
    }
  }

  private async harnessFor(def: AgentDef): Promise<HarnessAgent> {
    const harness = def.harness ?? 'claude'
    const key = HARNESSES[harness].keyEnv ? await machine.harnessKey(harness) : ''
    const sig = JSON.stringify([harness, key, def.customCommand ?? '', def.model ?? ''])
    const cur = this.harnesses.get(def.id)
    if (cur && cur.sig === sig && cur.agent.alive) return cur.agent
    cur?.agent.close()
    if (harness === 'custom') await machine.writeFile('/root/.beamhop/custom-agent', `#!/bin/sh\n${def.customCommand ?? ''}\n`)
    const env: Record<string, string> = {}
    const k = HARNESSES[harness].keyEnv
    if (k && key) env[k.name] = key
    const agent = new HarnessAgent(def.id, harness, env, def.model ?? '')
    this.harnesses.set(def.id, { agent, sig })
    await agent.init()
    return agent
  }

  /**
   * One turn of `def`, on whichever runtime it uses. Streams text through `onText` and status
   * lines through `onStatus`; resolves with the reply and the files its tools attached.
   */
  private async turn(
    def: AgentDef,
    o: { session: string; instructions: string; context: Record<string, unknown>; prompt: string; allowTools: boolean; roomId?: string },
    onText: (d: string) => void,
    onStatus: (s: string) => void,
  ): Promise<{ text: string; files: FileRef[] }> {
    if (def.runtime === 'machine') {
      if (machine.state !== 'ready') onStatus('Starting the Linux machine…')
      const a = await this.harnessFor(def)
      // ACP has no system prompt: the instructions open each conversation.
      const prompt = a.hasSession(o.session) ? o.prompt : `${o.instructions}\n\n---\n\n${o.prompt}`
      const text = await a.run({ session: o.session, prompt, allowTools: o.allowTools, onText, onStatus })
      await this.recordUsage(def)
      return { text, files: [] }
    }
    const h = await this.fxFor(def)
    const session = h.agent.session(o.session, { instructions: o.instructions, context: o.context })
    const turn = session.prompt(o.prompt)
    let text = ''
    for await (const e of turn) {
      if (e.type === 'text_delta') {
        text += e.delta
        onText(e.delta)
      } else if (e.type === 'tool_start') onStatus(`Using ${e.name}…`)
      else if (e.type === 'tool_end') onStatus('Thinking…')
    }
    const result = await turn.result
    await this.recordUsage(def, result?.usage)
    if (result?.stopReason === 'error') throw new Error(result.error?.message ?? 'The model returned an error')
    const files = (o.roomId && h.pendingFiles.get(o.roomId)) || []
    if (o.roomId) h.pendingFiles.delete(o.roomId)
    return { text, files }
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
      const d = shouldRespond(st, def.pk, ev, def.caps, this.replies.get(def.pk) ?? [], Date.now(), (id) => this.store.client.message(roomId, id))
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
          const d = shouldRespond(st, def.pk, m, def.caps, this.replies.get(def.pk) ?? [], Date.now(), (id) => c.message(roomId, id))
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
      const st = c.state(roomId)!
      const key = `${def.id}:${roomId}`
      const since = this.lastIncluded.get(key) ?? 0
      const all = c.messages(roomId).filter((m) => m.payload.t === 'msg' && m.ms <= trigger.ms)
      const fresh = all.filter((m) => m.ms > since).slice(-40)
      this.lastIncluded.set(key, trigger.ms)
      const prompt = [
        since ? 'New messages in the room since your last reply:' : 'Recent room transcript:',
        formatTranscript(st, fresh, def.pk, 40, (id) => c.message(roomId, id)) || '(none)',
        '',
        `${triggerLine(st, trigger, def.pk)} Write your reply to the room now.`,
        catchUp ? '(This message arrived while you were offline. Reply only if it is still useful; otherwise briefly acknowledge it.)' : '',
      ].join('\n')
      const out = await this.turn(
        def,
        {
          session: `room-${roomId}`,
          instructions: agentInstructions(st, def.pk, def.instructions),
          context: { roomId },
          prompt,
          // Tools that change things run only when the agent's owner asked.
          allowTools: trigger.pubkey === this.store.pk,
          roomId,
        },
        (d) => {
          text += d
          if (Date.now() - lastSent > 450) {
            lastSent = Date.now()
            pushStream()
          }
        },
        (s) => {
          this.setStatus(def.pk, s)
          pushStream(s)
        },
      )
      text = out.text || text
      const files = out.files
      const final = text.trim() || (files.length ? 'Here you go.' : '…')
      await c.sendMessage(roomId, final, { as: def.pk, reply: trigger.id, trigger: trigger.id, hop, sid, files })
      const arr = (this.replies.get(def.pk) ?? []).filter((t) => t > Date.now() - 3600_000)
      arr.push(Date.now())
      this.replies.set(def.pk, arr)
    } catch (e: any) {
      console.error(e)
      const msg = e?.message ?? String(e)
      await c.sendMessage(roomId, `⚠️ I couldn't answer: ${msg.slice(0, 400)}`, { as: def.pk, reply: trigger.id, trigger: trigger.id, hop, sid }).catch(() => {})
    } finally {
      pushStream(undefined, true)
      this.busy.delete(trigger.id)
      this.setStatus(def.pk, null)
    }
  }

  private async onDM(identity: string, peer: string, item: { from: string; text: string; id: string; ms: number; device?: string; senderRuns?: boolean }) {
    const def = this.store.liveAgents().find((a) => a.pk === identity)
    if (!def || item.from !== this.store.pk || peer !== this.store.pk) return // owner-only
    if (!this.runnable.has(def.id)) return
    // Exactly one of my devices answers. The device the DM was typed on answers when it said it
    // can run the agent. Otherwise every device that can run it claims the DM, and the claimant
    // with the lowest device id answers. Claims are settled before any model call, so a slow
    // answer can't make a second device step in.
    const sentHere = item.device === this.store.deviceId
    if (!sentHere || item.senderRuns === false) {
      if (item.device && item.senderRuns) return // the sending device answers
      const claims = this.dmClaims.get(item.id) ?? new Set<string>()
      this.dmClaims.set(item.id, claims)
      await this.store.client.claimDM(item.id).catch(() => {})
      await new Promise((r) => setTimeout(r, 2500))
      const winner = [...claims].sort()[0]
      this.dmClaims.delete(item.id)
      if (winner !== this.store.deviceId) return
    }
    this.enqueue(def, async () => {
      this.setStatus(def.pk, 'Thinking…')
      try {
        const { text } = await this.turn(
          def,
          {
            session: 'dm',
            instructions: `You are "${def.name}", the personal AI agent of ${this.store.profile.name || 'your owner'}, talking privately with them in Beamhop.\n\n${def.instructions}`,
            context: { dm: true },
            prompt: item.text,
            allowTools: true,
          },
          () => {},
          (s) => this.setStatus(def.pk, s),
        )
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
