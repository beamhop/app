// Machine image format (".bhi"). An image is a read-only file tree plus an ESM compile cache, packed so a
// worker can mount it with one allocation: file contents become zero-copy views of the decoded payload.
//
//   offset  size  field
//   0       8     magic, ASCII "BHIMAGE1"
//   8       4     flags, u32 LE. bit 0: the payload is gzip-compressed
//   12      4     index length in bytes, u32 LE (UTF-8 JSON, uncompressed size)
//   16      8     payload length in bytes, u64 LE (uncompressed: index + blob)
//   24      32    SHA-256 of the uncompressed payload
//   56      ...   payload = index JSON ++ blob, gzip-compressed as one stream when flag bit 0 is set
//
// The index (see ImageIndex) lists directories, files, symlinks and compile-cache entries. Offsets are relative
// to the start of the blob. Paths are relative to the image root and never start with '/'; the mount point is
// chosen when the image is mounted. The SHA-256 names the file ("pi-<first 16 hex>.bhi"), so an image URL can
// be cached forever.
//
// This module uses only web platform APIs (CompressionStream, crypto.subtle), so the same code packs images
// under Node and unpacks them in a worker.

export const IMAGE_MAGIC = 'BHIMAGE1'
export const IMAGE_HEADER_BYTES = 56
const FLAG_GZIP = 1

export interface ImageIndex {
  v: 1
  /** Free-form build information: package spec, versions, entry point, build time. */
  meta: Record<string, unknown>
  dirs: string[]
  /** [path, offset, length, mode] */
  files: [string, number, number, number][]
  /** [path, target] */
  links: [string, string][]
  /** Precompiled ES modules, keyed by the path of the source file: [path, offset, length] */
  esm: [string, number, number][]
}

export interface ImageInput {
  meta?: Record<string, unknown>
  dirs?: string[]
  files: { path: string; data: Uint8Array; mode?: number }[]
  links?: { path: string; target: string }[]
  esm?: { path: string; code: Uint8Array }[]
}

export interface DecodedImage {
  index: ImageIndex
  /** File and compile-cache contents; index offsets point into this. */
  blob: Uint8Array
  /** Hex SHA-256 from the header (verified only when asked). */
  hash: string
  /** Size of the uncompressed payload. */
  payloadBytes: number
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource))
}

async function collect(stream: ReadableStream<Uint8Array>, sizeHint?: number): Promise<Uint8Array> {
  const reader = stream.getReader()
  let out = new Uint8Array(sizeHint ?? 65536)
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (length + value.byteLength > out.byteLength) {
      const grown = new Uint8Array(Math.max(out.byteLength * 2, length + value.byteLength))
      grown.set(out.subarray(0, length))
      out = grown
    }
    out.set(value, length)
    length += value.byteLength
  }
  return length === out.byteLength ? out : out.subarray(0, length)
}

const relative = (path: string): string => path.replace(/^\/+/, '')

/** Pack a file tree. Returns the image bytes and the content hash that should name the file. */
export async function encodeImage(input: ImageInput, opts: { compress?: boolean } = {}): Promise<{ bytes: Uint8Array; hash: string }> {
  const index: ImageIndex = { v: 1, meta: input.meta ?? {}, dirs: (input.dirs ?? []).map(relative), files: [], links: [], esm: [] }
  let offset = 0
  for (const f of input.files) {
    index.files.push([relative(f.path), offset, f.data.byteLength, f.mode ?? 0o644])
    offset += f.data.byteLength
  }
  for (const l of input.links ?? []) index.links.push([relative(l.path), l.target])
  for (const e of input.esm ?? []) {
    index.esm.push([relative(e.path), offset, e.code.byteLength])
    offset += e.code.byteLength
  }
  const indexBytes = new TextEncoder().encode(JSON.stringify(index))
  const payload = new Uint8Array(indexBytes.byteLength + offset)
  payload.set(indexBytes, 0)
  let at = indexBytes.byteLength
  for (const f of input.files) {
    payload.set(f.data, at)
    at += f.data.byteLength
  }
  for (const e of input.esm ?? []) {
    payload.set(e.code, at)
    at += e.code.byteLength
  }
  const digest = await sha256(payload)
  const compress = opts.compress !== false
  const body = compress ? await collect(new Blob([payload as BlobPart]).stream().pipeThrough(new CompressionStream('gzip')), payload.byteLength >> 2) : payload
  const bytes = new Uint8Array(IMAGE_HEADER_BYTES + body.byteLength)
  const view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode(IMAGE_MAGIC), 0)
  view.setUint32(8, compress ? FLAG_GZIP : 0, true)
  view.setUint32(12, indexBytes.byteLength, true)
  view.setBigUint64(16, BigInt(payload.byteLength), true)
  bytes.set(digest, 24)
  bytes.set(body, IMAGE_HEADER_BYTES)
  return { bytes, hash: hex(digest) }
}

export class ImageFormatError extends Error {
  constructor(message: string) {
    super('invalid machine image: ' + message)
    this.name = 'ImageFormatError'
  }
}

/** Unpack an image from bytes or from a byte stream (a fetch body). Peak memory is one payload-sized buffer. */
export async function decodeImage(source: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>, opts: { verify?: boolean } = {}): Promise<DecodedImage> {
  const stream = source instanceof ReadableStream ? source : new Blob([source as BlobPart]).stream()
  const reader = stream.getReader()
  // Read the fixed header, keeping whatever came after it in the same chunk.
  const header = new Uint8Array(IMAGE_HEADER_BYTES)
  let have = 0
  let rest: Uint8Array | null = null
  while (have < IMAGE_HEADER_BYTES) {
    const { done, value } = await reader.read()
    if (done) throw new ImageFormatError('truncated header')
    const take = Math.min(value.byteLength, IMAGE_HEADER_BYTES - have)
    header.set(value.subarray(0, take), have)
    have += take
    if (take < value.byteLength) rest = value.subarray(take)
  }
  if (new TextDecoder().decode(header.subarray(0, 8)) !== IMAGE_MAGIC) throw new ImageFormatError('bad magic')
  const view = new DataView(header.buffer)
  const flags = view.getUint32(8, true)
  const indexBytes = view.getUint32(12, true)
  const payloadBytes = Number(view.getBigUint64(16, true))
  const hash = hex(header.subarray(24, 56))
  if (indexBytes > payloadBytes) throw new ImageFormatError('index larger than payload')

  const first = rest
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first) controller.enqueue(first)
    },
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  const plain = flags & FLAG_GZIP ? body.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>) : body
  const payload = new Uint8Array(payloadBytes)
  const out = plain.getReader()
  let length = 0
  for (;;) {
    const { done, value } = await out.read()
    if (done) break
    if (length + value.byteLength > payloadBytes) throw new ImageFormatError('payload longer than declared')
    payload.set(value, length)
    length += value.byteLength
  }
  if (length !== payloadBytes) throw new ImageFormatError(`payload is ${length} bytes, header says ${payloadBytes}`)
  if (opts.verify && hex(await sha256(payload)) !== hash) throw new ImageFormatError('content hash mismatch')

  let index: ImageIndex
  try {
    index = JSON.parse(new TextDecoder().decode(payload.subarray(0, indexBytes))) as ImageIndex
  } catch {
    throw new ImageFormatError('index is not JSON')
  }
  if (index.v !== 1) throw new ImageFormatError('unsupported index version ' + String(index.v))
  return { index, blob: payload.subarray(indexBytes), hash, payloadBytes }
}

/** The cache-friendly file name for an image: content-addressed, so it never needs revalidation. */
export function imageFileName(name: string, hash: string): string {
  return `${name}-${hash.slice(0, 16)}.bhi`
}
