import type { AgentCaps, AgentMode, HarnessId, Instructors } from '@beamhop/shared'
import type { ProviderId } from '../agents/providers'

export interface AgentDef {
  id: string
  sk: string // hex; the agent's own Nostr key
  pk: string
  name: string
  emoji: string
  /**
   * Where the agent runs. 'tab' (the default): fx compiled to WebAssembly, calling `provider`
   * directly. 'machine': a coding-agent harness in the Linux machine in the tab (unkernel).
   */
  runtime?: 'tab' | 'machine'
  /** The harness, for runtime 'machine'. */
  harness?: HarnessId
  /** For harness 'custom': the shell command that starts an ACP agent. */
  customCommand?: string
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
