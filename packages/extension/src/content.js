// Beamhop Companion: content script. Bridges the Beamhop page and the background worker.
const VERSION = chrome.runtime.getManifest().version
document.documentElement.dataset.beamhopCompanion = VERSION
const hello = () => window.postMessage({ __bh: 'hello', version: VERSION }, location.origin)
hello()

let port = null
function getPort() {
  if (port) return port
  port = chrome.runtime.connect({ name: 'beamhop' })
  port.onMessage.addListener((msg) => window.postMessage({ __bh: 'res', ...msg }, location.origin))
  port.onDisconnect.addListener(() => {
    port = null
  })
  return port
}

window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin) return
  const d = e.data
  if (!d || typeof d !== 'object') return
  if (d.__bh === 'ping') return hello()
  if (d.__bh !== 'req' || typeof d.id !== 'string') return
  try {
    getPort().postMessage(d)
  } catch (err) {
    port = null
    try {
      getPort().postMessage(d)
    } catch {
      window.postMessage({ __bh: 'res', id: d.id, kind: 'error', message: 'Companion extension disconnected. Reload the page.' }, location.origin)
    }
  }
})
