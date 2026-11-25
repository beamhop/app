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
