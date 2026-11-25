// Command-line entry for the Node proxy: configuration from environment variables (see README.md).
import { parseConfig, type ProxyConfig } from './core'
import { startProxy } from './node'

let cfg: ProxyConfig
try {
  cfg = parseConfig(process.env)
} catch (e) {
  console.error(`beamhop-proxy: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(2)
}

const quiet = /^(1|true|yes|on)$/i.test(process.env.BH_PROXY_QUIET ?? '')
const proxy = await startProxy(cfg, {
  log: quiet ? undefined : (entry) => console.log(JSON.stringify({ t: new Date().toISOString(), ...entry })),
})

console.error(`beamhop-proxy listening on ${proxy.url} (modes: ${cfg.modes.join(', ')})`)
if (cfg.open) console.error('beamhop-proxy: WARNING: BH_PROXY_OPEN is set. Anyone who can reach this address can use the proxy.')
if (cfg.allowPrivate) console.error('beamhop-proxy: WARNING: BH_PROXY_ALLOW_PRIVATE is set. Clients can reach this machine and its private network.')

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1)
    stopping = true
    console.error(`beamhop-proxy: ${signal}, shutting down`)
    void proxy.close().then(() => process.exit(0))
  })
}
