// node:crypto: hashes, HMAC, PBKDF2 and randomness. Ciphers, signatures and key objects are not implemented.
import { hmac } from '@noble/hashes/hmac.js'
import { md5, ripemd160, sha1 } from '@noble/hashes/legacy.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { sha224, sha256, sha384, sha512 } from '@noble/hashes/sha2.js'
import { sha3_256, sha3_512 } from '@noble/hashes/sha3.js'
import type { Dyn, Track } from '../types.js'
import { BufferPkg as Buffer } from '../vendor.js'
import { notImplemented } from './core.js'

export function makeCrypto({ Buffer, stream, track, host }: Dyn) {
  const algos: Record<string, Dyn> = { sha1, md5, sha256, sha224, sha512, sha384, ripemd160, 'sha3-256': sha3_256, 'sha3-512': sha3_512, rmd160: ripemd160 }
  const getAlgo = (name?: Dyn) => {
    const a = algos[String(name).toLowerCase().replace(/^rsa-/, '')]
    if (!a) {
      track('crypto-unsupported-hash', name)
      const e: Dyn = new Error('Digest method not supported: ' + name)
      e.code = 'ERR_CRYPTO_INVALID_DIGEST'
      throw e
    }
    return a
  }
  const toU8 = (d?: Dyn, enc?: Dyn) =>
    typeof d === 'string'
      ? new Uint8Array(Buffer.from(d, enc || 'utf8'))
      : d instanceof ArrayBuffer
        ? new Uint8Array(d)
        : new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
  const out = (bytes?: Dyn, enc?: Dyn) => {
    const b = Buffer.from(bytes)
    return enc && enc !== 'buffer' ? b.toString(enc) : b
  }
  class Hash extends stream.Transform {
    constructor(h?: Dyn) {
      super()
      this._h = h
    }
    update(d?: Dyn, enc?: Dyn) {
      this._h.update(toU8(d, enc))
      return this
    }
    digest(enc?: Dyn) {
      return out(this._h.digest(), enc)
    }
    copy() {
      return new Hash(this._h.clone())
    }
    _transform(c?: Dyn, e?: Dyn, cb?: Dyn) {
      this.update(c, e)
      cb()
    }
    _flush(cb?: Dyn) {
      this.push(this.digest())
      cb()
    }
  }
  const webcrypto = host.crypto
  const randomBytes = (n?: Dyn, cb?: Dyn) => {
    const b = Buffer.alloc(n)
    for (let i = 0; i < n; i += 65536) webcrypto.getRandomValues(new Uint8Array(b.buffer, b.byteOffset + i, Math.min(65536, n - i)))
    if (cb) {
      queueMicrotask(() => cb(null, b))
      return
    }
    return b
  }
  const ni = (name?: Dyn) => notImplemented(track, 'crypto.' + name)
  const c = {
    webcrypto,
    subtle: webcrypto.subtle,
    getRandomValues: (a?: Dyn) => webcrypto.getRandomValues(a),
    randomUUID: () => webcrypto.randomUUID(),
    randomBytes,
    pseudoRandomBytes: randomBytes,
    randomFillSync: (buf?: Dyn, offset: Dyn = 0, size?: Dyn) => {
      const u = new Uint8Array(buf.buffer, buf.byteOffset + offset, size ?? buf.byteLength - offset)
      for (let i = 0; i < u.length; i += 65536) webcrypto.getRandomValues(u.subarray(i, i + 65536))
      return buf
    },
    randomFill: (buf?: Dyn, ...rest: Dyn[]) => {
      const cb = rest.pop()
      c.randomFillSync(buf, ...rest)
      queueMicrotask(() => cb(null, buf))
    },
    randomInt: (min?: Dyn, max?: Dyn, cb?: Dyn) => {
      if (typeof max !== 'number') {
        cb = max
        max = min
        min = 0
      }
      const v = min + (webcrypto.getRandomValues(new Uint32Array(1))[0] % (max - min))
      if (cb) {
        queueMicrotask(() => cb(null, v))
        return
      }
      return v
    },
    createHash: (name?: Dyn) => new Hash(getAlgo(name).create()),
    createHmac: (name?: Dyn, key?: Dyn) => new Hash(hmac.create(getAlgo(name), toU8(key))),
    hash: (name?: Dyn, data?: Dyn, enc: Dyn = 'hex') => out(getAlgo(name)(toU8(data)), enc),
    getHashes: () => Object.keys(algos),
    getCiphers: () => [],
    getCurves: () => [],
    timingSafeEqual: (a?: Dyn, b?: Dyn) => {
      if (a.byteLength !== b.byteLength) {
        const e: Dyn = new RangeError('Input buffers must have the same byte length')
        e.code = 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH'
        throw e
      }
      let d = 0
      const x = toU8(a),
        y = toU8(b)
      for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]
      return d === 0
    },
    pbkdf2Sync: (pw?: Dyn, salt?: Dyn, iterations?: Dyn, keylen?: Dyn, digest: Dyn = 'sha1') =>
      Buffer.from(pbkdf2(getAlgo(digest), toU8(pw), toU8(salt), { c: iterations, dkLen: keylen })),
    pbkdf2: (pw?: Dyn, salt?: Dyn, iterations?: Dyn, keylen?: Dyn, digest?: Dyn, cb?: Dyn) => {
      let r: Dyn,
        e = null
      try {
        r = c.pbkdf2Sync(pw, salt, iterations, keylen, digest)
      } catch (x: Dyn) {
        e = x
      }
      queueMicrotask(() => cb(e, r))
    },
    createCipheriv: ni('createCipheriv'),
    createDecipheriv: ni('createDecipheriv'),
    createSign: ni('createSign'),
    createVerify: ni('createVerify'),
    sign: ni('sign'),
    verify: ni('verify'),
    createPublicKey: ni('createPublicKey'),
    createPrivateKey: ni('createPrivateKey'),
    createSecretKey: ni('createSecretKey'),
    generateKeyPairSync: ni('generateKeyPairSync'),
    generateKeyPair: ni('generateKeyPair'),
    publicEncrypt: ni('publicEncrypt'),
    privateDecrypt: ni('privateDecrypt'),
    scryptSync: ni('scryptSync'),
    scrypt: ni('scrypt'),
    createECDH: ni('createECDH'),
    createDiffieHellman: ni('createDiffieHellman'),
    hkdfSync: ni('hkdfSync'),
    X509Certificate: class X509Certificate {
      constructor() {
        ni('X509Certificate')()
      }
    },
    KeyObject: class KeyObject {},
    Hash,
    Hmac: Hash,
    constants: {
      RSA_PKCS1_PADDING: 1,
      RSA_PKCS1_OAEP_PADDING: 4,
      RSA_PKCS1_PSS_PADDING: 6,
      SSL_OP_NO_TLSv1: 67108864,
      SSL_OP_NO_TLSv1_1: 268435456,
      SSL_OP_ALL: 2147485776,
    },
    getFips: () => 0,
    setFips: () => {},
    secureHeapUsed: () => ({ total: 0, used: 0, min: 0, utilization: 0 }),
  }
  return c
}

