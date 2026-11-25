// just-bash's browser bundle imports node:zlib for gzip/gunzip/zcat. The worker build points that import here.
import { gunzipSync as gunzip, gzipSync as gzip } from 'fflate'

export const constants = { Z_BEST_COMPRESSION: 9, Z_BEST_SPEED: 1, Z_DEFAULT_COMPRESSION: -1 }
export const gunzipSync = (data: Uint8Array): Uint8Array => gunzip(data)
export const gzipSync = (data: Uint8Array, options?: { level?: number }): Uint8Array =>
  gzip(data, options?.level && options.level > 0 ? { level: options.level as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 } : undefined)
