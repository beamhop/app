import { machine } from '../machine/machine'
import {
  BeamhopClient,
  DEFAULT_BLOSSOM,
  DEFAULT_CAPS,
  DEFAULT_RELAYS,
  bytesToHex,
  generateSecretKey,
  getPublicKey,
  hexToBytes,
  randomHex,
  uniqueName,
} from '@beamhop/shared'
import { kv } from './kv'
import { detectExtension, extensionVersion } from './extension'
import type { AgentDef, Profile, Settings } from './types'
import { AgentRunner } from '../agents/runner'
import { onCredsChange } from '../agents/providers'

export interface Toast {
  id: string
  text: string
  kind?: 'info' | 'error'
  action?: { label: string; href: string }
}

export class Store {
  ready = false
  client!: BeamhopClient
  sk!: Uint8Array
  pk = ''
  deviceId = ''
  profile: Profile = { name: '', updatedAt: 0 }
  settings: Settings = { relays: DEFAULT_RELAYS, blossom: DEFAULT_BLOSSOM, updatedAt: 0 }
  agents: AgentDef[] = []
  ext: string | null = null
  toasts: Toast[] = []
  runner!: AgentRunner
  installPrompt: any = null
  private version = 0
  private listeners = new Set<() => void>()
  private syncTimer: any

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  getVersion = () => this.version
  bump = () => {
    this.version++
    this.listeners.forEach((f) => f())
  }

  async init() {
    let id = await kv.get<{ sk: string }>('identity')
    if (!id) {
      id = { sk: bytesToHex(generateSecretKey()) }
      await kv.set('identity', id)
    }
    this.sk = hexToBytes(id.sk)
    this.pk = getPublicKey(this.sk)
    this.deviceId = (await kv.get<string>('deviceId')) ?? randomHex(8)
    await kv.set('deviceId', this.deviceId)
    this.profile = (await kv.get<Profile>('profile')) ?? this.profile
    this.settings = (await kv.get<Settings>('settings')) ?? this.settings
    this.agents = (await kv.get<AgentDef[]>('agents')) ?? []
    this.client = new BeamhopClient({ sk: this.sk, kv, relays: this.activeRelays(), deviceId: this.deviceId })
    for (const a of this.agents) if (!a.deleted) this.client.addIdentity(hexToBytes(a.sk))
    this.client.on('change', () => this.bump())
    this.client.on('error', (e) => this.toast(e, 'error'))
    this.client.on('agent-joined', ({ name }) => this.toast(`${name} joined as your agent`))
    await this.client.start()
    await machine.load()
    machine.onChange(() => this.bump())
    this.runner = new AgentRunner(this)
    this.runner.start()
    onCredsChange((provider) => {
      this.runner.invalidateProvider(provider)
      this.runner.refreshCapabilities()
      this.bump()
    })
    this.ready = true
    this.bump()
    detectExtension().then((v) => {
      this.ext = v
      this.runner.refreshCapabilities()
      this.bump()
    })
    this.pullRemote().catch(() => {})
    setInterval(() => this.pullRemote().catch(() => {}), 60_000)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushSync()
      else this.pullRemote().catch(() => {})
    })
    window.addEventListener('pagehide', () => this.flushSync())
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault()
      this.installPrompt = e
      this.bump()
    })
  }

  get hasExtension() {
    return !!(this.ext ?? extensionVersion())
  }

  toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action']) {
    const t = { id: randomHex(4), text, kind, action }
    this.toasts = [...this.toasts, t]
    this.bump()
    setTimeout(() => {
      this.toasts = this.toasts.filter((x) => x.id !== t.id)
      this.bump()
    }, kind === 'error' ? 7000 : 4000)
  }

  // ---------------------------------------------------------------- profile & settings
  async setName(name: string) {
    this.profile = { name: name.trim().slice(0, 60), updatedAt: Date.now() }
    await kv.set('profile', this.profile)
    this.scheduleSync()
    this.bump()
  }

  /** The relays to use: a ?relay= URL override (local dev and tests) wins over saved settings. */
  private activeRelays() {
    const override = new URLSearchParams(location.search).get('relay')
    return override ? [override] : this.settings.relays
  }

  async saveSettings(s: Partial<Settings>) {
    this.settings = { ...this.settings, ...s, updatedAt: Date.now() }
    await kv.set('settings', this.settings)
    this.client.relays = this.activeRelays()
    this.client.resubscribeInbox()
    this.scheduleSync()
    this.bump()
  }

  // ---------------------------------------------------------------- agents
  liveAgents() {
    return this.agents.filter((a) => !a.deleted)
  }
  agentByPk(pk: string) {
    return this.liveAgents().find((a) => a.pk === pk)
  }

  async createAgent(p: Partial<AgentDef>): Promise<AgentDef> {
    const sk = generateSecretKey()
    const now = Date.now()
    const def: AgentDef = {
      id: randomHex(8),
      sk: bytesToHex(sk),
      pk: getPublicKey(sk),
      name: p.name || 'Agent',
      emoji: p.emoji || '🤖',
      ...(p.runtime ? { runtime: p.runtime } : {}),
      ...(p.harness ? { harness: p.harness } : {}),
      ...(p.customCommand ? { customCommand: p.customCommand } : {}),
      provider: p.provider || 'openrouter',
      model: p.model ?? '',
      instructions: p.instructions ?? '',
      tools: p.tools ?? { web: true, sandbox: true },
      mode: p.mode ?? 'mention',
      instructors: p.instructors ?? 'everyone',
      caps: p.caps ?? { ...DEFAULT_CAPS },
      createdAt: now,
      updatedAt: now,
    }
    this.agents = [...this.agents, def]
    this.client.addIdentity(sk)
    await this.persistAgents()
    await this.runner.refreshCapabilities()
    return def
  }

  async updateAgent(id: string, patch: Partial<AgentDef>) {
    this.agents = this.agents.map((a) => (a.id === id ? { ...a, ...patch, updatedAt: Date.now() } : a))
    await this.persistAgents()
    this.runner.invalidate(id)
  }

  async deleteAgent(id: string) {
    const a = this.agents.find((x) => x.id === id)
    if (!a) return
    for (const roomId of this.client.rooms.keys()) {
      const st = this.client.state(roomId)
      if (st?.agents[a.pk]) await this.client.removeAgent(roomId, a.pk).catch(() => {})
    }
    this.agents = this.agents.map((x) => (x.id === id ? { ...x, deleted: true, updatedAt: Date.now(), sk: '' } : x))
    this.client.removeIdentity(a.pk)
    this.runner.invalidate(id)
    await this.persistAgents()
  }

  /** Add one of my browser agents to a room. */
  async addAgentToRoom(roomId: string, def: AgentDef) {
    const st = this.client.state(roomId)
    if (!st) throw new Error('Room not found')
    if (st.agents[def.pk]) return
    await this.client.stateOp(roomId, {
      op: 'agent-add',
      pubkey: def.pk,
      name: uniqueName(st, def.name),
      kind: 'browser',
      mode: def.mode,
      instructors: def.instructors,
      emoji: def.emoji,
      model: def.model,
    })
    this.runner.refreshCapabilities()
  }

  private async persistAgents() {
    await kv.set('agents', this.agents)
    this.scheduleSync()
    this.bump()
  }

  // ---------------------------------------------------------------- multi-device sync (NIP-78, encrypted to self)
  private scheduleSync() {
    clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      this.pushRemote().catch(() => {})
    }, 1500)
  }

  async pushRemote() {
    await this.client.saveAppData('v1', { profile: this.profile, settings: this.settings, agents: this.agents })
  }

  async pullRemote() {
    const remote = await this.client.loadAppData<{ profile?: Profile; settings?: Settings; agents?: AgentDef[] }>('v1')
    if (!remote) {
      if (this.profile.name || this.agents.length) this.scheduleSync()
      return
    }
    let changed = false
    if (remote.profile && remote.profile.updatedAt > this.profile.updatedAt) {
      this.profile = remote.profile
      await kv.set('profile', this.profile)
      changed = true
    }
    if (remote.settings && remote.settings.updatedAt > this.settings.updatedAt) {
      this.settings = remote.settings
      await kv.set('settings', this.settings)
      changed = true
    }
    const byId = new Map(this.agents.map((a) => [a.id, a]))
    for (const ra of remote.agents ?? []) {
      const la = byId.get(ra.id)
      if (!la || ra.updatedAt > la.updatedAt) {
        byId.set(ra.id, ra)
        changed = true
        if (!ra.deleted && ra.sk) this.client.addIdentity(hexToBytes(ra.sk))
        else this.client.removeIdentity(ra.pk)
        this.runner.invalidate(ra.id)
      }
    }
    if (changed) {
      this.agents = [...byId.values()]
      await kv.set('agents', this.agents)
      this.runner.refreshCapabilities()
      this.bump()
    }
    // push our newer local state back
    const needPush =
      (this.profile.updatedAt > (remote.profile?.updatedAt ?? 0)) ||
      this.settings.updatedAt > (remote.settings?.updatedAt ?? 0) ||
      this.agents.some((a) => a.updatedAt > ((remote.agents ?? []).find((r) => r.id === a.id)?.updatedAt ?? 0))
    if (needPush) await this.pushRemote().catch(() => this.scheduleSync())
  }

  /** Push pending changes now (e.g. before the page is hidden or another device pairs). */
  async flushSync() {
    if (!this.syncTimer) return
    clearTimeout(this.syncTimer)
    this.syncTimer = null
    await this.pushRemote().catch(() => {})
  }

  // ---------------------------------------------------------------- identity
  exportNsec() {
    return bytesToHex(this.sk)
  }

  async replaceIdentity(skHex: string, profile?: Profile) {
    await this.client.stop()
    await kv.clear()
    await kv.set('identity', { sk: skHex })
    if (profile) await kv.set('profile', profile)
    location.hash = '#/'
    location.reload()
  }

  async deleteEverything() {
    for (const roomId of [...this.client.rooms.keys()]) {
      const st = this.client.state(roomId)
      const admin = st?.admins.includes(this.pk)
      const others = st ? Object.keys(st.members).filter((m) => m !== this.pk) : []
      await this.client.leave(roomId, admin && others.length ? { newAdmin: others[0] } : {}).catch(() => {})
    }
    await this.client.deleteAppData(['v1']).catch(() => {})
    await this.client.stop()
    await kv.clear()
    localStorage.clear()
    location.hash = '#/'
    location.reload()
  }
}

export const store = new Store()
;(globalThis as any).__beamhop = store
