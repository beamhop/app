# Beamhop proxy protocol, v1

The proxy lets a machine running in a browser tab reach hosts that browsers cannot: raw TCP, and HTTP endpoints without CORS. It is one small program that anyone can host. See `docs/universal-sandbox.md`.

All endpoints answer CORS preflights for any origin. Every request carries an access token unless the proxy runs with `BH_PROXY_OPEN=1`.

## Tunnel mode: `GET /v1/tcp` (WebSocket)

Blind byte forwarding. The proxy sees the destination host, port and volume; with TLS running in the client it never sees content.

- Query: `host`, `port`.
- Token: WebSocket subprotocols `bh1` and `bh1.<token>` are offered; the server selects `bh1`. Browsers cannot set headers on a WebSocket, so the token rides in the subprotocol list.
- On upgrade the proxy checks token and destination policy, then opens the TCP connection.
- First server frame is text: `{"ok":true}` once TCP is connected, or `{"ok":false,"code":"...","message":"..."}` followed by close. Codes: `auth`, `policy`, `dns`, `connect`, `timeout`, `limit`.
- After `{"ok":true}`: every binary frame is bytes for the socket, in either direction. A text frame `{"end":true}` from either side is a half-close (FIN) in that direction. WebSocket close tears down both.
- Backpressure: the server stops reading from TCP while the WebSocket send buffer is above 1 MiB.

## Plain mode: `/v1/http` (any method)

The proxy makes the HTTP request itself, so its operator can read it. Use only when self-hosted or when tunnel mode is unavailable.

- `x-bh-url`: absolute target URL.
- `x-bh-token`: access token.
- `x-bh-headers`: JSON array of `[name, value]` pairs to send to the target, base64url encoded. This carries headers that `fetch` refuses to set (`user-agent`, `cookie`, `host`, ...).
- Request body is streamed to the target unchanged.
- Response: target status, body streamed unchanged, no buffering (server-sent events must pass through). Target response headers are returned base64url-JSON encoded in `x-bh-resp-headers` (array of pairs, including `set-cookie`), and `x-bh-status` repeats the status. The proxy's own failures use status 502 with `x-bh-error: <code>` and a JSON body `{code, message}`.
- Redirects are not followed; the client sees the 3xx.

## Policy

Checked for both modes, after DNS resolution:

- Destinations that resolve to loopback, private, link-local, CGNAT, multicast or unspecified addresses are refused (`policy`), unless explicitly allowed. This stops the proxy being used to reach its host's internal network.
- Optional allowlist and denylist of host patterns (`*.example.com`) and ports.
- Per-token limits: concurrent connections, bytes per minute.

## Health

`GET /v1/health` returns `{"ok":true,"v":1,"modes":["tcp","http"]}` listing the modes this deployment supports. No token needed.
