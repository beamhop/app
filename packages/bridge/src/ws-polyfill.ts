// Node's built-in WebSocket re-fires `error` when nostr-tools closes a socket that failed to
// connect, which recurses until the stack overflows. The `ws` package doesn't.
import WebSocket from 'ws'
import { useWebSocketImplementation } from 'nostr-tools/pool'
useWebSocketImplementation(WebSocket)
