import type { AgentInfo, Decoded, Hex, RoomState, StateOp } from './types.js'

export const ROOM_COLORS = ['#5b6cff', '#ff6b5b', '#16a37f', '#e0a100', '#b05bff', '#0ea5e9', '#ef4489', '#64748b']
export const ROOM_EMOJIS = ['🛸', '🌿', '🔥', '🎈', '🧪', '🪐', '🍋', '🦊', '🎧', '🧭', '🌊', '⚡️']

export function initialState(roomId: string, creator: Hex, creatorName: string, lobbyKey: Hex, now: number): RoomState {
  const pick = <T,>(arr: T[]) => arr[parseInt(roomId.slice(0, 4), 16) % arr.length]
  return {
    roomId,
    name: 'Untitled room',
    emoji: pick(ROOM_EMOJIS),
    color: pick(ROOM_COLORS),
    createdBy: creator,
    createdAt: now,
    admins: [creator],
    members: { [creator]: { name: creatorName, joinedAt: now } },
    agents: {},
    lobbyKey,
    epoch: 0,
    ts: now,
    opIds: [],
  }
}

export const isMember = (s: RoomState, pk: Hex) => !!s.members[pk]
export const isAgent = (s: RoomState, pk: Hex) => !!s.agents[pk]
export const isAdmin = (s: RoomState, pk: Hex) => s.admins.includes(pk)
export const isParticipant = (s: RoomState, pk: Hex) => isMember(s, pk) || isAgent(s, pk)

export function displayName(s: RoomState | undefined, pk: Hex) {
  if (!s) return pk.slice(0, 8)
  return s.members[pk]?.name ?? s.agents[pk]?.name ?? pk.slice(0, 8)
}

/** Apply one op authored by `author`. Returns a new state or null if the op is invalid. */
export function applyOp(s: RoomState, author: Hex, op: StateOp, opId: string, at: number): RoomState | null {
  if (s.closed) return null
  const admin = isAdmin(s, author)
  const n: RoomState = {
    ...s,
    admins: [...s.admins],
    members: { ...s.members },
    agents: { ...s.agents },
    opIds: [...s.opIds, opId].slice(-1000),
    departed: { ...(s.departed ?? {}) },
    ts: Math.max(s.ts, at),
  }
  switch (op.op) {
    case 'rename':
      if (!admin) return null
      n.name = String(op.name || '').slice(0, 80) || n.name
      if (op.emoji) n.emoji = String(op.emoji).slice(0, 8)
      if (op.color) n.color = String(op.color).slice(0, 16)
      return n
    case 'admit':
      if (!admin || isMember(s, op.pubkey)) return null
      n.members[op.pubkey] = { name: String(op.name || 'Guest').slice(0, 60), joinedAt: at }
      delete n.departed![op.pubkey]
      return n
    case 'remove': {
      if (!(admin || author === op.pubkey)) return null
      if (!isMember(s, op.pubkey)) return null
      delete n.members[op.pubkey]
      n.departed![op.pubkey] = at
      n.admins = n.admins.filter((a) => a !== op.pubkey)
      for (const [apk, a] of Object.entries(n.agents))
        if (a.owner === op.pubkey) {
          delete n.agents[apk]
          n.departed![apk] = at
        }
      return n
    }
    case 'promote':
      if (!admin || !isMember(s, op.pubkey) || isAdmin(s, op.pubkey)) return null
      n.admins.push(op.pubkey)
      return n
    case 'demote':
      if (!admin || !isAdmin(s, op.pubkey) || s.admins.length < 2) return null
      n.admins = n.admins.filter((a) => a !== op.pubkey)
      return n
    case 'agent-add': {
      if (!isMember(s, author) || isParticipant(s, op.pubkey)) return null
      const a: AgentInfo = {
        name: String(op.name || 'Agent').slice(0, 60),
        owner: author,
        kind: op.kind === 'bridge' ? 'bridge' : 'browser',
        mode: op.mode === 'owner' ? 'owner' : 'mention',
        instructors: op.instructors ?? 'everyone',
        selected: op.selected,
        emoji: op.emoji,
        model: op.model,
        addedAt: at,
      }
      n.agents[op.pubkey] = a
      delete n.departed![op.pubkey]
      return n
    }
    case 'agent-update': {
      const a = s.agents[op.pubkey]
      if (!a || a.owner !== author) return null
      n.agents[op.pubkey] = {
        ...a,
        ...(op.name ? { name: String(op.name).slice(0, 60) } : {}),
        ...(op.mode ? { mode: op.mode } : {}),
        ...(op.instructors ? { instructors: op.instructors } : {}),
        ...(op.selected ? { selected: op.selected } : {}),
        ...(op.emoji ? { emoji: op.emoji } : {}),
        ...(op.model ? { model: op.model } : {}),
      }
      return n
    }
    case 'agent-remove': {
      const a = s.agents[op.pubkey]
      if (!a || !(a.owner === author || admin)) return null
      delete n.agents[op.pubkey]
      n.departed![op.pubkey] = at
      return n
    }
    case 'profile':
      if (!isMember(s, author)) return null
      n.members[author] = { ...n.members[author], name: String(op.name || '').slice(0, 60) || n.members[author].name }
      return n
    case 'lobby':
      if (!admin || !/^[0-9a-f]{64}$/.test(op.key)) return null
      n.lobbyKey = op.key
      return n
    case 'close':
      if (!admin) return null
      n.closed = true
      return n
  }
  return null
}

/** Ops this much older than a snapshot may still be missing from it (another admin acted concurrently). */
export const SNAPSHOT_GRACE_SEC = 600

/** Reduce a base snapshot plus decoded state events into the current state. */
export function reduceState(base: RoomState, events: Decoded[]): RoomState {
  const seen = new Set(base.opIds)
  const ops = events
    .filter((e) => e.payload.t === 'state' && !seen.has(e.id) && e.created_at >= base.ts - SNAPSHOT_GRACE_SEC)
    .sort((a, b) => a.ms - b.ms || a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
  let s = base
  for (const e of ops) {
    const { t, ...op } = e.payload as any
    const next = applyOp(s, e.pubkey, op as StateOp, e.id, e.created_at)
    if (next) s = next
  }
  return s
}

/** May `pk` have authored a (non-state) event at `createdAt`? Participants, or people before they left. */
export function mayHaveAuthored(s: RoomState, pk: Hex, createdAt: number) {
  if (isParticipant(s, pk)) return true
  const left = s.departed?.[pk]
  return left !== undefined && createdAt <= left
}

/** People who should receive a key rotation. */
export function keyRecipients(s: RoomState): Hex[] {
  return [...Object.keys(s.members), ...Object.keys(s.agents)]
}
