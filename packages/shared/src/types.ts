// Beamhop wire protocol types.

export const KIND = {
  ROOM: 4410, // outer, stored; content = nip44(roomKey, signed inner)
  ROOM_EPHEMERAL: 24410, // outer, not stored (typing, presence, streaming)
  INNER: 4411, // inner signed event inside ROOM outer
  CONTROL: 4412, // rumor kind inside gift wraps (keys, agent joins)
  DM: 14, // NIP-17 rumor
  SEAL: 13,
  GIFT_WRAP: 1059,
  APP_DATA: 30078, // NIP-78 encrypted self data
  DELETE: 5,
  BLOSSOM_AUTH: 24242,
} as const

export type Hex = string

export interface FileRef {
  url: string
  sha256: string // of ciphertext
  key: string // hex AES-GCM key
  iv: string // hex
  mime: string
  name: string
  size: number
}

export type AgentMode = 'mention' | 'owner'
export type Instructors = 'everyone' | 'owner' | 'selected'

export interface AgentInfo {
  name: string
  owner: Hex
  kind: 'browser' | 'bridge'
  mode: AgentMode
  instructors: Instructors
  selected?: Hex[]
  emoji?: string
  model?: string
  addedAt: number
}

export interface MemberInfo {
  name: string
  joinedAt: number
}

export interface RoomState {
  roomId: string
  name: string
  emoji: string
  color: string
  createdBy: Hex
  createdAt: number
  admins: Hex[]
  members: Record<Hex, MemberInfo>
  agents: Record<Hex, AgentInfo>
  lobbyKey: Hex
  closed?: boolean
  epoch: number
  ts: number // seconds; ops strictly after this (or same second and not in opIds) apply on top
  opIds: string[]
}

export type StateOp =
  | { op: 'rename'; name: string; emoji?: string; color?: string }
  | { op: 'admit'; pubkey: Hex; name: string }
  | { op: 'remove'; pubkey: Hex }
  | { op: 'promote'; pubkey: Hex }
  | { op: 'demote'; pubkey: Hex }
  | { op: 'agent-add'; pubkey: Hex; name: string; kind: 'browser' | 'bridge'; mode?: AgentMode; instructors?: Instructors; selected?: Hex[]; emoji?: string; model?: string }
  | { op: 'agent-update'; pubkey: Hex; name?: string; mode?: AgentMode; instructors?: Instructors; selected?: Hex[]; emoji?: string; model?: string }
  | { op: 'agent-remove'; pubkey: Hex }
  | { op: 'profile'; name: string }
  | { op: 'lobby'; key: Hex }
  | { op: 'close' }

export type Payload =
  | { t: 'msg'; text: string; reply?: string; mentions?: Hex[]; files?: FileRef[]; trigger?: string; hop?: number; ms?: number }
  | { t: 'react'; target: string; emoji: string; remove?: boolean }
  | { t: 'edit'; target: string; text: string }
  | { t: 'del'; target: string }
  | ({ t: 'state' } & StateOp)
  | { t: 'knock'; name: string }
  | { t: 'deny'; pubkey: Hex }
  // ephemeral
  | { t: 'typing' }
  | { t: 'presence'; device?: string; agents?: Hex[]; caps?: Record<Hex, boolean> }
  | { t: 'stream'; sid: string; text: string; trigger?: string; done?: boolean; status?: string }

export interface InnerEvent {
  id: string
  pubkey: Hex
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface Decoded {
  id: string
  pubkey: Hex
  created_at: number
  ms: number
  payload: Payload
  outerId?: string
  epoch?: number
}

export type Control =
  | { t: 'key'; roomId: string; epoch: number; key: Hex; snapshot: RoomState; relays: string[] }
  | { t: 'agent-join'; roomId: string; secret: Hex; name: string; agentPubkey: Hex; agentKind: 'bridge' | 'browser'; model?: string }
  | { t: 'agent-revoked'; roomId: string }

export interface HumanInvite {
  v: 1
  type: 'human'
  roomId: string
  lobbyKey: Hex
  relays: string[]
  name: string
  host: string
}

export interface AgentInvite {
  v: 1
  type: 'agent'
  roomId: string
  owner: Hex
  ownerName: string
  secret: Hex
  relays: string[]
  name: string
}
