// Beamhop Companion: background worker. Makes cross-origin requests for the Beamhop page
// (no CORS, no cookies) and watches sign-in tabs for their redirect address.
const api = globalThis.browser ?? globalThis.chrome
const ALLOWED_PAGES = [/^https:\/\/beamhop\.github\.io\//, /^http:\/\/localhost(:\d+)?\//, /^http:\/\/127\.0\.0\.1(:\d+)?\//]

const b64 = (u8) => {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return btoa(s)
}
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

// Strip the extension's Origin header so APIs treat requests like a native client's.
async function setupRules() {
  if (!api.declarativeNetRequest?.updateSessionRules) return
  try {
    await api.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
      addRules: [
        {
          id: 1,
          priority: 1,
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
          condition: { initiatorDomains: [api.runtime.id], resourceTypes: ['xmlhttprequest', 'other'] },
        },
      ],
    })
  } catch (e) {
    console.warn('DNR rules not set', e)
  }
}
setupRules()
api.runtime.onStartup?.addListener(setupRules)
api.runtime.onInstalled?.addListener(setupRules)

const inflight = new Map()

api.runtime.onConnect.addListener((port) => {
  if (port.name !== 'beamhop') return
  const sender = port.sender?.url ?? port.sender?.tab?.url ?? ''
  if (!ALLOWED_PAGES.some((r) => r.test(sender))) {
    port.disconnect()
    return
  }
  const send = (m) => {
    try {
      port.postMessage(m)
    } catch {}
  }
  port.onDisconnect.addListener(() => {
    for (const [id, c] of inflight) if (c.port === port) (c.abort(), inflight.delete(id))
  })
  port.onMessage.addListener(async (d) => {
    const id = d.id
    if (d.op === 'abort') {
      inflight.get(id)?.abort()
      inflight.delete(id)
      return
    }
    if (d.op === 'fetch') {
      const ctrl = new AbortController()
      inflight.set(id, { abort: () => ctrl.abort(), port })
      try {
        if (!/^https?:\/\//.test(d.url)) throw new Error('Only http(s) URLs')
        const res = await fetch(d.url, {
          method: d.method || 'GET',
          headers: d.headers || [],
          body: d.body ? unb64(d.body) : undefined,
          credentials: 'omit',
          redirect: 'follow',
          signal: ctrl.signal,
        })
        const headers = []
        res.headers.forEach((v, k) => headers.push([k, v]))
        send({ id, kind: 'head', status: res.status, statusText: res.statusText, headers })
        if (res.body) {
          const reader = res.body.getReader()
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            send({ id, kind: 'chunk', data: b64(value) })
          }
        }
        send({ id, kind: 'end' })
      } catch (e) {
        send({ id, kind: 'error', message: String(e?.message ?? e) })
      } finally {
        inflight.delete(id)
      }
      return
    }
    if (d.op === 'capture') {
      try {
        const url = await capture(d.url, d.redirectPrefix)
        send({ id, kind: 'result', value: url })
      } catch (e) {
        send({ id, kind: 'error', message: String(e?.message ?? e) })
      }
      return
    }
    send({ id, kind: 'error', message: 'Unknown request' })
  })
})

/** Open `url` in a new tab; resolve with the first address starting with `prefix`, then close the tab. */
function capture(url, prefix) {
  if (!/^https:\/\//.test(url) || !/^https?:\/\//.test(prefix)) return Promise.reject(new Error('Bad sign-in address'))
  return new Promise((resolve, reject) => {
    let tabId = null
    const done = (fn, v) => {
      api.tabs.onUpdated.removeListener(onUpdated)
      api.tabs.onRemoved.removeListener(onRemoved)
      api.webNavigation?.onBeforeNavigate.removeListener(onNav)
      clearTimeout(timer)
      fn(v)
    }
    const check = (tid, u) => {
      if (tid !== tabId || !u || !u.startsWith(prefix)) return
      api.tabs.remove(tabId).catch(() => {})
      done(resolve, u)
    }
    const onUpdated = (tid, info, tab) => check(tid, info.url ?? tab?.url)
    const onNav = (details) => details.frameId === 0 && check(details.tabId, details.url)
    const onRemoved = (tid) => tid === tabId && done(reject, new Error('The sign-in tab was closed'))
    const timer = setTimeout(() => done(reject, new Error('Sign-in timed out')), 10 * 60_000)
    api.tabs.onUpdated.addListener(onUpdated)
    api.tabs.onRemoved.addListener(onRemoved)
    api.webNavigation?.onBeforeNavigate.addListener(onNav)
    api.tabs.create({ url }).then((t) => (tabId = t.id), (e) => done(reject, e))
  })
}
