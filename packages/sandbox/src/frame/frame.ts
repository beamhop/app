// The machine frame's page script. It does three things: start the kernel worker, tell the embedding app the
// frame is ready, and hand the app's MessagePort to the worker. After that the page is idle: the app and the
// worker talk directly, so a busy page cannot delay them and a frozen worker cannot hide behind the page.
import { MACHINE_PROTOCOL, type MachineHello, type MachineInit } from '../protocol.js'

const worker = new Worker(new URL('worker.js', location.href), { name: 'beamhop-machine' })
worker.onerror = (ev) => console.error('[machine] worker error:', ev.message)

let initialised = false
addEventListener('message', (ev: MessageEvent<Partial<MachineInit> | null>) => {
  // Only the embedding window may initialise the machine. Which origins may embed it at all is the CSP's
  // frame-ancestors directive; the frame holds no secrets before init, so nothing is gained by guessing here.
  if (ev.source !== parent || initialised) return
  const msg = ev.data
  if (!msg || msg.bh !== 'machine-init' || !(msg.port instanceof MessagePort)) return
  if (msg.v !== MACHINE_PROTOCOL) {
    console.error(`[machine] protocol mismatch: app speaks ${String(msg.v)}, machine speaks ${MACHINE_PROTOCOL}`)
    return
  }
  initialised = true
  worker.postMessage({ bh: 'machine-port', port: msg.port }, [msg.port])
})

if (parent === window) {
  document.body.textContent = 'This page is a Beamhop machine. It does nothing unless the Beamhop app embeds it.'
} else {
  // '*': the hello carries nothing, and the frame cannot know the embedding origin before it is told.
  parent.postMessage({ bh: 'machine-hello', v: MACHINE_PROTOCOL } satisfies MachineHello, '*')
}
