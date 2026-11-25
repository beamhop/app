// Platform objects, captured when the bundle loads.
//
// Guest programs share the worker's realm and some replace web globals: undici's install() (which pi runs)
// overwrites fetch, Response, Headers, Request, FormData and WebSocket with its own implementations. Code in
// this package that runs after a guest has started must not pick those up, so it uses these references instead
// of the globals. (Per-process globals such as timers and `process` are not at risk: see node/globals.ts.)
const g = globalThis

export const host = {
  fetch: g.fetch?.bind(g),
  Response: g.Response,
  Headers: g.Headers,
  Request: g.Request,
  ReadableStream: g.ReadableStream,
  Blob: g.Blob,
  DecompressionStream: g.DecompressionStream,
  CompressionStream: g.CompressionStream,
  DOMException: g.DOMException,
  URL: g.URL,
  TextEncoder: g.TextEncoder,
  TextDecoder: g.TextDecoder,
  AbortController: g.AbortController,
}
