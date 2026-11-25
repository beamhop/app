import { finalizeEvent } from 'nostr-tools/pure'
import { KIND, type FileRef } from './types.js'
import { decryptFile, encryptFile } from './crypto.js'
import { b64Encode, nowSec, utf8ToBytes } from './util.js'

function authHeader(sk: Uint8Array, verb: 'upload' | 'get' | 'delete', sha256: string) {
  const ev = finalizeEvent(
    {
      kind: KIND.BLOSSOM_AUTH,
      created_at: nowSec(),
      tags: [['t', verb], ['x', sha256], ['expiration', String(nowSec() + 600)]],
      content: `${verb} beamhop file`,
    },
    sk,
  )
  return 'Nostr ' + b64Encode(utf8ToBytes(JSON.stringify(ev)))
}

/** Encrypt and upload a file to the first Blossom server that accepts it. */
export async function uploadEncrypted(
  servers: string[],
  sk: Uint8Array,
  file: { name: string; mime: string; data: Uint8Array },
  fetchImpl: typeof fetch = fetch,
): Promise<FileRef> {
  const enc = await encryptFile(file.data)
  const errors: string[] = []
  for (const server of servers) {
    try {
      const res = await fetchImpl(server.replace(/\/$/, '') + '/upload', {
        method: 'PUT',
        headers: {
          Authorization: authHeader(sk, 'upload', enc.sha256),
          'Content-Type': 'application/octet-stream',
          'X-SHA-256': enc.sha256,
        },
        body: enc.ciphertext as BodyInit,
      })
      if (!res.ok) {
        errors.push(`${server}: ${res.status} ${res.headers.get('x-reason') ?? ''}`)
        continue
      }
      const j = await res.json()
      const url: string = j.url || `${server.replace(/\/$/, '')}/${enc.sha256}`
      return { url, sha256: enc.sha256, key: enc.key, iv: enc.iv, mime: file.mime, name: file.name, size: file.data.length }
    } catch (e: any) {
      errors.push(`${server}: ${e?.message ?? e}`)
    }
  }
  throw new Error('Upload failed. ' + errors.join('; '))
}

export async function downloadDecrypted(ref: FileRef, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const res = await fetchImpl(ref.url)
  if (!res.ok) throw new Error(`Download failed: ${res.status}`)
  const ct = new Uint8Array(await res.arrayBuffer())
  return decryptFile(ct, ref.key, ref.iv)
}
