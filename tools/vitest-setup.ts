// Node's built-in WebSocket recurses forever when nostr-tools closes a socket that failed to
// connect (see packages/bridge/src/ws-polyfill.ts). Tests use the `ws` package, like the bridge.
import WebSocket from 'ws'
import { useWebSocketImplementation } from 'nostr-tools/pool'
useWebSocketImplementation(WebSocket)
