import { it } from 'vitest'
import { connectTls, RootStore } from '../src/index'
import { issue } from './helpers/certs'
import { startTlsServer } from './helpers/net'
it('dbg', async () => {
  const ca = await issue({ cn: 'root', ca: true })
  const l = await issue({ cn: 'a.example', issuer: ca })
  const s = await startTlsServer({ key: l.key, cert: l.pem }, (sk) => sk.end('bye'))
  for (const mode of ['tcp'] as const) {
    const c = await s.connect(mode)
    c.raw.on('data', (d) => console.log('rx', d.length, d.subarray(0, 5).toString('hex')))
    c.raw.on('end', () => console.log('rx end'))
    const ow = c.transport.write
    c.transport.write = (b) => { console.log('tx', b.length); return ow(b) }
    const sock = await connectTls(c.transport, { serverName: 'a.example', roots: RootStore.fromPem(ca.pem) })
    console.log(mode, 'connected')
    const r = sock.readable.getReader()
    for (;;) { const x = await r.read().catch((e) => ({ done: true, value: String(e) })); console.log(x.done, String(x.value)); if (x.done) break }
  }
})
