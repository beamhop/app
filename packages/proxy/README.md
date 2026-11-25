# @beamhop/proxy

A machine running in a browser tab cannot open sockets, and many HTTP endpoints refuse calls from a page. The Beamhop proxy is the small program its traffic leaves through. Anyone can host one; a room or a user points their machine at it. The wire protocol is in [PROTOCOL.md](PROTOCOL.md), the design in `docs/universal-sandbox.md` ("Network and the proxy").

This package contains:

| File | What it is | Status |
|---|---|---|
| `src/core.ts` | Token check, destination policy, limits, header encoding, configuration. No runtime dependencies. | Tested |
| `src/node.ts`, `src/cli.ts` | The proxy for Node 22 (`http` + `ws`), and its command-line entry. | Tested |
| `src/client.ts` | Browser-side client: `openTunnel`, `proxyFetch`, `health`. The package's main export. | Tested on Node 22's `WebSocket` and `fetch`, not in a browser |
| `src/worker.ts` | The proxy for Cloudflare Workers. | **Untested.** Type-checked only; it has never run. |

## Two modes, two levels of trust

**Tunnel mode** (`/v1/tcp`) forwards raw TCP over a WebSocket. TLS runs inside the machine, so the proxy operator sees which host and port you connect to, when, and how many bytes, and nothing else. It carries any protocol: HTTPS, git, SSH. Use it by default.

**Plain mode** (`/v1/http`) has the proxy make the HTTP request itself. The operator can read and change everything: URLs, API tokens, cookies, prompts and answers. Use it only with a proxy you run yourself, or one whose operator you would hand those tokens to. It exists for hosts where the proxy cannot open raw connections.

`GET /v1/health` says which modes a deployment offers. Set `BH_PROXY_MODES=tcp` to run a proxy that cannot see content at all.

## Run it on Node

Node 22 or later.

```sh
npm install            # in this directory, or at the repository root once the package is in the workspace
npm run build          # writes dist/beamhop-proxy.mjs, one file with no dependencies
BH_PROXY_TOKENS=$(openssl rand -hex 24) node dist/beamhop-proxy.mjs
```

The built file is also the package's `bin` (`beamhop-proxy`). It listens on `127.0.0.1:8787` unless told otherwise, logs one JSON line per connection to stdout (host, port, byte counts, duration, failure code; never tokens, paths or content), and on SIGINT or SIGTERM stops accepting, closes tunnels, lets requests in flight finish for up to five seconds, then exits.

Browsers only let an `https://` page talk to `wss://` and `https://` addresses (localhost excepted), so on the internet put the proxy behind a reverse proxy that terminates TLS. That reverse proxy must pass WebSocket upgrades and must not buffer responses, or server-sent events will stall. The proxy sends `X-Accel-Buffering: no` for nginx.

### Docker

```sh
docker build -t beamhop-proxy .
docker run --rm -p 8787:8787 -e BH_PROXY_TOKENS=change-me beamhop-proxy
```

The image sets `BH_PROXY_HOST=0.0.0.0` and runs as the unprivileged `node` user. The Dockerfile has not been built in this repository's environment (no Docker daemon there); its steps (`npm install`, `node build.mjs`, run the bundle) were run by hand outside a container.

### From code

```ts
import { parseConfig } from '@beamhop/proxy/core'
import { startProxy } from '@beamhop/proxy/node'

const proxy = await startProxy(parseConfig(process.env))
console.log(proxy.url)
await proxy.close()
```

## Deploy to Cloudflare Workers (untested)

`src/worker.ts` implements the same endpoints with `cloudflare:sockets` for tunnel mode and `fetch` for plain mode, and `wrangler.toml` is an example configuration. **Neither has been run.** The code is type-checked against a small set of local declarations and against `@cloudflare/workers-types`, and that is all. Expect to debug it on first deployment.

```sh
npx wrangler deploy
npx wrangler secret put BH_PROXY_TOKENS
```

Where Workers cannot meet the contract, and what the Worker does instead:

- **Backpressure towards the client.** PROTOCOL.md says the server stops reading from TCP while the WebSocket send buffer is above 1 MiB. Workers do not expose that buffer, so the Worker forwards as fast as the target sends and relies on the runtime's own buffering. A fast target and a slow client can exhaust the Worker's memory and end the connection. In the other direction (client to target) writes are chained on the socket's own backpressure, but incoming WebSocket messages cannot be paused, so they queue in memory too.
- **Resolving before connecting, tunnel mode.** The Worker resolves the name itself over DNS-over-HTTPS (`BH_PROXY_DOH_URL`), applies the address policy to the answer, and connects to the address. That meets the contract, with the caveat that it trusts the DoH resolver.
- **Resolving before connecting, plain mode.** `fetch` resolves the name itself, so the Worker cannot connect to the address it checked. It checks the DoH answer first, which refuses address literals and names that resolve to non-public addresses at that moment, but a name that changes its answer between the check and the fetch is not caught. What limits the damage is the platform: a Worker has no private network of its own to be steered into.
- **Limits.** Counters live in the memory of one isolate. Cloudflare runs many isolates and restarts them freely, so concurrent-connection and bytes-per-minute limits are per isolate and best effort. Real limits need a Durable Object or Cloudflare's rate limiting in front.
- **Plain-mode fidelity.** The runtime decompresses response bodies, so the Worker removes `content-encoding` and `content-length` from the reported headers when the target compressed its answer. Response header names arrive lower-cased, repeated headers other than `set-cookie` arrive merged, and order is not kept. On the request side the platform decides `Host` and adds headers of its own (such as `cf-worker`), so not every header in `x-bh-headers` reaches the target as sent.
- **Timeouts.** The idle timeout applies to tunnels. In plain mode it only bounds the wait for response headers; a stalled body is not cut. Platform limits on connection duration and CPU time apply on top.
- **Open mode** counts limits per `cf-connecting-ip`.

## Configuration

Environment variables on Node, `[vars]` and secrets on Workers. Lists are separated by commas or spaces. An invalid value stops the proxy from starting, with a message naming the variable.

| Variable | Default | Meaning |
|---|---|---|
| `BH_PROXY_TOKENS` | none | Access tokens. Each may contain `A-Z a-z 0-9 . _ ~ -`, up to 256 characters (they travel as a WebSocket subprotocol). Required unless `BH_PROXY_OPEN=1`. |
| `BH_PROXY_OPEN` | `0` | `1`: no token needed. Anyone who can reach the proxy can use it. |
| `BH_PROXY_ALLOW` | empty (all hosts) | Host patterns that may be reached. If set, every other host is refused. |
| `BH_PROXY_DENY` | empty | Host patterns that are refused. Wins over the allow list. |
| `BH_PROXY_ALLOW_PORTS` | empty (all ports) | Ports and ranges that may be reached, e.g. `443,8000-8100`. |
| `BH_PROXY_DENY_PORTS` | `25` | Ports and ranges that are refused. Set it empty to refuse none. |
| `BH_PROXY_ALLOW_PRIVATE` | `0` | `1`: also connect to loopback, private and other non-public addresses. For local testing only. |
| `BH_PROXY_MAX_CONNECTIONS` | `64` | Per token: tunnels plus plain requests open at once. `0` = unlimited. |
| `BH_PROXY_BYTES_PER_MINUTE` | `0` (unlimited) | Per token: bytes in both directions per clock minute. |
| `BH_PROXY_PORT` | `8787` | Listening port (Node). `0` picks a free one. |
| `BH_PROXY_HOST` | `127.0.0.1` | Listening address (Node). `0.0.0.0` to accept connections from other machines. |
| `BH_PROXY_IDLE_TIMEOUT_MS` | `300000` | A tunnel or plain request with no bytes in either direction for this long is closed. |
| `BH_PROXY_CONNECT_TIMEOUT_MS` | `10000` | DNS, TCP connect and (plain mode) TLS handshake must finish within this. |
| `BH_PROXY_MODES` | `tcp,http` | Modes offered. `tcp` alone gives a proxy that never sees content. |
| `BH_PROXY_QUIET` | `0` | `1`: no per-connection log lines (Node command line). |
| `BH_PROXY_DOH_URL` | `https://cloudflare-dns.com/dns-query` | DNS-over-HTTPS JSON endpoint (Workers only). |

Host patterns: `example.com` matches that host only; `*.example.com` matches every subdomain but not `example.com` itself; `*` matches everything. Patterns are compared with the host as the client named it (lower-cased), so a pattern does not cover the same server reached by its address.

### Destination policy

For both modes, in this order: token, host and port lists, connection limit, DNS, address check, connect.

After resolving, the proxy refuses addresses that are loopback, private (RFC 1918, unique local, site local), link-local, CGNAT (`100.64.0.0/10`), multicast, unspecified, IPv4-mapped IPv6 (all of `::ffff:0:0/96`, whatever it maps to), or otherwise reserved (documentation and benchmarking ranges, `240.0.0.0/4`, Teredo, and NAT64 or 6to4 addresses that embed one of the above). It then connects to the address it checked, never to the name, so a second DNS answer cannot redirect the connection (DNS rebinding). If a name resolves to several addresses, only the permitted ones are tried, up to four.

Loose numeric host forms that resolvers read as addresses (`0x7f.1`, `2130706433`, `010.0.0.1`) are rejected outright in tunnel mode. In plain mode the URL parser turns them into ordinary addresses first, and those are then checked.

### Limits

Limits are counted per token, or per client address when the proxy is open. When a token is over its bytes for the current minute, its open connections are cut (tunnels close with code 4002; plain responses fail with `limit` or are aborted mid-body) and new ones are refused with `limit` until the next minute starts. There is no throttling. Counters are in memory and reset on restart.

## Client

```ts
import { openTunnel, proxyFetch, health } from '@beamhop/proxy'

const { modes } = await health('https://proxy.example')

const tunnel = await openTunnel({ proxyUrl: 'https://proxy.example', token, host: 'github.com', port: 443 })
tunnel.onData = (bytes) => { /* ... */ }      // or: for await (const bytes of tunnel) { ... }
tunnel.onEnd = () => { /* the target half-closed */ }
tunnel.onClose = ({ code, reason }) => { /* gone */ }
tunnel.onError = (error) => { /* died abnormally; onClose follows */ }
await tunnel.write(bytes)                      // resolves when the send buffer is back under 1 MiB
tunnel.end()                                   // half-close: the target can still answer
tunnel.close()                                 // tear down both directions

const res = await proxyFetch({
  proxyUrl: 'https://proxy.example', token,
  url: 'https://api.example.com/v1/messages', method: 'POST',
  headers: [['user-agent', 'my-harness/1.0'], ['cookie', 'a=1']],
  body: JSON.stringify({ /* ... */ }),
})
res.status                                     // the target's status
res.headers                                    // [name, value][] in order, each set-cookie separate
res.body                                       // ReadableStream<Uint8Array>, streamed as it arrives
```

Both functions reject with a `ProxyError` whose `code` is the proxy's (`auth`, `policy`, `dns`, `connect`, `timeout`, `limit`, `request`) or `proxy` when the proxy itself could not be reached or did not answer like a Beamhop proxy. A target's own error status (including a 502) is a normal result of `proxyFetch`, not an error.

Things to know when integrating:

- **No backpressure on received tunnel data in a browser.** The WebSocket API cannot pause. Bytes the page has not consumed yet queue in memory (inside the client until `onData` is set or the iterator is read). The proxy's 1 MiB rule only keeps the proxy's memory bounded.
- **`write()` backpressure** polls `bufferedAmount` every 4 ms while it is above 1 MiB, since browsers have no drain event. Data is sent in frames of at most 256 KiB; the Node proxy rejects frames above 4 MiB.
- **Use callbacks or the async iterator, not both.** The iterator ends when the target half-closes or the tunnel closes normally, and throws if the tunnel dies.
- **After the target half-closes, the tunnel stays open** until you call `end()` or `close()`, or the idle timeout passes. The proxy closes with 1000 once both sides have ended.
- **Bodies are passed unchanged.** If the request asks for `gzip` (through `accept-encoding` in `headers`), the body you get is gzip and `content-encoding` in `res.headers` says so; the Node proxy never asks for compression on its own. (The Worker differs, see above.)
- **Streaming request bodies** (`body` as a `ReadableStream`) need `duplex: "half"`, which browsers only allow over HTTP/2 or HTTP/3 and only Chromium implements. Pass bytes or a string unless you know the proxy is reached that way.
- **Redirects.** The proxy never sends a real `Location` header, so the browser does not follow a target's 3xx; it reaches you as `status: 302` with `location` in `res.headers`.
- **Header size.** `x-bh-headers` travels in a request header. The Node proxy accepts up to 128 KiB of request headers in total; a reverse proxy in front may allow less.
- `openTunnel` and `proxyFetch` accept `WebSocket` and `fetch` implementations as options, and an `AbortSignal`.

## Security notes

- **Never run an open proxy on the public internet.** `BH_PROXY_OPEN=1` turns the proxy into a relay for anyone who finds it: spam, scanning and attacks will come from your address. Open mode is for localhost and for networks where everyone who can connect is trusted.
- **Never set `BH_PROXY_ALLOW_PRIVATE=1` on a proxy others can reach.** It lets every token holder reach the proxy host's own services and network: cloud metadata endpoints, databases, admin panels.
- **A token is the whole credential.** In tunnel mode it is sent as a WebSocket subprotocol, in plain mode as a header. Serve the proxy over TLS, and note that reverse proxies may log the `Sec-WebSocket-Protocol` header. Give each user or room its own token so that limits and revocation apply to one of them.
- **Plain mode exposes everything to the operator**, as described above. If you host a proxy for people who should not have to trust you, set `BH_PROXY_MODES=tcp`.
- **An allow list narrows what a compromised machine can reach, it does not make it safe.** Prompt injection inside the machine can send what is on the machine to any destination the proxy allows.
- **The destination's view.** Traffic arrives from the proxy's address. Abuse reports and rate limits will name the operator.
- The proxy holds no state on disk and logs no content. Per-connection log lines contain destination hosts, which are personal data in some settings; set `BH_PROXY_QUIET=1` to drop them.

## Where this implementation adds to or departs from PROTOCOL.md

- **Extra failure code `request`** for malformed requests (missing or invalid `host`, `port`, `x-bh-url`, `x-bh-headers`), in both the tunnel's first frame and `x-bh-error`. The client adds `proxy` for failures to reach the proxy; that code never appears on the wire.
- **Close codes on an established tunnel**, which the protocol leaves open: 1000 both sides ended or the target closed cleanly, 1001 proxy shutting down, 1002 protocol violation (unexpected text frame, data after `{"end":true}`), 1008 after a refusal frame, 1011 the target connection failed, 4001 idle timeout, 4002 byte limit.
- **"Unless explicitly allowed"** is one switch, `BH_PROXY_ALLOW_PRIVATE`. Putting a host on the allow list does not exempt it from the address check.
- **More is refused than the protocol lists:** reserved and documentation ranges, every IPv4-mapped address, and port 25 by default.
- **Connection-level headers are not relayed** in plain mode. Towards the target the proxy drops `connection`, `keep-alive`, `proxy-connection`, `proxy-authorization`, `transfer-encoding`, `upgrade`, `te`, `trailer`, `expect`, and sets `content-length` from the body it actually receives; it sends `connection: close` and, when none was given, `host` from the URL. From the target it leaves `connection`, `keep-alive`, `proxy-connection`, `transfer-encoding`, `trailer` and `upgrade` out of `x-bh-resp-headers`. Trailers and 1xx responses are not relayed, and a target that switches protocols is reported as `connect`.
- **Not every proxy answer on `/v1/http` is a 502.** Forwarding failures are, as specified. A path that does not exist or a mode that is switched off answers 404, and a plain GET to `/v1/tcp` answers 426.
- **A failure after the response has started** (target dies mid-body, idle timeout, byte limit) cannot be reported as a 502; the proxy aborts the connection and the client's body stream errors.
- **`OPTIONS /v1/http` with an `x-bh-url` header is forwarded** to the target; without one it is treated as a CORS preflight.
- **Frames sent before `{"ok":true}`** are held (up to 1 MiB) and forwarded once connected, rather than rejected.
- **The proxy's response also carries** the target's `content-type` and, when known, `content-length` as real headers, plus `cache-control: no-store`.
- The Workers entry departs further; see its section above.

## Tests

From the repository root:

```sh
BH_TEST_PENDING=1 npx vitest run packages/proxy
npx tsc -p packages/proxy
```

The tests start the Node proxy on an ephemeral port with local TCP, HTTP and HTTPS targets. They need `openssl` on the path for the HTTPS test (skipped without it). Nothing in them exercises `src/worker.ts`.
