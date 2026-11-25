// Google Gemini on a user's Google account (Gemini Code Assist: free tier, Google AI Pro/Ultra),
// using the same public OAuth client as Gemini CLI. Requests go straight from the browser:
// Google's token endpoint and the Code Assist API both allow cross-origin requests.
// libfx speaks OpenAI Chat Completions, so `geminiFetch` translates to/from Code Assist.

import { extCaptureRedirect, extensionVersion } from '../core/extension'

const CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com'
// Gemini CLI's "installed app" client secret is public (it ships in Gemini CLI's source), but this
// repo keeps no copy of it: it's read from Gemini CLI's published source when someone signs in.
const SECRET_SOURCES = [
  'https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/code_assist/oauth2.ts',
  'https://cdn.jsdelivr.net/npm/@google/gemini-cli-core/dist/src/code_assist/oauth2.js',
]
let secretP: Promise<string> | null = null
function clientSecret(): Promise<string> {
  secretP ??= (async () => {
    const cached = localStorage.getItem('bh-gemini-client-secret')
    if (cached) return cached
    for (const u of SECRET_SOURCES) {
      try {
        const t = await (await fetch(u)).text()
        const m = t.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/)
        if (m) {
          localStorage.setItem('bh-gemini-client-secret', m[1])
          return m[1]
        }
      } catch {}
    }
    secretP = null
    throw new Error('Couldn’t load Gemini CLI’s sign-in settings. Check your connection and try again.')
  })()
  return secretP
}
const SCOPES = ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile']
const CODE_REDIRECT = 'https://codeassist.google.com/authcode'
const API = 'https://cloudcode-pa.googleapis.com/v1internal'

export interface GeminiCreds {
  accessToken: string
  refreshToken: string
  expiresAt: number
  projectId?: string
  email?: string
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)))
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  return { verifier, challenge }
}

export interface GeminiSignIn {
  url: string
  verifier: string
  state: string
}

export async function startGeminiSignIn(): Promise<GeminiSignIn> {
  const { verifier, challenge } = await pkce()
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)))
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  u.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: CODE_REDIRECT,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString()
  return { url: u.href, verifier, state }
}

/** With the extension: open Google's page and capture the code automatically. */
export async function captureGeminiCode(s: GeminiSignIn) {
  if (!extensionVersion()) throw new Error('Extension not available')
  const addr = await extCaptureRedirect(s.url, CODE_REDIRECT)
  const code = new URL(addr).searchParams.get('code')
  if (!code) throw new Error('No code in redirect')
  return code
}

export async function finishGeminiSignIn(s: GeminiSignIn, codeOrUrl: string): Promise<GeminiCreds> {
  let code = codeOrUrl.trim()
  if (code.startsWith('http')) code = new URL(code).searchParams.get('code') ?? ''
  if (!code) throw new Error('Paste the code Google showed you')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: await clientSecret(),
      redirect_uri: CODE_REDIRECT,
      grant_type: 'authorization_code',
      code_verifier: s.verifier,
    }),
  })
  const j = await res.json()
  if (!res.ok) throw new Error(j.error_description || j.error || `Google sign-in failed (${res.status})`)
  const creds: GeminiCreds = { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 }
  try {
    const u = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { authorization: `Bearer ${creds.accessToken}` } })
    if (u.ok) creds.email = (await u.json()).email
  } catch {}
  creds.projectId = await setupProject(creds)
  return creds
}

export async function refreshGemini(c: GeminiCreds): Promise<GeminiCreds> {
  if (c.expiresAt - Date.now() > 120_000) return c
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: await clientSecret(), refresh_token: c.refreshToken, grant_type: 'refresh_token' }),
  })
  const j = await res.json()
  if (!res.ok) throw new Error('Google token refresh failed: ' + (j.error_description || j.error || res.status))
  return { ...c, accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000, refreshToken: j.refresh_token ?? c.refreshToken }
}

async function caPost(c: GeminiCreds, method: string, body: unknown) {
  const res = await fetch(`${API}:${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${c.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j?.error?.message || `Code Assist ${method} failed (${res.status})`)
  return j
}

const METADATA = { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' }

async function setupProject(c: GeminiCreds): Promise<string | undefined> {
  const load = await caPost(c, 'loadCodeAssist', { metadata: METADATA })
  if (load.currentTier && load.cloudaicompanionProject) return load.cloudaicompanionProject
  const tier = (load.allowedTiers || []).find((t: any) => t.isDefault) ?? { id: 'free-tier' }
  let op = await caPost(c, 'onboardUser', { tierId: tier.id, metadata: METADATA })
  for (let i = 0; i < 12 && !op.done && op.name; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    const r = await fetch(`https://cloudcode-pa.googleapis.com/v1internal/${op.name}`, { headers: { authorization: `Bearer ${c.accessToken}` } })
    op = await r.json()
  }
  return op.response?.cloudaicompanionProject?.id ?? load.cloudaicompanionProject
}

// ---------------------------------------------------------------- translation
// thoughtSignature (needed by Gemini 3 when replaying function calls) rides inside the tool call id.
const SIG_SEP = '~sig~'

function toGemini(body: any) {
  const contents: any[] = []
  let system = ''
  const callNames = new Map<string, string>()
  for (const m of body.messages ?? []) {
    const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') : ''
    if (m.role === 'system' || m.role === 'developer') {
      system += (system ? '\n\n' : '') + text
    } else if (m.role === 'user') {
      const parts: any[] = []
      if (text) parts.push({ text })
      if (Array.isArray(m.content))
        for (const p of m.content)
          if (p.type === 'image_url') {
            const mm = String(p.image_url?.url ?? '').match(/^data:([^;]+);base64,(.*)$/)
            if (mm) parts.push({ inlineData: { mimeType: mm[1], data: mm[2] } })
          }
      contents.push({ role: 'user', parts: parts.length ? parts : [{ text: ' ' }] })
    } else if (m.role === 'assistant') {
      const parts: any[] = []
      if (text) parts.push({ text })
      for (const tc of m.tool_calls ?? []) {
        const [, sig] = String(tc.id).split(SIG_SEP)
        callNames.set(tc.id, tc.function.name)
        let args = {}
        try {
          args = JSON.parse(tc.function.arguments || '{}')
        } catch {}
        const part: any = { functionCall: { name: tc.function.name, args } }
        if (sig) part.thoughtSignature = sig
        parts.push(part)
      }
      if (parts.length) contents.push({ role: 'model', parts })
    } else if (m.role === 'tool') {
      const name = callNames.get(m.tool_call_id) ?? 'tool'
      const part = { functionResponse: { name, response: { result: text } } }
      const prev = contents[contents.length - 1]
      if (prev?.role === 'user' && prev.parts.every((p: any) => p.functionResponse)) prev.parts.push(part)
      else contents.push({ role: 'user', parts: [part] })
    }
  }
  const tools = body.tools?.length
    ? [{ functionDeclarations: body.tools.map((t: any) => ({ name: t.function.name, description: t.function.description, parametersJsonSchema: t.function.parameters })) }]
    : undefined
  const request: any = { contents, generationConfig: {} }
  if (system) request.systemInstruction = { role: 'user', parts: [{ text: system }] }
  if (tools) request.tools = tools
  if (body.max_tokens || body.max_completion_tokens) request.generationConfig.maxOutputTokens = body.max_tokens ?? body.max_completion_tokens
  if (body.temperature !== undefined) request.generationConfig.temperature = body.temperature
  return request
}

/** fetch for libfx's custom provider "gemini": Chat Completions in, Code Assist out, SSE back. */
export function makeGeminiFetch(getCreds: () => Promise<GeminiCreds>) {
  return async (input: string, init: RequestInit): Promise<Response> => {
    const url = String(input)
    if (!url.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } })
    }
    const body = JSON.parse(String(init.body))
    const creds = await getCreds()
    const req = { model: body.model, project: creds.projectId, user_prompt_id: crypto.randomUUID(), request: toGemini(body) }
    const res = await fetch(`${API}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { authorization: `Bearer ${creds.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal: init.signal,
    })
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '')
      let msg = t
      try {
        msg = JSON.parse(t).error?.message ?? t
      } catch {}
      return new Response(JSON.stringify({ error: { message: msg || `Gemini error ${res.status}` } }), { status: res.status, headers: { 'content-type': 'application/json' } })
    }
    const id = 'chatcmpl-gem-' + Date.now()
    const enc = new TextEncoder()
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    let toolIndex = 0
    let usage: any = null
    let finish: string | null = null
    const out = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const emit = (o: any) => ctrl.enqueue(enc.encode('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, ...o }) + '\n\n'))
        for (;;) {
          const nl = buf.indexOf('\n')
          if (nl >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line.startsWith('data:')) continue
            let j: any
            try {
              j = JSON.parse(line.slice(5))
            } catch {
              continue
            }
            const r = j.response ?? j
            const cand = r.candidates?.[0]
            for (const p of cand?.content?.parts ?? []) {
              if (p.thought) continue
              if (typeof p.text === 'string' && p.text) emit({ choices: [{ index: 0, delta: { content: p.text } }] })
              if (p.functionCall) {
                const tid = 'call_' + Math.random().toString(36).slice(2, 10) + (p.thoughtSignature ? SIG_SEP + p.thoughtSignature : '')
                emit({
                  choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex++, id: tid, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } }] } }],
                })
              }
            }
            if (cand?.finishReason) finish = cand.finishReason
            if (r.usageMetadata) usage = r.usageMetadata
            return
          }
          const { value, done } = await reader.read()
          if (done) {
            const reason = toolIndex > 0 ? 'tool_calls' : finish === 'MAX_TOKENS' ? 'length' : 'stop'
            emit({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })
            if (usage) emit({ choices: [], usage: { prompt_tokens: usage.promptTokenCount ?? 0, completion_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0), total_tokens: usage.totalTokenCount ?? 0 } })
            ctrl.enqueue(enc.encode('data: [DONE]\n\n'))
            ctrl.close()
            return
          }
          buf += value
        }
      },
      cancel() {
        reader.cancel().catch(() => {})
      },
    })
    return new Response(out, { headers: { 'content-type': 'text/event-stream' } })
  }
}

export const GEMINI_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview']
