// Drives a coding-agent harness running in the machine over ACP (the Agent Client Protocol), as the
// bridge does on a computer (packages/bridge/src/backends.ts): one process per agent, one ACP
// session per room or DM, the agent's reply streamed back as text.
import { client as acpClient, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { HARNESSES, type HarnessId } from '@beamhop/shared'
import { machine, type Proc } from './machine'

export interface TurnInput {
  /** Session key: one conversation per room (or DM). */
  session: string
  prompt: string
  /** May the harness run tools that change things for this turn (only when its owner asked)? */
  allowTools: boolean
  onText: (delta: string) => void
  onStatus: (s: string) => void
}

export class HarnessAgent {
  private proc: Proc | null = null
  private ctx: any
  private sessions = new Map<string, any>()
  private ready: Promise<void>
  private turnAllow = false
  private closeConn?: () => void
  private stopped = ''
  private stderrTail = ''
  /** Serializes turns: one prompt at a time per harness process. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    readonly agentId: string,
    readonly harness: HarnessId,
    private env: Record<string, string>,
    /** Model id to select in each new session; empty keeps the harness's default. */
    private model = '',
  ) {
    this.ready = this.start()
    this.ready.catch(() => {})
  }

  private async start() {
    const h = HARNESSES[this.harness]
    const cwd = machine.workDir(this.agentId)
    await machine.exec(`mkdir -p '${cwd}'`)
    this.proc = await machine.spawn(h.acp.cmd, h.acp.args, { env: this.env, cwd })
    this.drainStderr(this.proc.stderr)
    const stream = ndJsonStream(this.proc.stdin, this.proc.stdout)
    await new Promise<void>((resolve, reject) => {
      const app = acpClient({ name: 'beamhop' })
        .onRequest('session/request_permission', async ({ params }: any) => {
          const opts: any[] = params.options ?? []
          const allow = opts.find((o) => o.kind === 'allow_once') ?? opts.find((o) => o.kind === 'allow_always')
          const deny = opts.find((o) => o.kind === 'reject_once') ?? opts.find((o) => o.kind === 'reject_always')
          if (this.turnAllow && allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
          if (deny) return { outcome: { outcome: 'selected', optionId: deny.optionId } }
          return { outcome: { outcome: 'cancelled' } }
        })
        .onNotification('session/update', () => {})
      let done!: () => void
      const closed = new Promise<void>((r) => (done = r))
      this.closeConn = done
      app
        .connectWith(stream, async (ctx: any) => {
          this.ctx = ctx
          await ctx.request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: 'beamhop', version: '0.1.0' },
          })
          resolve()
          await closed
        })
        .then(
          () => {
            this.stopped ||= `${h.label} stopped.`
          },
          (e: any) => {
            this.stopped = this.explain(e)
            reject(new Error(this.stopped))
          },
        )
    })
  }

  private drainStderr(s: ReadableStream<Uint8Array>) {
    const dec = new TextDecoder()
    ;(async () => {
      const r = s.getReader()
      for (;;) {
        const { value, done } = await r.read()
        if (done) break
        this.stderrTail = (this.stderrTail + dec.decode(value, { stream: true })).slice(-2000)
      }
    })().catch(() => {})
  }

  private explain(e: any) {
    const h = HARNESSES[this.harness]
    const tail = this.stderrTail.trim().split('\n').slice(-4).join('\n')
    return `${h.label} stopped${e?.message ? `: ${e.message}` : ''}.${tail ? `\n${tail}` : ''}`
  }

  init() {
    return this.ready
  }

  get alive() {
    return !this.stopped
  }

  run(t: TurnInput): Promise<string> {
    const job = this.chain.then(() => this.runNow(t))
    this.chain = job.catch(() => {})
    return job
  }

  private async runNow(t: TurnInput) {
    await this.ready
    if (this.stopped) throw new Error(this.stopped)
    let s = this.sessions.get(t.session)
    if (!s) {
      t.onStatus('Starting…')
      s = await this.ctx.buildSession(machine.workDir(this.agentId)).start()
      if (this.model) await this.selectModel(s, this.model)
      this.sessions.set(t.session, s)
    }
    this.turnAllow = t.allowTools
    const pending = s.prompt(t.prompt)
    let text = ''
    for (;;) {
      const m = await s.nextUpdate()
      if (m.kind === 'stop') break
      const u: any = m.update
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
        text += u.content.text
        t.onText(u.content.text)
      } else if (u.sessionUpdate === 'tool_call') t.onStatus(`${u.title ?? 'Using a tool'}…`)
      else if (u.sessionUpdate === 'agent_thought_chunk') t.onStatus('Thinking…')
    }
    await pending.catch((e: any) => {
      if (!text) throw new Error(this.explain(e))
    })
    return text
  }

  /** The models this harness offers, from a throwaway session. */
  async listModels(): Promise<HarnessModel[]> {
    await this.ready
    if (this.stopped) throw new Error(this.stopped)
    const s = await this.ctx.buildSession(machine.workDir(this.agentId)).start()
    try {
      return sessionModels(s.newSessionResponse).list
    } finally {
      s.dispose?.()
    }
  }

  private async selectModel(s: any, id: string) {
    const m = sessionModels(s.newSessionResponse)
    if (m.current === id || !m.list.some((x) => x.id === id)) return
    if (m.configId) await this.ctx.request('session/set_config_option', { sessionId: s.sessionId, configId: m.configId, value: id })
    else await this.ctx.request('session/set_model', { sessionId: s.sessionId, modelId: id })
  }

  close() {
    this.stopped ||= 'closed'
    this.closeConn?.()
    this.proc?.kill()
  }

  /** Is this the session for `key`, i.e. does it already have the agent's instructions? */
  hasSession(key: string) {
    return this.sessions.has(key)
  }
}

export interface HarnessModel {
  id: string
  name?: string
  description?: string
}

/** Models from a `session/new` response: the `model` config option, or the older `models` field. */
function sessionModels(r: any): { list: HarnessModel[]; current?: string; configId?: string } {
  const opt = (r?.configOptions ?? []).find((o: any) => o.category === 'model' && o.type === 'select')
  if (opt) {
    const flat = (opt.options ?? []).flatMap((o: any) => (Array.isArray(o.options) ? o.options : [o]))
    return { list: flat.map((o: any) => ({ id: o.value, name: o.name, description: o.description ?? undefined })), current: opt.currentValue, configId: opt.id }
  }
  const m = r?.models
  if (m?.availableModels) return { list: m.availableModels.map((x: any) => ({ id: x.modelId, name: x.name, description: x.description ?? undefined })), current: m.currentModelId }
  return { list: [] }
}
