// Polyfill packages that ship no type declarations. They are used only through vendor.ts.
declare module 'readable-stream' {
  const stream: any
  export default stream
}
declare module 'path-browserify' {
  const path: any
  export default path
}
declare module 'querystring-es3' {
  const querystring: any
  export default querystring
}
declare module 'punycode/' {
  const punycode: any
  export default punycode
}
declare module 'assert/' {
  const assert: any
  export default assert
}
declare module 'events/' {
  const events: any
  export default events
}
declare module 'url/' {
  const url: any
  export default url
}
declare module 'util/' {
  const util: any
  export default util
}
declare module 'process/' {
  const process: any
  export default process
}
declare module 'buffer/' {
  export const Buffer: any
  export const SlowBuffer: any
  export const kMaxLength: number
  export const INSPECT_MAX_BYTES: number
}
declare module 'string_decoder/' {
  export const StringDecoder: any
}
