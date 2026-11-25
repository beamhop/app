import { describe, expect, it } from 'vitest'
import { decodeImage, encodeImage, IMAGE_HEADER_BYTES, imageFileName, type ImageInput } from '../src/image/format.js'
import { bytes, run, testMachine, text } from './helpers.js'

const input: ImageInput = {
  meta: { name: 'demo', bin: { demo: 'node_modules/demo/cli.js' } },
  dirs: ['node_modules/demo/empty'],
  files: [
    { path: 'node_modules/demo/package.json', data: bytes('{"name":"demo","type":"module"}') },
    { path: 'node_modules/demo/cli.js', data: bytes('#!/usr/bin/env node\nimport { n } from "./lib.js"\nconsole.log("source", n)\n'), mode: 0o755 },
    { path: 'node_modules/demo/lib.js', data: bytes('export const n = 1\n') },
    { path: 'node_modules/demo/blob.bin', data: new Uint8Array(70_000).map((_, i) => i % 251) },
  ],
  links: [{ path: 'node_modules/.bin/demo', target: '../demo/cli.js' }],
}

describe('image format', () => {
  it('round-trips files, modes, links and the compile cache, compressed and uncompressed', async () => {
    const withEsm = { ...input, esm: [{ path: 'node_modules/demo/lib.js', code: bytes('System.register([], function(){ return { execute(){} } })') }] }
    for (const compress of [true, false]) {
      const { bytes: packed, hash } = await encodeImage(withEsm, { compress })
      const image = await decodeImage(packed, { verify: true })
      expect(image.hash).toBe(hash)
      expect(hash).toMatch(/^[0-9a-f]{64}$/)
      expect(image.index.meta).toEqual(input.meta)
      expect(image.index.dirs).toEqual(['node_modules/demo/empty'])
      expect(image.index.links).toEqual([['node_modules/.bin/demo', '../demo/cli.js']])
      const byPath = Object.fromEntries(image.index.files.map(([p, off, len, mode]) => [p, { data: image.blob.subarray(off, off + len), mode }]))
      expect(byPath['node_modules/demo/cli.js'].mode).toBe(0o755)
      expect(text(byPath['node_modules/demo/lib.js'].data)).toBe('export const n = 1\n')
      expect(byPath['node_modules/demo/blob.bin'].data).toEqual(input.files[3].data)
      const [esmPath, off, len] = image.index.esm[0]
      expect(esmPath).toBe('node_modules/demo/lib.js')
      expect(text(image.blob.subarray(off, off + len))).toContain('System.register')
      // contents are views of one payload buffer, not copies
      expect(byPath['node_modules/demo/lib.js'].data.buffer).toBe(image.blob.buffer)
    }
  })

  it('names images by content: same input, same hash; compression does not change it', async () => {
    const a = await encodeImage(input)
    const b = await encodeImage(input, { compress: false })
    const c = await encodeImage({ ...input, files: [...input.files, { path: 'extra', data: bytes('x') }] })
    expect(a.hash).toBe(b.hash)
    expect(a.hash).not.toBe(c.hash)
    expect(a.bytes.byteLength).toBeLessThan(b.bytes.byteLength)
    expect(imageFileName('demo', a.hash)).toBe(`demo-${a.hash.slice(0, 16)}.bhi`)
  })

  it('decodes from a stream delivered in small pieces', async () => {
    const { bytes: packed } = await encodeImage(input)
    let at = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (at >= packed.length) return c.close()
        c.enqueue(packed.slice(at, (at += 37)))
      },
    })
    const image = await decodeImage(stream, { verify: true })
    expect(image.index.files.length).toBe(4)
  })

  it('rejects damaged images', async () => {
    const { bytes: packed } = await encodeImage(input, { compress: false })
    const badMagic = packed.slice()
    badMagic[0] = 0x58
    await expect(decodeImage(badMagic)).rejects.toThrow('bad magic')
    await expect(decodeImage(packed.slice(0, 20))).rejects.toThrow('truncated header')
    await expect(decodeImage(packed.slice(0, packed.length - 10))).rejects.toThrow(/payload is \d+ bytes/)
    const flipped = packed.slice()
    flipped[flipped.length - 1] ^= 0xff
    await expect(decodeImage(flipped, { verify: true })).rejects.toThrow('content hash mismatch')
    expect(IMAGE_HEADER_BYTES).toBe(56)
  })
})

describe('mounting an image in a machine', () => {
  it('links the package bin onto PATH and runs it through its shebang', async () => {
    const m = testMachine()
    const result = m.mountImage('/opt/demo', await decodeImage((await encodeImage(input)).bytes))
    expect(result.files).toBe(4)
    expect(m.kernel.vfs.readlink('/usr/bin/demo')).toBe('/opt/demo/node_modules/demo/cli.js')
    expect(await run(m, ['demo'])).toMatchObject({ code: 0, stdout: 'source 1\n' })
    // and from a shell script
    expect((await run(m, ['bash', '-c', 'demo | tr a-z A-Z'])).stdout).toBe('SOURCE 1\n')
  })

  it('uses the precompiled form of a module when the image has one', async () => {
    const m = testMachine()
    // A compile-cache entry that deliberately differs from the source, to show which one ran.
    const precompiled = 'System.register([], function ($__export) { return { setters: [], execute: function () { $__export("n", 2) } } })'
    m.mountImage('/opt/demo', await decodeImage((await encodeImage({ ...input, esm: [{ path: 'node_modules/demo/lib.js', code: bytes(precompiled) }] })).bytes))
    expect((await run(m, ['demo'])).stdout).toBe('source 2\n')
  })
})
