// "Sign in with OpenRouter" (OAuth PKCE), entirely in the browser.
const VERIFIER_KEY = 'beamhop-openrouter-verifier'
const RETURN_KEY = 'beamhop-openrouter-return'

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export async function startOpenRouterSignIn(returnHash: string) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)))
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  sessionStorage.setItem(VERIFIER_KEY, verifier)
  sessionStorage.setItem(RETURN_KEY, returnHash)
  const callback = location.origin + location.pathname + '?openrouter=1'
  location.href = `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callback)}&code_challenge=${challenge}&code_challenge_method=S256`
}

/** Call at startup. Returns the API key when we're coming back from OpenRouter. */
export async function finishOpenRouterSignIn(): Promise<{ key: string; returnHash: string } | null> {
  const params = new URLSearchParams(location.search)
  if (!params.get('openrouter')) return null
  const code = params.get('code')
  const verifier = sessionStorage.getItem(VERIFIER_KEY)
  const returnHash = sessionStorage.getItem(RETURN_KEY) || '#/agents'
  history.replaceState(null, '', location.pathname + returnHash)
  if (!code || !verifier) return null
  const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  })
  sessionStorage.removeItem(VERIFIER_KEY)
  if (!res.ok) throw new Error(`OpenRouter sign-in failed (${res.status})`)
  const j = await res.json()
  return { key: j.key, returnHash }
}
