import { SimplePool } from 'nostr-tools/pool'
import type { Filter } from 'nostr-tools/filter'
import {
  decryptFromSelf,
  encryptToSelf,
  finalizeEvent,
  getPublicKey,
  giftWrap,
  makeRumor,
  newKey,
  outerKeyFor,
  roomTag,
  signInner,
  unwrapGift,
  unwrapRoomEvent,
  wrapRoomEvent,
  type Event,
  type Rumor,
} from './crypto.js'
import { initialState, isAdmin, keyRecipients, reduceState, displayName } from './state.js'
import {
  KIND,
  type AgentInvite,
  type Control,
  type Decoded,
  type FileRef,
  type Hex,
  type HumanInvite,
  type Payload,
  type RoomState,
  type StateOp,
} from './types.js'
import { DEFAULT_RELAYS } from './links.js'
import { Emitter, hexToBytes, bytesToHex, nowSec, randomHex, sleep } from './util.js'
import { resolveMentions } from './policy.js'

export interface KV {
  get<T = any>(key: string): Promise<T | undefined>
  set(key: string, v: any): Promise<void>
  del(key: string): Promise<void>
}

export class MemoryKV implements KV {
  m = new Map<string, any>()
  async get(k: string) {
    const v = this.m.get(k)
    return v === undefined ? undefined : structuredClone(v)
  }
  async set(k: string, v: any) {
    this.m.set(k, structuredClone(v))
  }
  async del(k: string) {
    this.m.delete(k)
  }
}

export interface RoomKey {
  epoch: number
  key: Hex
  tag: string
  at: number
}

export interface RoomLocal {
  roomId: string
  relays: string[]
  keys: RoomKey[]
  base: RoomState
  joinedAt: number
  left?: boolean
  agentSecret?: Hex
  lastRead?: number
  names: Record<Hex, string>
}

export interface PendingJoin {
  roomId: string
  lobbyKey: Hex
  relays: string[]
  name: string
  host: string
  myName: string
  at: number
  denied?: boolean
  asAgent?: boolean
}

export interface StreamState {
  sid: string
  pubkey: Hex
  text: string
  status?: string
  trigger?: string
  done?: boolean
  ts: number
}

export interface DMItem {
  id: string
  from: Hex
  to: Hex
  text: string
  ms: number
}

export interface Presence {
  ts: number
  device?: string
  agents: Hex[]
}

export interface ClientEvents {
  change: string | undefined // roomId or undefined for global
  message: { roomId: string; ev: Decoded; live: boolean }
  dm: { identity: Hex; peer: Hex; item: DMItem; live: boolean }
  'agent-joined': { roomId: string; agentPk: Hex; name: string }
  'key-received': { roomId: string; epoch: number }
  error: string
}

export interface ClientOptions {
  sk: Uint8Array
  kv: KV
  relays?: string[]
  deviceId?: string
  pool?: SimplePool
  /** True when this client is a bridge agent identity (not a person). */
  agentMode?: boolean
}

const LIVE_SLACK = 30

export class BeamhopClient extends Emitter<ClientEvents> {
  sk: Uint8Array
  pk: Hex
  kv: KV
  pool: SimplePool
  relays: string[]
  deviceId: string
  agentMode: boolean
  identities = new Map<Hex, Uint8Array>()
  rooms = new Map<string, RoomLocal>()
  pending = new Map<string, PendingJoin>()
  events = new Map<string, Map<string, Decoded>>()
  lobbyKnocks = new Map<string, Map<Hex, Decoded>>()
  denies = new Map<string, Set<Hex>>()
  typing = new Map<string, Map<Hex, number>>()
  presence = new Map<string, Map<Hex, Presence>>()
  streams = new Map<string, Map<string, StreamState>>()
  dms = new Map<string, DMItem[]>() // key `${identity}:${peer}`
  localAgentsByRoom = new Map<string, Set<Hex>>() // agents this device can run, per room
  private stateCache = new Map<string, { v: number; s: RoomState }>()
  private versions = new Map<string, number>()
  private tagIndex = new Map<string, { roomId: string; key: Hex; epoch: number; lobby?: boolean }>()
  private subs = new Map<string, { close: () => void; sig: string }>()
  private inboxSub?: { close: () => void; sig: string }
  private startedAt = nowSec()
  private saveTimers = new Map<string, any>()
  private presenceTimer: any
  private seenWraps = new Set<string>()
  private rotationTimers = new Map<string, any>()
  closed = false

  constructor(o: ClientOptions) {
    super()
    this.sk = o.sk
    this.pk = getPublicKey(o.sk)
    this.kv = o.kv
    this.relays = o.relays?.length ? o.relays : DEFAULT_RELAYS
    this.deviceId = o.deviceId ?? randomHex(8)
    this.agentMode = !!o.agentMode
    this.pool = o.pool ?? new SimplePool({ enablePing: true, enableReconnect: true } as any)
    ;(this.pool as any).automaticallyAuth = () => async (evt: any) => finalizeEvent(evt, this.sk)
    this.identities.set(this.pk, this.sk)
  }

  // ---------------------------------------------------------------- lifecycle
  async start() {
    const rooms = (await this.kv.get<RoomLocal[]>('rooms')) ?? []
    for (const r of rooms) {
      this.rooms.set(r.roomId, r)
      for (const k of r.keys) this.tagIndex.set(k.tag, { roomId: r.roomId, key: k.key, epoch: k.epoch })
      const evs = (await this.kv.get<Decoded[]>('events:' + r.roomId)) ?? []
      const m = new Map<string, Decoded>()
      for (const e of evs) m.set(e.id, e)
      this.events.set(r.roomId, m)
    }
    const pend = (await this.kv.get<PendingJoin[]>('pending')) ?? []
    for (const p of pend) this.pending.set(p.roomId, p)
    const dms = (await this.kv.get<Record<string, DMItem[]>>('dms')) ?? {}
    for (const [k, v] of Object.entries(dms)) this.dms.set(k, v)
    this.refreshLobbyIndex()
    this.resubscribeAll()
    this.presenceTimer = setInterval(() => this.broadcastPresence(), 30_000)
    setTimeout(() => this.broadcastPresence(), 1500)
    this.emit('change', undefined)
  }

  async stop() {
    this.closed = true
    clearInterval(this.presenceTimer)
    for (const s of this.subs.values()) s.close()
    this.inboxSub?.close()
    for (const t of this.saveTimers.values()) clearTimeout(t)
    await this.flush()
    try {
      this.pool.close(this.allRelays())
    } catch {}
  }

  async flush() {
    await this.kv.set('rooms', [...this.rooms.values()])
    await this.kv.set('pending', [...this.pending.values()])
    await this.kv.set('dms', Object.fromEntries(this.dms))
    for (const id of this.rooms.keys()) await this.saveEvents(id)
  }

  addIdentity(sk: Uint8Array) {
    const pk = getPublicKey(sk)
    if (!this.identities.has(pk)) {
      this.identities.set(pk, sk)
      this.resubscribeInbox()
    }
    return pk
  }
  removeIdentity(pk: Hex) {
    if (pk === this.pk) return
    this.identities.delete(pk)
    this.resubscribeInbox()
  }

  setLocalAgents(roomId: string, agents: Hex[]) {
    const prev = [...(this.localAgentsByRoom.get(roomId) ?? [])].sort().join(',')
    this.localAgentsByRoom.set(roomId, new Set(agents))
    if (prev !== [...agents].sort().join(',')) {
      clearTimeout(this.presenceSoon)
      this.presenceSoon = setTimeout(() => this.broadcastPresence(), 300)
    }
  }
  private presenceSoon: any

  allRelays() {
    const s = new Set(this.relays)
    for (const r of this.rooms.values()) r.relays.forEach((x) => s.add(x))
    for (const p of this.pending.values()) p.relays.forEach((x) => s.add(x))
    return [...s]
  }

  private bump(roomId?: string) {
    if (roomId) this.versions.set(roomId, (this.versions.get(roomId) ?? 0) + 1)
    this.emit('change', roomId)
  }

  private scheduleSave(key: string, fn: () => Promise<void>, ms = 400) {
    clearTimeout(this.saveTimers.get(key))
    this.saveTimers.set(
      key,
      setTimeout(() => {
        this.saveTimers.delete(key)
        fn().catch((e) => console.error(e))
      }, ms),
    )
  }
  private saveRooms() {
    this.scheduleSave('rooms', () => this.kv.set('rooms', [...this.rooms.values()]))
  }
  private savePending() {
    this.scheduleSave('pending', () => this.kv.set('pending', [...this.pending.values()]))
  }
  private async saveEvents(roomId: string) {
    const m = this.events.get(roomId)
    if (!m) return
    const arr = [...m.values()].sort((a, b) => a.ms - b.ms)
    // keep all state events, plus the last 1500 others
    const state = arr.filter((e) => e.payload.t === 'state')
    const rest = arr.filter((e) => e.payload.t !== 'state').slice(-1500)
    await this.kv.set('events:' + roomId, [...state, ...rest])
  }

  // ---------------------------------------------------------------- subscriptions
  private resubscribeAll() {
    this.resubscribeInbox()
    for (const id of this.rooms.keys()) this.resubscribeRoom(id)
    for (const p of this.pending.values()) this.resubscribePending(p)
  }

  private inboxRelays() {
    return this.allRelays()
  }

  resubscribeInbox() {
    if (this.closed) return
    const authors = [...this.identities.keys()]
    const relays = this.inboxRelays()
    const sig = authors.join(',') + '|' + relays.join(',')
    if (this.inboxSub?.sig === sig) return
    this.inboxSub?.close()
    const filter: Filter = { kinds: [KIND.GIFT_WRAP], '#p': authors }
    const sub = this.pool.subscribeMany(relays, filter, {
      onevent: (e: Event) => this.onWrap(e),
    })
    this.inboxSub = { close: () => sub.close(), sig }
  }

  private roomTags(r: RoomLocal) {
    const tags = r.keys.map((k) => k.tag)
    const st = this.state(r.roomId)
    if (st && isAdmin(st, this.pk) && !this.agentMode) tags.push(roomTag(st.lobbyKey))
    return tags
  }

  private refreshLobbyIndex() {
    for (const [tag, v] of [...this.tagIndex]) if (v.lobby) this.tagIndex.delete(tag)
    for (const r of this.rooms.values()) {
      const st = this.state(r.roomId)
      if (st) this.tagIndex.set(roomTag(st.lobbyKey), { roomId: r.roomId, key: st.lobbyKey, epoch: -1, lobby: true })
    }
    for (const p of this.pending.values())
      this.tagIndex.set(roomTag(p.lobbyKey), { roomId: p.roomId, key: p.lobbyKey, epoch: -1, lobby: true })
  }

  resubscribeRoom(roomId: string) {
    if (this.closed) return
    const r = this.rooms.get(roomId)
    if (!r || r.left) {
      this.subs.get(roomId)?.close()
      this.subs.delete(roomId)
      return
    }
    const tags = this.roomTags(r)
    const sig = tags.join(',') + '|' + r.relays.join(',')
    if (this.subs.get(roomId)?.sig === sig) return
    this.subs.get(roomId)?.close()
    const evs = this.events.get(roomId)
    let since = r.joinedAt - 120
    if (evs && evs.size) {
      let max = 0
      for (const e of evs.values()) if (e.created_at > max) max = e.created_at
      since = Math.max(since, max - 3600)
    }
    const relays = r.relays.length ? r.relays : this.relays
    const sub = this.pool.subscribeMany(relays, { kinds: [KIND.ROOM, KIND.ROOM_EPHEMERAL], '#h': tags, since }, {
      onevent: (e: Event) => this.onRoomOuter(e),
    })
    this.subs.set(roomId, { close: () => sub.close(), sig })
  }

  private resubscribePending(p: PendingJoin) {
    const key = 'pending:' + p.roomId
    this.subs.get(key)?.close()
    const tag = roomTag(p.lobbyKey)
    this.tagIndex.set(tag, { roomId: p.roomId, key: p.lobbyKey, epoch: -1, lobby: true })
    const sub = this.pool.subscribeMany(p.relays, { kinds: [KIND.ROOM], '#h': [tag], since: p.at - 60 }, {
      onevent: (e: Event) => this.onRoomOuter(e),
    })
    this.subs.set(key, { close: () => sub.close(), sig: tag })
    this.resubscribeInbox()
  }

  // ---------------------------------------------------------------- incoming
  private onRoomOuter(outer: Event) {
    const tag = outer.tags.find((t) => t[0] === 'h')?.[1]
    if (!tag) return
    const k = this.tagIndex.get(tag)
    if (!k) return
    const d = unwrapRoomEvent(outer, k.key, k.roomId)
    if (!d) return
    d.epoch = k.epoch
    if (k.lobby) return this.onLobbyEvent(k.roomId, d, k.key)
    const live = d.created_at >= this.startedAt - LIVE_SLACK
    if (outer.kind === KIND.ROOM_EPHEMERAL) return this.onEphemeral(k.roomId, d)
    const m = this.events.get(k.roomId) ?? new Map()
    this.events.set(k.roomId, m)
    if (m.has(d.id)) return
    m.set(d.id, d)
    if (d.payload.t === 'state') {
      this.stateCache.delete(k.roomId)
      this.afterStateEvent(k.roomId, d, live)
    }
    if (d.payload.t === 'msg') {
      // a final message supersedes its stream
      const sid = (d.payload as any).sid
      if (sid) this.streams.get(k.roomId)?.delete(sid)
      this.typing.get(k.roomId)?.delete(d.pubkey)
    }
    this.scheduleSave('events:' + k.roomId, () => this.saveEvents(k.roomId), 1000)
    this.bump(k.roomId)
    this.emit('message', { roomId: k.roomId, ev: d, live })
  }

  private onEphemeral(roomId: string, d: Decoded) {
    const now = Date.now()
    if (now - d.ms > 120_000) return
    const st = this.state(roomId)
    if (!st || !(st.members[d.pubkey] || st.agents[d.pubkey])) return
    const p = d.payload
    if (p.t === 'typing') {
      const m = this.typing.get(roomId) ?? new Map()
      m.set(d.pubkey, now)
      this.typing.set(roomId, m)
    } else if (p.t === 'presence') {
      const m = this.presence.get(roomId) ?? new Map()
      const info = { ts: now, device: p.device, agents: Array.isArray(p.agents) ? p.agents : [] }
      m.set(d.pubkey, info)
      this.presence.set(roomId, m)
      if (p.device) {
        const dk = `${roomId}:${d.pubkey}`
        const dm = this.devicePresence.get(dk) ?? new Map()
        dm.set(p.device, info)
        this.devicePresence.set(dk, dm)
      }
    } else if (p.t === 'stream') {
      const m = this.streams.get(roomId) ?? new Map()
      // ignore streams for which the final message already arrived
      const evs = this.events.get(roomId)
      if (evs) for (const e of evs.values()) if ((e.payload as any).sid === p.sid) return
      const prev = m.get(p.sid)
      if (prev && prev.ts > d.ms) return
      m.set(p.sid, { sid: p.sid, pubkey: d.pubkey, text: p.text, status: p.status, trigger: p.trigger, done: p.done, ts: d.ms })
      this.streams.set(roomId, m)
    } else return
    this.bump(roomId)
  }

  private onLobbyEvent(roomId: string, d: Decoded, lobbyKey: Hex) {
    ;(d as any).lobbyKey = lobbyKey
    if (d.payload.t === 'knock') {
      const m = this.lobbyKnocks.get(roomId) ?? new Map()
      const prev = m.get(d.pubkey)
      if (!prev || prev.ms < d.ms) m.set(d.pubkey, d)
      this.lobbyKnocks.set(roomId, m)
    } else if (d.payload.t === 'deny') {
      const s = this.denies.get(roomId) ?? new Set()
      s.add(d.payload.pubkey)
      this.denies.set(roomId, s)
      const p = this.pending.get(roomId)
      if (p && d.payload.pubkey === this.pk) {
        p.denied = true
        this.savePending()
      }
    }
    this.bump(roomId)
  }

  private afterStateEvent(roomId: string, d: Decoded, live: boolean) {
    const r = this.rooms.get(roomId)
    if (!r) return
    const st = this.state(roomId)!
    for (const [pk, m] of Object.entries(st.members)) r.names[pk] = m.name
    for (const [pk, a] of Object.entries(st.agents)) r.names[pk] = a.name
    this.refreshLobbyIndex()
    this.resubscribeRoom(roomId)
    this.saveRooms()
    if (!live) return
    const op = d.payload as any
    // Someone left / an agent was removed by a non-admin: an admin rotates the key.
    const needsRotation =
      (op.op === 'remove' && d.pubkey === op.pubkey) || (op.op === 'agent-remove' && !isAdmin(st, d.pubkey))
    if (needsRotation && isAdmin(st, this.pk) && !this.agentMode && d.pubkey !== this.pk) {
      const epochAtOp = this.currentKey(roomId)?.epoch ?? 0
      clearTimeout(this.rotationTimers.get(roomId))
      this.rotationTimers.set(
        roomId,
        setTimeout(() => {
          if ((this.currentKey(roomId)?.epoch ?? 0) > epochAtOp) return
          this.rotate(roomId).catch((e) => this.emit('error', String(e)))
        }, 500 + Math.random() * 3000),
      )
    }
  }

  private onWrap(wrap: Event) {
    if (this.seenWraps.has(wrap.id)) return
    this.seenWraps.add(wrap.id)
    const recipient = wrap.tags.find((t) => t[0] === 'p')?.[1]
    if (!recipient) return
    const sk = this.identities.get(recipient)
    if (!sk) return
    const rumor = unwrapGift(wrap, sk)
    if (!rumor) return
    if (rumor.kind === KIND.DM) return this.onDM(recipient, rumor)
    if (rumor.kind !== KIND.CONTROL) return
    let c: Control
    try {
      c = JSON.parse(rumor.content)
    } catch {
      return
    }
    if (c.t === 'key') this.onKey(recipient, rumor, c)
    else if (c.t === 'agent-join') this.onAgentJoin(recipient, rumor, c)
  }

  private onKey(recipient: Hex, rumor: Rumor, c: Extract<Control, { t: 'key' }>) {
    const snap = c.snapshot
    if (!snap || snap.roomId !== c.roomId || !/^[0-9a-f]{64}$/.test(c.key)) return
    const author = rumor.pubkey
    const existing = this.rooms.get(c.roomId)
    const recipientIsMe = recipient === this.pk
    const recipientInSnap = !!(snap.members[recipient] || snap.agents[recipient])
    if (!recipientInSnap) return
    const authorAdminInSnap = snap.admins.includes(author)
    const fromOwner = !!snap.agents[recipient] && snap.agents[recipient].owner === author
    const fromSelf = author === this.pk
    if (!(authorAdminInSnap || fromOwner || fromSelf)) return
    // For in-browser agents (non-primary identities) we already hold the user's keys.
    if (!recipientIsMe && !this.agentMode) return
    if (existing) {
      const cur = this.state(c.roomId)
      if (cur && !(isAdmin(cur, author) || fromOwner || fromSelf) && !authorAdminInSnap) return
      if (existing.left && !this.pending.has(c.roomId)) return
      if (existing.keys.some((k) => k.key === c.key)) return
      existing.left = false
      existing.keys.push({ epoch: c.epoch, key: c.key, tag: roomTag(c.key), at: nowSec() })
      if (snap.epoch >= existing.base.epoch && snap.ts >= existing.base.ts) existing.base = snap
      if (c.relays?.length) existing.relays = c.relays
      this.tagIndex.set(roomTag(c.key), { roomId: c.roomId, key: c.key, epoch: c.epoch })
    } else {
      const joinedAt = snap.members[recipient]?.joinedAt ?? snap.agents[recipient]?.addedAt ?? nowSec()
      const r: RoomLocal = {
        roomId: c.roomId,
        relays: c.relays?.length ? c.relays : this.relays,
        keys: [{ epoch: c.epoch, key: c.key, tag: roomTag(c.key), at: nowSec() }],
        base: snap,
        joinedAt,
        names: {},
      }
      for (const [pk, m] of Object.entries(snap.members)) r.names[pk] = m.name
      for (const [pk, a] of Object.entries(snap.agents)) r.names[pk] = a.name
      this.rooms.set(c.roomId, r)
      this.events.set(c.roomId, this.events.get(c.roomId) ?? new Map())
      this.tagIndex.set(roomTag(c.key), { roomId: c.roomId, key: c.key, epoch: c.epoch })
    }
    if (this.pending.has(c.roomId)) {
      this.pending.delete(c.roomId)
      this.subs.get('pending:' + c.roomId)?.close()
      this.subs.delete('pending:' + c.roomId)
      this.savePending()
    }
    this.stateCache.delete(c.roomId)
    this.refreshLobbyIndex()
    this.saveRooms()
    this.resubscribeRoom(c.roomId)
    this.resubscribeInbox()
    this.bump(c.roomId)
    this.emit('key-received', { roomId: c.roomId, epoch: c.epoch })
  }

  private async onAgentJoin(recipient: Hex, rumor: Rumor, c: Extract<Control, { t: 'agent-join' }>) {
    if (recipient !== this.pk || this.agentMode) return
    const r = this.rooms.get(c.roomId)
    if (!r || !r.agentSecret || r.agentSecret !== c.secret) return
    if (rumor.pubkey !== c.agentPubkey) return
    const st = this.state(c.roomId)
    if (!st || !st.members[this.pk]) return
    if (!st.agents[c.agentPubkey]) {
      await this.stateOp(c.roomId, {
        op: 'agent-add',
        pubkey: c.agentPubkey,
        name: uniqueName(st, c.name || 'Agent'),
        kind: c.agentKind === 'browser' ? 'browser' : 'bridge',
        model: c.model,
      })
    } else if (st.agents[c.agentPubkey].owner !== this.pk) return
    await this.forwardKeyTo(c.roomId, c.agentPubkey)
    this.emit('agent-joined', { roomId: c.roomId, agentPk: c.agentPubkey, name: c.name })
  }

  private onDM(identity: Hex, rumor: Rumor) {
    const to = rumor.tags.find((t) => t[0] === 'p')?.[1]
    if (!to) return
    const peer = rumor.pubkey === identity ? to : rumor.pubkey
    const key = `${identity}:${peer}`
    const list = this.dms.get(key) ?? []
    if (list.some((x) => x.id === rumor.id)) return
    const item: DMItem = { id: rumor.id, from: rumor.pubkey, to, text: rumor.content, ms: rumor.created_at * 1000 }
    const msTag = rumor.tags.find((t) => t[0] === 'ms')?.[1]
    if (msTag) item.ms = Number(msTag) || item.ms
    list.push(item)
    list.sort((a, b) => a.ms - b.ms)
    this.dms.set(key, list.slice(-1000))
    this.scheduleSave('dms', () => this.kv.set('dms', Object.fromEntries(this.dms)))
    this.bump(undefined)
    this.emit('dm', { identity, peer, item, live: rumor.created_at >= this.startedAt - LIVE_SLACK })
  }

  // ---------------------------------------------------------------- state
  state(roomId: string): RoomState | undefined {
    const r = this.rooms.get(roomId)
    if (!r) return undefined
    const v = this.versions.get(roomId) ?? 0
    const c = this.stateCache.get(roomId)
    if (c && c.v === v) return c.s
    const evs = [...(this.events.get(roomId)?.values() ?? [])]
    const s = reduceState(r.base, evs)
    this.stateCache.set(roomId, { v, s })
    return s
  }

  messages(roomId: string): Decoded[] {
    const m = this.events.get(roomId)
    if (!m) return []
    return [...m.values()].sort((a, b) => a.ms - b.ms || (a.id < b.id ? -1 : 1))
  }

  nameOf(roomId: string, pk: Hex) {
    const st = this.state(roomId)
    if (st && (st.members[pk] || st.agents[pk])) return displayName(st, pk)
    return this.rooms.get(roomId)?.names[pk] ?? pk.slice(0, 8)
  }

  currentKey(roomId: string): RoomKey | undefined {
    const r = this.rooms.get(roomId)
    if (!r || !r.keys.length) return undefined
    return [...r.keys].sort((a, b) => b.epoch - a.epoch || (a.tag < b.tag ? -1 : 1))[0]
  }

  lobby(roomId: string): Decoded[] {
    const st = this.state(roomId)
    if (!st) return []
    const denied = this.denies.get(roomId) ?? new Set()
    const week = Date.now() - 7 * 86400_000
    return [...(this.lobbyKnocks.get(roomId)?.values() ?? [])].filter(
      (k) => !st.members[k.pubkey] && !denied.has(k.pubkey) && k.ms > week && (k as any).lobbyKey === st.lobbyKey,
    )
  }

  onlineAgents(roomId: string): Set<Hex> {
    const out = new Set<Hex>()
    const cutoff = Date.now() - 75_000
    for (const [pk, p] of this.presence.get(roomId) ?? []) {
      if (p.ts < cutoff) continue
      out.add(pk)
      p.agents.forEach((a) => out.add(a))
    }
    for (const a of this.localAgentsByRoom.get(roomId) ?? []) out.add(a)
    return out
  }

  onlinePeople(roomId: string): Set<Hex> {
    const out = new Set<Hex>([this.pk])
    const cutoff = Date.now() - 75_000
    for (const [pk, p] of this.presence.get(roomId) ?? []) if (p.ts >= cutoff) out.add(pk)
    return out
  }

  /** Devices of `owner` that announced they can run `agentPk`, plus this one if it can. */
  agentRunnerDevices(roomId: string, agentPk: Hex, owner: Hex): string[] {
    const out = new Set<string>()
    const cutoff = Date.now() - 75_000
    const p = this.presence.get(roomId)?.get(owner)
    // presence keeps only the latest device per pubkey; track all devices separately
    for (const [dev, info] of this.devicePresence.get(`${roomId}:${owner}`) ?? []) {
      if (info.ts >= cutoff && info.agents.includes(agentPk)) out.add(dev)
    }
    if (p && p.ts >= cutoff && p.device && p.agents.includes(agentPk)) out.add(p.device)
    if (owner === this.pk && this.localAgentsByRoom.get(roomId)?.has(agentPk)) out.add(this.deviceId)
    return [...out].sort()
  }
  private devicePresence = new Map<string, Map<string, Presence>>()

  // ---------------------------------------------------------------- publishing
  private async publish(relays: string[], ev: Event) {
    const results = await Promise.allSettled(this.pool.publish(relays, ev))
    const ok = results.some((r) => r.status === 'fulfilled')
    if (!ok) throw new Error('No relay accepted the event: ' + results.map((r: any) => r.reason?.message ?? r.reason).join('; '))
  }

  signerFor(pk: Hex) {
    const sk = this.identities.get(pk)
    if (!sk) throw new Error('No key for ' + pk)
    return sk
  }

  async send(roomId: string, payload: Payload, opts: { as?: Hex; ephemeral?: boolean } = {}) {
    const r = this.rooms.get(roomId)
    const k = this.currentKey(roomId)
    if (!r || !k) throw new Error('Not in room')
    const sk = this.signerFor(opts.as ?? this.pk)
    const inner = signInner(sk, roomId, payload)
    const outer = wrapRoomEvent(sk, inner, k.key, !!opts.ephemeral)
    if (!opts.ephemeral) {
      // optimistic local insert
      this.onRoomOuter(outer)
    } else {
      if (payload.t === 'presence' || payload.t === 'stream') this.onEphemeralLocal(roomId, inner, payload)
    }
    await this.publish(r.relays, outer)
    return inner.id
  }

  private onEphemeralLocal(roomId: string, inner: any, payload: Payload) {
    if (payload.t === 'stream') {
      const m = this.streams.get(roomId) ?? new Map()
      m.set(payload.sid, { sid: payload.sid, pubkey: inner.pubkey, text: payload.text, status: payload.status, trigger: payload.trigger, done: payload.done, ts: Date.now() })
      this.streams.set(roomId, m)
      this.bump(roomId)
    }
  }

  async sendMessage(
    roomId: string,
    text: string,
    o: { reply?: string; files?: FileRef[]; as?: Hex; trigger?: string; hop?: number; sid?: string } = {},
  ) {
    const st = this.state(roomId)
    const mentions = st ? resolveMentions(st, text) : []
    const payload: any = { t: 'msg', text, mentions }
    if (o.reply) payload.reply = o.reply
    if (o.files?.length) payload.files = o.files
    if (o.trigger) payload.trigger = o.trigger
    if (o.hop !== undefined) payload.hop = o.hop
    if (o.sid) payload.sid = o.sid
    return this.send(roomId, payload, { as: o.as })
  }

  react(roomId: string, target: string, emoji: string, remove = false, as?: Hex) {
    return this.send(roomId, { t: 'react', target, emoji, remove }, { as })
  }
  edit(roomId: string, target: string, text: string) {
    return this.send(roomId, { t: 'edit', target, text })
  }
  async deleteMessage(roomId: string, target: string) {
    await this.send(roomId, { t: 'del', target })
    const ev = this.events.get(roomId)?.get(target)
    if (ev?.outerId) await this.requestDeletion(roomId, [target]).catch(() => {})
  }
  typingPing(roomId: string) {
    return this.send(roomId, { t: 'typing' }, { ephemeral: true }).catch(() => {})
  }
  stream(roomId: string, as: Hex, sid: string, text: string, extra: { trigger?: string; done?: boolean; status?: string } = {}) {
    return this.send(roomId, { t: 'stream', sid, text, ...extra }, { as, ephemeral: true }).catch(() => {})
  }

  async broadcastPresence() {
    if (this.closed) return
    for (const r of this.rooms.values()) {
      if (r.left) continue
      const st = this.state(r.roomId)
      if (!st || st.closed) continue
      const agents = [...(this.localAgentsByRoom.get(r.roomId) ?? [])]
      if (this.agentMode) {
        if (!st.agents[this.pk]) continue
      } else if (!st.members[this.pk]) continue
      this.send(r.roomId, { t: 'presence', device: this.deviceId, agents }, { ephemeral: true }).catch(() => {})
    }
  }

  async stateOp(roomId: string, op: StateOp, as?: Hex) {
    return this.send(roomId, { t: 'state', ...op } as Payload, { as })
  }

  // ---------------------------------------------------------------- rooms
  async createRoom(myName: string, name?: string): Promise<string> {
    const roomId = randomHex(16)
    const key = newKey()
    const lobbyKey = newKey()
    const now = nowSec()
    const st = initialState(roomId, this.pk, myName, lobbyKey, now)
    if (name) st.name = name
    const r: RoomLocal = {
      roomId,
      relays: this.relays.slice(0, 5),
      keys: [{ epoch: 0, key, tag: roomTag(key), at: now }],
      base: st,
      joinedAt: now - 5,
      names: { [this.pk]: myName },
    }
    this.rooms.set(roomId, r)
    this.events.set(roomId, new Map())
    this.tagIndex.set(roomTag(key), { roomId, key, epoch: 0 })
    this.refreshLobbyIndex()
    this.resubscribeRoom(roomId)
    this.resubscribeInbox()
    this.saveRooms()
    // Self-wrap so the user's other devices learn about the room.
    await this.sendKey(roomId, this.pk, { epoch: 0, key, tag: roomTag(key), at: now }, st).catch(() => {})
    this.bump(roomId)
    return roomId
  }

  private async sendKey(roomId: string, to: Hex, k: RoomKey, snapshot: RoomState) {
    const r = this.rooms.get(roomId)!
    const c: Control = { t: 'key', roomId, epoch: k.epoch, key: k.key, snapshot, relays: r.relays }
    const rumor = makeRumor(this.sk, KIND.CONTROL, JSON.stringify(c))
    await this.publish(this.allRelays(), giftWrap(rumor, this.sk, to))
  }

  async forwardKeyTo(roomId: string, to: Hex) {
    const k = this.currentKey(roomId)
    const st = this.state(roomId)
    if (!k || !st) return
    await this.sendKey(roomId, to, k, { ...st, epoch: k.epoch, ts: nowSec() })
  }

  /** Generate a new room key and deliver it to everyone currently in the room. */
  async rotate(roomId: string) {
    const st = this.state(roomId)
    const r = this.rooms.get(roomId)
    if (!st || !r || !isAdmin(st, this.pk) || st.closed) return
    const epoch = Math.max(...r.keys.map((k) => k.epoch)) + 1
    const key = newKey()
    const k: RoomKey = { epoch, key, tag: roomTag(key), at: nowSec() }
    const snapshot: RoomState = { ...st, epoch, ts: nowSec() }
    r.keys.push(k)
    r.base = snapshot
    this.tagIndex.set(k.tag, { roomId, key, epoch })
    this.stateCache.delete(roomId)
    this.saveRooms()
    this.resubscribeRoom(roomId)
    const recipients = new Set(keyRecipients(st))
    recipients.add(this.pk)
    await Promise.allSettled([...recipients].map((pk) => this.sendKey(roomId, pk, k, snapshot)))
    this.bump(roomId)
  }

  humanInvite(roomId: string): HumanInvite | undefined {
    const st = this.state(roomId)
    const r = this.rooms.get(roomId)
    if (!st || !r) return undefined
    return { v: 1, type: 'human', roomId, lobbyKey: st.lobbyKey, relays: r.relays, name: st.name, host: displayName(st, this.pk) }
  }

  async regenerateLobby(roomId: string) {
    await this.stateOp(roomId, { op: 'lobby', key: newKey() })
  }

  agentInvite(roomId: string): AgentInvite | undefined {
    const st = this.state(roomId)
    const r = this.rooms.get(roomId)
    if (!st || !r) return undefined
    if (!r.agentSecret) {
      r.agentSecret = newKey()
      this.saveRooms()
    }
    return { v: 1, type: 'agent', roomId, owner: this.pk, ownerName: displayName(st, this.pk), secret: r.agentSecret, relays: r.relays, name: st.name }
  }

  revokeAgentLink(roomId: string) {
    const r = this.rooms.get(roomId)
    if (!r) return
    r.agentSecret = newKey()
    this.saveRooms()
    this.bump(roomId)
  }

  async knock(inv: HumanInvite, myName: string) {
    const p: PendingJoin = {
      roomId: inv.roomId,
      lobbyKey: inv.lobbyKey,
      relays: inv.relays?.length ? inv.relays : this.relays,
      name: inv.name,
      host: inv.host,
      myName,
      at: nowSec(),
    }
    this.pending.set(inv.roomId, p)
    this.savePending()
    this.resubscribePending(p)
    const inner = signInner(this.sk, inv.roomId, { t: 'knock', name: myName })
    await this.publish(p.relays, wrapRoomEvent(this.sk, inner, inv.lobbyKey))
    this.bump(inv.roomId)
  }

  cancelKnock(roomId: string) {
    this.pending.delete(roomId)
    this.subs.get('pending:' + roomId)?.close()
    this.subs.delete('pending:' + roomId)
    this.savePending()
    this.bump(roomId)
  }

  async admit(roomId: string, pk: Hex, name: string) {
    const st = this.state(roomId)
    if (!st || !isAdmin(st, this.pk)) throw new Error('Only admins can admit')
    await this.stateOp(roomId, { op: 'admit', pubkey: pk, name: uniqueName(st, name || 'Guest') })
    await this.rotate(roomId)
  }

  async deny(roomId: string, pk: Hex) {
    const st = this.state(roomId)
    if (!st) return
    const inner = signInner(this.sk, roomId, { t: 'deny', pubkey: pk })
    const outer = wrapRoomEvent(this.sk, inner, st.lobbyKey)
    this.onRoomOuter(outer)
    await this.publish(this.rooms.get(roomId)!.relays, outer)
  }

  async removeMember(roomId: string, pk: Hex) {
    await this.stateOp(roomId, { op: 'remove', pubkey: pk })
    await this.rotate(roomId)
  }

  async removeAgent(roomId: string, agentPk: Hex) {
    const st = this.state(roomId)
    await this.stateOp(roomId, { op: 'agent-remove', pubkey: agentPk })
    if (st && isAdmin(st, this.pk)) await this.rotate(roomId)
  }

  /** Leave a room. Admins may hand over (`newAdmin`) or close it for everyone (`closeRoom`). */
  async leave(roomId: string, o: { newAdmin?: Hex; closeRoom?: boolean; wipe?: boolean } = {}) {
    const st = this.state(roomId)
    const r = this.rooms.get(roomId)
    if (!r) return
    try {
      if (st && !st.closed) {
        if (o.closeRoom && isAdmin(st, this.pk)) await this.stateOp(roomId, { op: 'close' })
        else {
          if (o.newAdmin && isAdmin(st, this.pk) && !isAdmin(st, o.newAdmin)) await this.stateOp(roomId, { op: 'promote', pubkey: o.newAdmin })
          if (this.agentMode) await this.stateOp(roomId, { op: 'agent-remove', pubkey: this.pk })
          else await this.stateOp(roomId, { op: 'remove', pubkey: this.pk })
        }
      }
      if (o.wipe !== false) await this.requestDeletion(roomId).catch(() => {})
    } finally {
      r.left = true
      this.subs.get(roomId)?.close()
      this.subs.delete(roomId)
      this.events.delete(roomId)
      await this.kv.del('events:' + roomId)
      this.rooms.delete(roomId)
      this.saveRooms()
      this.bump(roomId)
    }
  }

  /** NIP-09 deletion requests for events this user (or their local agents) authored in a room. */
  async requestDeletion(roomId: string, ids?: string[]) {
    const r = this.rooms.get(roomId)
    if (!r) return
    const evs = [...(this.events.get(roomId)?.values() ?? [])].filter(
      (e) => this.identities.has(e.pubkey) && e.outerId && (!ids || ids.includes(e.id)),
    )
    const dels = evs.slice(-200).map((e) =>
      finalizeEvent(
        { kind: KIND.DELETE, created_at: nowSec(), tags: [['e', e.outerId!], ['k', String(KIND.ROOM)]], content: '' },
        outerKeyFor(this.identities.get(e.pubkey)!, e.id),
      ),
    )
    await Promise.allSettled(dels.map((d) => this.publish(r.relays, d)))
  }

  markRead(roomId: string) {
    const r = this.rooms.get(roomId)
    if (!r) return
    r.lastRead = Date.now()
    this.saveRooms()
  }

  unreadCount(roomId: string) {
    const r = this.rooms.get(roomId)
    if (!r) return 0
    const since = r.lastRead ?? 0
    let n = 0
    for (const e of this.events.get(roomId)?.values() ?? []) if (e.payload.t === 'msg' && e.ms > since && !this.identities.has(e.pubkey)) n++
    return n
  }

  // ---------------------------------------------------------------- agents (bridge side)
  /** As an agent identity: ask the owner to add this agent to their room. */
  async requestAgentJoin(inv: AgentInvite, name: string, agentKind: 'bridge' | 'browser', model?: string) {
    const c: Control = { t: 'agent-join', roomId: inv.roomId, secret: inv.secret, name, agentPubkey: this.pk, agentKind, model }
    const rumor = makeRumor(this.sk, KIND.CONTROL, JSON.stringify(c))
    for (const r of inv.relays) if (!this.relays.includes(r)) this.relays.push(r)
    this.resubscribeInbox()
    await this.publish(inv.relays, giftWrap(rumor, this.sk, inv.owner))
  }

  // ---------------------------------------------------------------- DMs (NIP-17)
  async sendDM(from: Hex, to: Hex, text: string) {
    const sk = this.signerFor(from)
    const rumor = makeRumor(sk, KIND.DM, text, [['p', to], ['ms', String(Date.now())]])
    this.onDM(from, rumor)
    const relays = this.allRelays()
    await Promise.all([this.publish(relays, giftWrap(rumor, sk, to)), this.publish(relays, giftWrap(rumor, sk, from))])
  }

  dmThreads(identity?: Hex) {
    const out: { identity: Hex; peer: Hex; last: DMItem }[] = []
    for (const [k, v] of this.dms) {
      const [id, peer] = k.split(':')
      if (identity && id !== identity) continue
      if (v.length) out.push({ identity: id, peer, last: v[v.length - 1] })
    }
    return out.sort((a, b) => b.last.ms - a.last.ms)
  }

  dmMessages(identity: Hex, peer: Hex) {
    return this.dms.get(`${identity}:${peer}`) ?? []
  }

  // ---------------------------------------------------------------- self data (NIP-78)
  async saveAppData(name: string, data: unknown) {
    const ev = finalizeEvent(
      { kind: KIND.APP_DATA, created_at: nowSec(), tags: [['d', 'beamhop:' + name]], content: encryptToSelf(this.sk, JSON.stringify(data)) },
      this.sk,
    )
    await this.publish(this.relays, ev)
  }

  async loadAppData<T = any>(name: string): Promise<T | undefined> {
    const evs = await this.pool.querySync(this.relays, { kinds: [KIND.APP_DATA], authors: [this.pk], '#d': ['beamhop:' + name] }, { maxWait: 4000 })
    const latest = evs.sort((a, b) => b.created_at - a.created_at)[0]
    if (!latest) return undefined
    try {
      return JSON.parse(decryptFromSelf(this.sk, latest.content))
    } catch {
      return undefined
    }
  }

  async deleteAppData(names: string[]) {
    const ev = finalizeEvent(
      { kind: KIND.DELETE, created_at: nowSec(), tags: names.map((n) => ['a', `${KIND.APP_DATA}:${this.pk}:beamhop:${n}`]), content: '' },
      this.sk,
    )
    await this.publish(this.relays, ev).catch(() => {})
  }

  /** Publish a one-off encrypted transfer for device pairing: payload encrypted to a one-time key. */
  async publishRaw(relays: string[], ev: Event) {
    return this.publish(relays, ev)
  }

  async waitFor(pred: () => boolean, ms = 15000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (pred()) return true
      await sleep(100)
    }
    return pred()
  }
}

export function uniqueName(st: RoomState, name: string) {
  const taken = new Set([...Object.values(st.members).map((m) => m.name.toLowerCase()), ...Object.values(st.agents).map((a) => a.name.toLowerCase())])
  if (!taken.has(name.toLowerCase())) return name
  for (let i = 2; i < 100; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`
  return name + ' ' + randomHex(2)
}

export { hexToBytes, bytesToHex }
