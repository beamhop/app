// just-bash's browser bundle imports node:zlib for gzip/gunzip/zcat; back it with fflate.
import { gunzipSync as gun, gzipSync as gz } from 'fflate';
export const constants = { Z_BEST_COMPRESSION: 9, Z_BEST_SPEED: 1, Z_DEFAULT_COMPRESSION: -1 };
export const gunzipSync = (b) => gun(b);
export const gzipSync = (b, o) => gz(b, o && o.level > 0 ? { level: o.level } : undefined);
