import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes, randomBytes } from '@noble/hashes/utils.js'

export { bytesToHex, hexToBytes, utf8ToBytes, concatBytes, randomBytes }

export const randomHex = (n = 32) => bytesToHex(randomBytes(n))
export const sha256Hex = (data: Uint8Array | string) =>
  bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data))
export const hmacSha256 = (key: Uint8Array, data: Uint8Array | string) =>
  hmac(sha256, key, typeof data === 'string' ? utf8ToBytes(data) : data)
export const nowSec = () => Math.floor(Date.now() / 1000)

export function b64urlEncode(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function b64urlDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : ''
  const bin = atob(s + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
export const b64Encode = (bytes: Uint8Array) => {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(s)
}
export const b64Decode = (str: string) => {
  const bin = atob(str)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
export const jsonToB64url = (v: unknown) => b64urlEncode(utf8ToBytes(JSON.stringify(v)))
export const b64urlToJson = <T = any>(s: string): T => JSON.parse(new TextDecoder().decode(b64urlDecode(s)))

export function shortName(pk: string) {
  return pk.slice(0, 6)
}

export class Emitter<T extends Record<string, any>> {
  private handlers = new Map<keyof T, Set<(arg: any) => void>>()
  on<K extends keyof T>(k: K, fn: (arg: T[K]) => void): () => void {
    if (!this.handlers.has(k)) this.handlers.set(k, new Set())
    this.handlers.get(k)!.add(fn)
    return () => this.handlers.get(k)!.delete(fn)
  }
  emit<K extends keyof T>(k: K, arg: T[K]) {
    this.handlers.get(k)?.forEach((fn) => {
      try {
        fn(arg)
      } catch (e) {
        console.error(e)
      }
    })
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
