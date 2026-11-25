import { extFetch, extensionVersion } from '../core/extension'
import { kv } from '../core/kv'
import { localServerFetch, testLocalServer } from './localServer'
import { makeCopilotFetch, refreshCopilot, listCopilotModels, type CopilotCreds } from './copilot'
import { makeGeminiFetch, refreshGemini, GEMINI_MODELS, type GeminiCreds } from './gemini'

export type ProviderId =
  | 'openrouter'
  | 'chatgpt'
  | 'copilot'
  | 'gemini'
  | 'anthropic'
  | 'openai'
  | 'gemini-key'
  | 'gateway'
  | 'ollama'
  | 'custom'

export interface ProviderInfo {
  id: ProviderId
  label: string
  group: 'subscription' | 'key' | 'local'
  blurb: string
  needsExtension?: boolean
  signIn?: 'openrouter' | 'chatgpt' | 'copilot' | 'gemini'
  keyUrl?: string
  models: string[]
  defaultModel: string
  risk?: string
}

const RISK = 'Uses the official app’s sign-in. Your plan’s terms apply. Use at your own risk.'

export const PROVIDERS: ProviderInfo[] = [
  { id: 'openrouter', label: 'OpenRouter', group: 'key', blurb: 'One sign-in, hundreds of models. Works on any device.', signIn: 'openrouter', keyUrl: 'https://openrouter.ai/keys', models: ['openrouter/auto', 'anthropic/claude-sonnet-4.5', 'openai/gpt-5', 'google/gemini-2.5-pro', 'qwen/qwen3-coder', 'deepseek/deepseek-chat'], defaultModel: 'openrouter/auto' },
  { id: 'chatgpt', label: 'ChatGPT plan', group: 'subscription', blurb: 'Your ChatGPT Plus/Pro plan through Codex.', needsExtension: true, signIn: 'chatgpt', models: ['gpt-5-codex', 'gpt-5', 'gpt-5-mini'], defaultModel: 'gpt-5-codex', risk: RISK },
  { id: 'copilot', label: 'GitHub Copilot', group: 'subscription', blurb: 'Your Copilot plan: GPT, Claude and Gemini models.', needsExtension: true, signIn: 'copilot', models: ['gpt-4.1', 'gpt-5-mini', 'claude-sonnet-4.5', 'gemini-2.5-pro'], defaultModel: 'gpt-4.1', risk: RISK },
  { id: 'gemini', label: 'Google Gemini', group: 'subscription', blurb: 'Your Google account: free tier or Google AI Pro/Ultra. No extension needed.', signIn: 'gemini', models: GEMINI_MODELS, defaultModel: 'gemini-2.5-flash', risk: RISK },
  { id: 'anthropic', label: 'Anthropic API', group: 'key', blurb: 'Claude with your Anthropic API key.', keyUrl: 'https://console.anthropic.com/settings/keys', models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'], defaultModel: 'claude-sonnet-4-5' },
  { id: 'openai', label: 'OpenAI API', group: 'key', blurb: 'GPT models with your OpenAI API key.', keyUrl: 'https://platform.openai.com/api-keys', models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'], defaultModel: 'gpt-5-mini' },
  { id: 'gemini-key', label: 'Gemini API', group: 'key', blurb: 'Gemini with a Google AI Studio key.', keyUrl: 'https://aistudio.google.com/apikey', models: GEMINI_MODELS, defaultModel: 'gemini-2.5-flash' },
  { id: 'gateway', label: 'Vercel AI Gateway', group: 'key', blurb: 'Any AI Gateway model, with web search.', keyUrl: 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%2Fapi-keys', models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5', 'google/gemini-2.5-pro'], defaultModel: 'anthropic/claude-sonnet-4.5' },
  { id: 'ollama', label: 'Ollama (local)', group: 'local', blurb: 'Models on this computer or your network. Ollama must allow this site: start it with OLLAMA_ORIGINS=https://beamhop.github.io (or *).', models: ['llama3.2', 'qwen2.5-coder', 'gpt-oss:20b'], defaultModel: 'llama3.2' },
  { id: 'custom', label: 'Other (OpenAI-compatible)', group: 'local', blurb: 'Any server that speaks the OpenAI Chat Completions API and allows browser requests.', models: [], defaultModel: '' },
]

export const providerInfo = (id: ProviderId) => PROVIDERS.find((p) => p.id === id)!

export interface KeyCreds {
  apiKey?: string
  baseUrl?: string
}
export type Creds = KeyCreds | CopilotCreds | GeminiCreds | Record<string, any>

// ---------------------------------------------------------------- credentials (this device only)
const credCache = new Map<ProviderId, any>()
export async function getCreds<T = any>(id: ProviderId): Promise<T | undefined> {
  if (credCache.has(id)) return credCache.get(id)
  const v = await kv.get<T>('creds:' + id)
  if (v) credCache.set(id, v)
  return v
}
/**
 * Save credentials. `refresh` marks a routine token refresh by the provider: the same account,
 * so nothing that uses it needs rebuilding.
 */
export async function setCreds(id: ProviderId, v: any, o: { refresh?: boolean } = {}) {
  credCache.set(id, v)
  await kv.set('creds:' + id, v)
  if (!o.refresh) credListeners.forEach((f) => f(id))
}
export async function clearCreds(id: ProviderId) {
  credCache.delete(id)
  await kv.del('creds:' + id)
  credListeners.forEach((f) => f(id))
}
const credListeners = new Set<(id: ProviderId) => void>()
export const onCredsChange = (f: (id: ProviderId) => void) => {
  credListeners.add(f)
  return () => {
    credListeners.delete(f)
  }
}

export async function hasCreds(id: ProviderId) {
  const c: any = await getCreds(id)
  // Ollama needs no key: it runs with the default address or the one saved for it.
  if (id === 'ollama') return true
  if (!c) return false
  if (id === 'custom') return !!c.baseUrl
  if (id === 'chatgpt') return !!c.accessToken
  if (id === 'copilot') return !!c.githubToken
  if (id === 'gemini') return !!c.refreshToken
  return !!c.apiKey
}

/** Can this device run an agent on this provider right now? */
export async function canRun(id: ProviderId) {
  if (!(await hasCreds(id))) return false
  if (providerInfo(id).needsExtension && !extensionVersion()) return false
  return true
}

const DEFAULTS = { contextWindow: 128000, maxOutputTokens: 8192, supportsToolUse: true }

// ---------------------------------------------------------------- libfx options
export async function fxProviderOptions(id: ProviderId, model: string): Promise<Record<string, any>> {
  const c: any = (await getCreds(id)) ?? {}
  const key = () => ({ apiKey: c.apiKey })
  switch (id) {
    case 'openrouter':
      return {
        provider: { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', modelDefaults: DEFAULTS },
        model,
        credentials: key,
        fetch: (u: string, i: RequestInit) => {
          const h = new Headers(i.headers)
          h.set('HTTP-Referer', 'https://beamhop.github.io/app/')
          h.set('X-Title', 'Beamhop')
          return fetch(u, { ...i, headers: h })
        },
      }
    case 'openai':
      return { provider: { name: 'openai', baseUrl: 'https://api.openai.com/v1', modelDefaults: { ...DEFAULTS, outputLimitField: 'max_completion_tokens' } }, model, credentials: key }
    case 'anthropic':
      return {
        provider: { name: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', modelDefaults: DEFAULTS },
        model,
        credentials: key,
        fetch: (u: string, i: RequestInit) => {
          const h = new Headers(i.headers)
          h.set('anthropic-dangerous-direct-browser-access', 'true')
          h.set('x-api-key', c.apiKey)
          return fetch(u, { ...i, headers: h })
        },
      }
    case 'gemini-key':
      return { provider: { name: 'geminikey', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', modelDefaults: DEFAULTS }, model, credentials: key }
    case 'gateway':
      return { apiKey: c.apiKey, ...(model ? { model } : {}) }
    case 'ollama': {
      const base = (c.baseUrl || 'http://localhost:11434').replace(/\/$/, '')
      return { provider: { name: 'ollama', baseUrl: base + '/v1', modelDefaults: DEFAULTS }, model, fetch: localServerFetch('ollama', base) }
    }
    case 'custom': {
      const base = String(c.baseUrl).replace(/\/$/, '')
      return { provider: { name: 'custom', baseUrl: base, modelDefaults: DEFAULTS }, model, fetch: localServerFetch('custom', base), ...(c.apiKey ? { credentials: key } : {}) }
    }
    case 'chatgpt':
      return {
        provider: 'codex',
        model,
        credentials: async () => (await getCreds('chatgpt')) as any,
        onCredentials: (n: any) => setCreds('chatgpt', n, { refresh: true }),
        fetch: extFetch,
      }
    case 'copilot': {
      const getC = async () => {
        const cur = (await getCreds<CopilotCreds>('copilot'))!
        const next = await refreshCopilot(cur)
        if (next !== cur) await setCreds('copilot', next, { refresh: true })
        return next
      }
      return {
        provider: { name: 'copilot', baseUrl: 'https://api.githubcopilot.com', modelDefaults: DEFAULTS },
        model,
        credentials: async () => ({ apiKey: (await getC()).token! }),
        fetch: makeCopilotFetch(getC),
      }
    }
    case 'gemini': {
      const getC = async () => {
        const cur = (await getCreds<GeminiCreds>('gemini'))!
        const next = await refreshGemini(cur)
        if (next !== cur) await setCreds('gemini', next, { refresh: true })
        return next
      }
      return {
        provider: { name: 'gemini', baseUrl: 'https://cloudcode-pa.googleapis.com/v1internal', modelDefaults: { ...DEFAULTS, contextWindow: 1000000, supportsVision: true } },
        model,
        fetch: makeGeminiFetch(getC),
      }
    }
  }
}

/** Live model list where the provider offers one; falls back to suggestions. */
export async function listModels(id: ProviderId): Promise<string[]> {
  const info = providerInfo(id)
  const c: any = (await getCreds(id)) ?? {}
  try {
    const get = async (url: string, headers: Record<string, string> = {}) => {
      const r = await fetch(url, { headers })
      if (!r.ok) throw new Error(String(r.status))
      return r.json()
    }
    switch (id) {
      case 'openrouter': {
        const j = await get('https://openrouter.ai/api/v1/models')
        const ids = (j.data ?? []).filter((m: any) => m.supported_parameters?.includes?.('tools')).map((m: any) => m.id)
        return ['openrouter/auto', ...ids]
      }
      case 'openai': {
        const j = await get('https://api.openai.com/v1/models', { authorization: `Bearer ${c.apiKey}` })
        return (j.data ?? []).map((m: any) => m.id).filter((x: string) => /^(gpt|o\d|chatgpt)/.test(x)).sort().reverse()
      }
      case 'anthropic': {
        const j = await get('https://api.anthropic.com/v1/models', { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' })
        return (j.data ?? []).map((m: any) => m.id)
      }
      case 'gemini-key': {
        const j = await get('https://generativelanguage.googleapis.com/v1beta/openai/models', { authorization: `Bearer ${c.apiKey}` })
        return (j.data ?? []).map((m: any) => String(m.id).replace(/^models\//, '')).filter((x: string) => x.startsWith('gemini'))
      }
      case 'ollama':
      case 'custom': {
        const l = await testLocalServer(id, id === 'ollama' ? c.baseUrl || 'http://localhost:11434' : String(c.baseUrl), c.apiKey)
        return l.length ? l : info.models
      }
      case 'copilot': {
        const cc = await refreshCopilot(c)
        const l = await listCopilotModels(cc)
        return l.length ? l : info.models
      }
      case 'gateway': {
        const j = await get('https://ai-gateway.vercel.sh/v1/models')
        return (j.data ?? []).filter((m: any) => !m.type || m.type === 'language').map((m: any) => m.id)
      }
      case 'chatgpt': {
        if (!extensionVersion() || !c.accessToken) return info.models
        const r = await extFetch('https://chatgpt.com/backend-api/codex/models?client_version=0.50.0', {
          headers: { authorization: `Bearer ${c.accessToken}`, ...(c.accountId ? { 'chatgpt-account-id': c.accountId } : {}) },
        })
        if (!r.ok) return info.models
        const j = await r.json()
        const l = (j.models ?? []).map((m: any) => m.slug ?? m.id).filter(Boolean)
        return l.length ? l : info.models
      }
    }
  } catch {}
  return info.models
}
