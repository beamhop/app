import type { AgentCaps, AgentMode, Instructors } from '@beamhop/shared'
import type { ProviderId } from '../agents/providers'

export interface AgentDef {
  id: string
  sk: string // hex; the agent's own Nostr key
  pk: string
  name: string
  emoji: string
  provider: ProviderId
  model: string
  instructions: string
  tools: { web: boolean; sandbox: boolean }
  mode: AgentMode
  instructors: Instructors
  caps: AgentCaps
  createdAt: number
  updatedAt: number
  deleted?: boolean
}

export interface Profile {
  name: string
  updatedAt: number
}

export interface Settings {
  relays: string[]
  blossom: string[]
  updatedAt: number
}

export interface Usage {
  turns: number
  input: number
  output: number
  lastAt?: number
}
