// GitHub Copilot on a user's own Copilot plan. GitHub's sign-in endpoints don't allow
// cross-origin requests, so sign-in goes through the Companion extension.
import { extFetch, extensionVersion } from '../core/extension'

const CLIENT_ID = 'Iv1.b507a08c87ecfe98'
export const COPILOT_HEADERS = {
  'Editor-Version': 'vscode/1.99.3',
  'Editor-Plugin-Version': 'copilot-chat/0.26.7',
  'Copilot-Integration-Id': 'vscode-chat',
  'Openai-Intent': 'conversation-panel',
  'X-Github-Api-Version': '2025-04-01',
}

export interface CopilotCreds {
  githubToken: string
  token?: string
  expiresAt?: number
  api?: string
  login?: string
}

export interface CopilotDevice {
  device_code: string
  user_code: string
  verification_uri: string
  interval: number
  expires_in: number
}

const need = () => {
  if (!extensionVersion()) throw new Error('GitHub Copilot sign-in needs the Beamhop Companion extension')
}

export async function startCopilotSignIn(): Promise<CopilotDevice> {
  need()
  const res = await extFetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: 'read:user' }),
  })
  if (!res.ok) throw new Error(`GitHub device code failed (${res.status})`)
  return res.json()
}

export async function pollCopilotSignIn(d: CopilotDevice, signal?: AbortSignal): Promise<CopilotCreds> {
  need()
  let interval = (d.interval || 5) * 1000
  const end = Date.now() + d.expires_in * 1000
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, interval))
    if (signal?.aborted) throw new Error('Cancelled')
    const res = await extFetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    })
    const j = await res.json()
    if (j.access_token) {
      const c: CopilotCreds = { githubToken: j.access_token }
      try {
        const u = await extFetch('https://api.github.com/user', { headers: { authorization: `token ${c.githubToken}`, accept: 'application/json' } })
        if (u.ok) c.login = (await u.json()).login
      } catch {}
      return refreshCopilot(c)
    }
    if (j.error === 'slow_down') interval += 5000
    else if (j.error && j.error !== 'authorization_pending') throw new Error(j.error_description || j.error)
  }
  throw new Error('The code expired. Start again.')
}

export async function refreshCopilot(c: CopilotCreds): Promise<CopilotCreds> {
  if (c.token && c.expiresAt && c.expiresAt - Date.now() > 120_000) return c
  need()
  const res = await extFetch('https://api.github.com/copilot_internal/v2/token', {
    headers: { authorization: `token ${c.githubToken}`, accept: 'application/json', ...COPILOT_HEADERS },
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || !j.token) throw new Error(j.message || `No Copilot access on this GitHub account (${res.status})`)
  return { ...c, token: j.token, expiresAt: (j.expires_at ?? 0) * 1000, api: j.endpoints?.api ?? 'https://api.githubcopilot.com' }
}

/** fetch for libfx's custom provider "copilot": routes to the account's Copilot API with its headers. */
export function makeCopilotFetch(getCreds: () => Promise<CopilotCreds>) {
  return async (input: string, init: RequestInit): Promise<Response> => {
    const c = await getCreds()
    const u = new URL(String(input))
    const target = (c.api ?? 'https://api.githubcopilot.com').replace(/\/$/, '') + u.pathname.replace(/^\/v1/, '') + u.search
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${c.token}`)
    for (const [k, v] of Object.entries(COPILOT_HEADERS)) headers.set(k, v)
    return extFetch(target, { ...init, headers })
  }
}

export async function listCopilotModels(c: CopilotCreds): Promise<string[]> {
  const res = await makeCopilotFetch(async () => c)('https://api.githubcopilot.com/models', { method: 'GET' })
  if (!res.ok) return []
  const j = await res.json()
  return (j.data ?? []).filter((m: any) => m.capabilities?.type !== 'embeddings' && m.model_picker_enabled !== false).map((m: any) => m.id)
}
