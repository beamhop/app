import type { AgentInvite, HumanInvite } from './types.js'
import { b64urlToJson, jsonToB64url } from './util.js'

export const DEFAULT_APP_URL = 'https://beamhop.github.io/app/'

export const DEFAULT_RELAYS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://offchain.pub',
  'wss://nostr.mom',
]

export const DEFAULT_BLOSSOM = ['https://nostr.download', 'https://blossom.primal.net', 'https://blossom.band']

export function humanInviteUrl(base: string, inv: HumanInvite) {
  return `${base.replace(/#.*$/, '')}#/join/${jsonToB64url(inv)}`
}
export function agentInviteUrl(base: string, inv: AgentInvite) {
  return `${base.replace(/#.*$/, '')}#/agent/${jsonToB64url(inv)}`
}

/** Parse either a full link or the bare payload. */
export function parseInvite(input: string): HumanInvite | AgentInvite | null {
  try {
    const m = input.trim().match(/#\/(join|agent)\/([A-Za-z0-9_-]+)/)
    const payload = m ? m[2] : input.trim()
    const v = b64urlToJson(payload)
    if (v?.v !== 1 || !v.roomId) return null
    if (v.type === 'human' && /^[0-9a-f]{64}$/.test(v.lobbyKey)) return v as HumanInvite
    if (v.type === 'agent' && /^[0-9a-f]{64}$/.test(v.secret) && /^[0-9a-f]{64}$/.test(v.owner)) return v as AgentInvite
    return null
  } catch {
    return null
  }
}
