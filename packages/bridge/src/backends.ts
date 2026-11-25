// Agent backends the bridge can drive: any ACP agent (fx, Claude Code, Gemini CLI, Codex…) or a plain command.
import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { client as acpClient, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

export interface TurnInput {
  prompt: string
  /** May the agent use tools that change things on this machine for this turn? */
  allowTools: boolean
  onText: (delta: string) => void
  onStatus: (s: string) => void
  signal?: AbortSignal
}

export interface Backend {
  name: string
  init?(): Promise<void>
  run(t: TurnInput): Promise<string>
  close(): Promise<void>
}

export const PRESETS: Record<string, { cmd: string; args: string[]; label: string; install: string }> = {
  fx: { cmd: 'fx', args: ['acp'], label: 'fx', install: 'curl -fsSL https://fx.sh/setup.sh | bash, then fx login' },
  claude: { cmd: 'npx', args: ['-y', '@zed-industries/claude-code-acp'], label: 'Claude Code', install: 'npm i -g @anthropic-ai/claude-code, then run claude once to sign in' },
  gemini: { cmd: 'gemini', args: ['--experimental-acp'], label: 'Gemini CLI', install: 'npm i -g @google/gemini-cli, then run gemini once to sign in' },
  codex: { cmd: 'npx', args: ['-y', '@zed-industries/codex-acp'], label: 'Codex', install: 'npm i -g @openai/codex, then codex login' },
}

/** An ACP agent subprocess with one long-lived session per room. */
export class AcpBackend implements Backend {
  private proc!: ChildProcess
  private ctx: any
  private session: any
  private ready: Promise<void>
  private turnAllow = false
  private closeConn?: () => void
  private exited = ''
  constructor(
    public name: string,
    private cmd: string,
    private args: string[],
    private cwd: string,
    private installHint = '',
  ) {
    this.ready = this.start()
    this.ready.catch(() => {})
  }

  /** Resolves once the agent has started and opened a session; rejects with why it couldn't. */
  init() {
    return this.ready
  }

  private start() {
    return new Promise<void>((resolve, reject) => {
      this.proc = spawn(this.cmd, this.args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'inherit'], env: process.env, shell: process.platform === 'win32' })
      this.proc.once('error', (e) => reject(new Error(`Couldn't start ${this.name} (${this.cmd}): ${e.message}${this.installHint ? `. Install it: ${this.installHint}` : ''}`)))
      this.proc.once('exit', (code) => {
        this.exited = `${this.name} stopped (exit code ${code}). Check that it is installed and signed in${this.installHint ? ` (${this.installHint})` : ''}.`
        if (process.env.CLAUDECODE) this.exited += ' Note: Claude Code refuses to start inside another Claude Code session; run the bridge from a normal terminal.'
        reject(new Error(this.exited))
      })
      this.proc.stdin!.on('error', () => {})
      const stream = ndJsonStream(Writable.toWeb(this.proc.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(this.proc.stdout!) as unknown as ReadableStream<Uint8Array>)
      const app = acpClient({ name: 'beamhop-bridge' })
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
            clientInfo: { name: 'beamhop-bridge', version: '0.1.0' },
          })
          this.session = await ctx.buildSession(this.cwd).start()
          resolve()
          await closed
        })
        .catch(reject)
    })
  }

  async run(t: TurnInput) {
    await this.ready
    if (this.exited) throw new Error(this.exited)
    this.turnAllow = t.allowTools
    const s = this.session
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
    await pending.catch(() => {})
    return text
  }

  async close() {
    this.closeConn?.()
    this.proc?.kill()
  }
}

/** Runs a shell command per turn: the prompt goes to stdin, stdout is the reply. */
export class CommandBackend implements Backend {
  constructor(
    public name: string,
    private command: string,
    private cwd: string,
  ) {}
  run(t: TurnInput) {
    return new Promise<string>((resolve, reject) => {
      const p = spawn(this.command, { cwd: this.cwd, shell: true, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, BEAMHOP_ALLOW_TOOLS: t.allowTools ? '1' : '0' } })
      let out = ''
      p.stdout.on('data', (d) => {
        out += d
        t.onText(String(d))
      })
      p.on('error', reject)
      p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${this.command} exited with ${code}`))))
      p.stdin.end(t.prompt)
    })
  }
  async close() {}
}
