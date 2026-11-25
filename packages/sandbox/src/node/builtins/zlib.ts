// node:zlib on fflate: gzip, deflate, raw deflate. No brotli and no zstd.
import * as fflate from 'fflate'
import type { Dyn, Track } from '../types.js'
import { BufferPkg as Buffer } from '../vendor.js'
import { notImplemented } from './core.js'

export function makeZlib({ Buffer, stream, track }: Dyn) {
  const u8 = (d?: Dyn) =>
    typeof d === 'string'
      ? new Uint8Array(Buffer.from(d))
      : d instanceof ArrayBuffer
        ? new Uint8Array(d)
        : new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
  const syncFns: Record<string, (data: Uint8Array) => Uint8Array> = {
    gzipSync: fflate.gzipSync,
    gunzipSync: fflate.gunzipSync,
    deflateSync: fflate.zlibSync,
    inflateSync: fflate.unzlibSync,
    deflateRawSync: fflate.deflateSync,
    inflateRawSync: fflate.inflateSync,
    unzipSync: fflate.decompressSync,
  }
  const z: Dyn = {
    constants: {
      Z_NO_FLUSH: 0,
      Z_PARTIAL_FLUSH: 1,
      Z_SYNC_FLUSH: 2,
      Z_FULL_FLUSH: 3,
      Z_FINISH: 4,
      Z_BLOCK: 5,
      Z_OK: 0,
      Z_STREAM_END: 1,
      Z_NEED_DICT: 2,
      Z_ERRNO: -1,
      Z_STREAM_ERROR: -2,
      Z_DATA_ERROR: -3,
      Z_MEM_ERROR: -4,
      Z_BUF_ERROR: -5,
      Z_VERSION_ERROR: -6,
      Z_NO_COMPRESSION: 0,
      Z_BEST_SPEED: 1,
      Z_BEST_COMPRESSION: 9,
      Z_DEFAULT_COMPRESSION: -1,
      Z_DEFAULT_STRATEGY: 0,
      Z_DEFAULT_WINDOWBITS: 15,
      Z_MIN_WINDOWBITS: 8,
      Z_MAX_WINDOWBITS: 15,
      Z_DEFAULT_CHUNK: 16384,
      BROTLI_OPERATION_PROCESS: 0,
      BROTLI_OPERATION_FLUSH: 1,
      BROTLI_OPERATION_FINISH: 2,
      BROTLI_PARAM_MODE: 0,
      BROTLI_MODE_GENERIC: 0,
      BROTLI_MODE_TEXT: 1,
      BROTLI_PARAM_QUALITY: 1,
      BROTLI_MIN_QUALITY: 0,
      BROTLI_MAX_QUALITY: 11,
      BROTLI_DEFAULT_QUALITY: 11,
      BROTLI_PARAM_LGWIN: 2,
      BROTLI_PARAM_SIZE_HINT: 5,
      BROTLI_DECODE: 8,
      BROTLI_ENCODE: 9,
      ZSTD_e_continue: 0,
      ZSTD_e_flush: 1,
      ZSTD_e_end: 2,
      ZSTD_c_compressionLevel: 100,
    },
  }
  Object.assign(z, z.constants)
  for (const [name, fn] of Object.entries(syncFns)) {
    z[name] = (d?: Dyn) => Buffer.from(fn(u8(d)))
    z[name.replace(/Sync$/, '')] = (d?: Dyn, o?: Dyn, cb?: Dyn) => {
      cb = typeof o === 'function' ? o : cb
      let r: Dyn,
        e = null
      try {
        r = z[name](d)
      } catch (x: Dyn) {
        e = x
      }
      queueMicrotask(() => cb(e, r))
    }
  }
  const streamCls = (Cls?: Dyn, label?: Dyn) =>
    function create() {
      let impl, tr
      tr = new stream.Transform({
        transform(chunk?: Dyn, enc?: Dyn, cb?: Dyn) {
          try {
            impl.push(u8(chunk), false)
            cb()
          } catch (e: Dyn) {
            cb(e)
          }
        },
        flush(cb?: Dyn) {
          try {
            impl.push(new Uint8Array(0), true)
            cb()
          } catch (e: Dyn) {
            cb(e)
          }
        },
      })
      impl = new Cls((data?: Dyn) => {
        if (data.length) tr.push(Buffer.from(data))
      })
      tr.close = (cb?: Dyn) => {
        tr.destroy()
        cb && cb()
      }
      tr.flush = (k?: Dyn, cb?: Dyn) => {
        const f = typeof k === 'function' ? k : cb
        f && queueMicrotask(f)
      }
      tr.bytesWritten = 0
      return tr
    }
  z.createGzip = streamCls(fflate.Gzip)
  z.createGunzip = streamCls(fflate.Gunzip)
  z.createDeflate = streamCls(fflate.Zlib)
  z.createInflate = streamCls(fflate.Unzlib)
  z.createDeflateRaw = streamCls(fflate.Deflate)
  z.createInflateRaw = streamCls(fflate.Inflate)
  z.createUnzip = streamCls(fflate.Decompress)
  for (const n of [
    'brotliCompressSync',
    'brotliDecompressSync',
    'brotliCompress',
    'brotliDecompress',
    'createBrotliCompress',
    'createBrotliDecompress',
    'zstdCompressSync',
    'zstdDecompressSync',
    'createZstdCompress',
    'createZstdDecompress',
  ])
    z[n] = notImplemented(track, 'zlib.' + n)
  z.crc32 = (data?: Dyn, value: Dyn = 0) => {
    let c = ~value >>> 0
    for (const b of u8(data)) {
      c ^= b
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return ~c >>> 0
  }
  return z
}

