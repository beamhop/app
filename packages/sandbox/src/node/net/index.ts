// net, tls, http, https and fetch for one Node process.
import type { Dyn, ProcessCore } from '../types.js'
import { createFetch } from './fetch.js'
import { createHttp } from './http.js'
import { createSockets, type NetStats } from './socket.js'

export function createNet(deps: { core: ProcessCore; stream: Dyn; EventEmitter: Dyn }) {
  const stats: NetStats = { sockets: 0, tlsSockets: 0, bridgeRequests: 0, tunnelConnections: 0, bytesOut: 0, bytesIn: 0 }
  const { net, tls, Server } = createSockets({ ...deps, stats })
  const { fetch, transportFetch } = createFetch({ core: deps.core, net, tls, stats })
  const { http, https } = createHttp({ ...deps, net, Server, transportFetch })
  return { net, tls, http, https, fetch, stats }
}
