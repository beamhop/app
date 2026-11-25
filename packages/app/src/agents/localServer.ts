// Reaching model servers on the user's own computer or network (Ollama, or any OpenAI-compatible
// server) from the page. A browser blocks these requests in three ways that all look alike from
// JavaScript ("Failed to fetch"):
//   1. mixed content: an https page may not call an http:// address, except localhost;
//   2. CORS: the server must allow this page's origin (Ollama: OLLAMA_ORIGINS);
//   3. the server isn't reachable (not running, bound to 127.0.0.1 only, firewall, or the browser's
//      local-network permission was declined).
// The Companion extension is subject to none of them, so requests go through it when it's
// installed and a direct request can't work. Otherwise failures are explained.
import { extFetch, extensionVersion } from '../core/extension'

const LOOPBACK = /^(localhost|127(?:\.\d+){3}|\[::1\])$/i

export type LocalServerKind = 'ollama' | 'custom'

/** Would the browser block this URL as mixed content from this page? */
export function isMixedContent(url: string, pageProtocol = location.protocol) {
  try {
    const u = new URL(url)
    return pageProtocol === 'https:' && u.protocol === 'http:' && !LOOPBACK.test(u.hostname)
  } catch {
    return false
  }
}

/** The page's origin, as the server must allow it. */
const pageOrigin = () => location.origin

/** What to tell the user when a request to `url` failed at the network level. */
export async function explainLocalServerFailure(kind: LocalServerKind, url: string): Promise<string> {
  const name = kind === 'ollama' ? 'Ollama' : 'The server'
  const host = (() => {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  })()
  if (isMixedContent(url))
    return (
      `Your browser blocks plain http:// addresses on your network (${host}) from this https page, whatever ${kind === 'ollama' ? 'Ollama' : 'the server'} allows. ` +
      `Install the Beamhop Companion extension (Settings → Companion extension) and Beamhop will reach it through the extension, ` +
      `or put it behind https (for example tailscale serve or Caddy), or run it on this computer and use http://localhost:${kind === 'ollama' ? '11434' : '…'}.`
    )
  // A no-cors request succeeds (with an unreadable response) whenever the server answers at all,
  // so it tells a CORS refusal apart from a server that isn't reachable.
  const reachable = await fetch(url, { mode: 'no-cors', cache: 'no-store' }).then(
    () => true,
    () => false,
  )
  if (reachable && kind === 'ollama')
    return (
      `Ollama is running at ${host} but doesn’t allow this page. Allow it with OLLAMA_ORIGINS=${pageOrigin()} (or *), then restart Ollama:\n` +
      `• macOS app: launchctl setenv OLLAMA_ORIGINS "${pageOrigin()}", then quit and reopen Ollama\n` +
      `• Linux (systemd): sudo systemctl edit ollama, add [Service] Environment="OLLAMA_ORIGINS=${pageOrigin()}", then sudo systemctl restart ollama\n` +
      `• Windows: add the user environment variable OLLAMA_ORIGINS = ${pageOrigin()}, then quit Ollama from the tray and start it again\n` +
      `• Terminal: OLLAMA_ORIGINS="${pageOrigin()}" ollama serve`
    )
  if (reachable) return `${name} at ${host} answered, but doesn’t allow requests from this page. It needs to send CORS headers allowing ${pageOrigin()}.`
  return (
    `Can’t reach ${name.toLowerCase() === 'the server' ? 'the server' : 'Ollama'} at ${host}. Check that it’s running` +
    (LOOPBACK.test(host.replace(/:\d+$/, ''))
      ? '.'
      : `, that it listens on your network (Ollama: OLLAMA_HOST=0.0.0.0) and that no firewall blocks port ${new URL(url).port || '80'}.`) +
    ' If your browser asked to let this site access devices on your local network, allow it.' +
    (extensionVersion() ? '' : ' The Beamhop Companion extension can also reach it when the browser won’t.')
  )
}

/**
 * fetch() for a local model server. Goes through the Companion extension when it's installed and
 * a direct request can't work; otherwise fetches directly and turns a network failure into an
 * explanation.
 */
export function localServerFetch(kind: LocalServerKind, baseUrl: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const ext = !!extensionVersion()
    if (ext && isMixedContent(url)) return extFetch(url, init)
    try {
      return await fetch(input, init)
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e
      // The extension isn't bound by CORS or the browser's network rules: try once through it.
      if (ext) return extFetch(url, init)
      throw new Error(await explainLocalServerFailure(kind, baseUrl))
    }
  }) as typeof fetch
}

/** Checks that the model list can be read, for the provider's Save button. Resolves with the model ids. */
export async function testLocalServer(kind: LocalServerKind, baseUrl: string, apiKey?: string): Promise<string[]> {
  const root = baseUrl.replace(/\/$/, '')
  const url = kind === 'ollama' ? `${root}/v1/models` : `${root}/models`
  const r = await localServerFetch(kind, root)(url, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} })
  if (!r.ok) throw new Error(`${kind === 'ollama' ? 'Ollama' : 'The server'} answered ${r.status} for ${url}. Is the address right?`)
  const j = await r.json().catch(() => ({}))
  return (j.data ?? []).map((m: any) => m.id).filter(Boolean)
}
