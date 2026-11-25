import { describe, expect, it } from 'vitest'
import { encodeImage, decodeImage } from '../src/image/format.js'
import { type BlockStore, MemoryBlockStore } from '../src/kernel/blockstore.js'
import { KernelError } from '../src/kernel/errors.js'
import { ImageFs } from '../src/kernel/imagefs.js'
import { MemFs } from '../src/kernel/memfs.js'
import { Vfs } from '../src/kernel/vfs.js'
import { bytes, text } from './helpers.js'

const code = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return e instanceof KernelError ? e.code : 'threw ' + String(e)
  }
  return 'ok'
}

describe('Vfs on the in-memory layer', () => {
  it('creates, reads, appends, truncates and removes files', () => {
    const vfs = new Vfs()
    vfs.mkdir('/a/b', { recursive: true })
    vfs.writeFile('/a/b/f.txt', bytes('hello'))
    vfs.writeFile('/a/b/f.txt', bytes(' world'), { flag: 'a' })
    expect(text(vfs.readFile('/a/b/../b/./f.txt'))).toBe('hello world')
    expect(vfs.stat('/a/b/f.txt')).toMatchObject({ kind: 'file', size: 11, mode: 0o644, nlink: 1 })
    vfs.truncate('/a/b/f.txt', 5)
    expect(vfs.readText('/a/b/f.txt')).toBe('hello')
    expect(vfs.readdir('/a')).toEqual([{ name: 'b', kind: 'dir' }])
    vfs.unlink('/a/b/f.txt')
    expect(vfs.exists('/a/b/f.txt')).toBe(false)
    expect(vfs.tryStat('/a/b/f.txt')).toBeNull()
  })

  it('reports errors with POSIX codes, shaped like Node system errors', () => {
    const vfs = new Vfs()
    vfs.writeFile('/file', bytes('x'))
    vfs.mkdir('/dir')
    vfs.writeFile('/dir/child', bytes('y'))
    expect(code(() => vfs.readFile('/nope'))).toBe('ENOENT')
    expect(code(() => vfs.readFile('/nope/deeper'))).toBe('ENOENT')
    expect(code(() => vfs.readFile('/file/under'))).toBe('ENOTDIR')
    expect(code(() => vfs.readFile('/dir'))).toBe('EISDIR')
    expect(code(() => vfs.mkdir('/dir'))).toBe('EEXIST')
    expect(code(() => vfs.writeFile('/file', bytes('z'), { flag: 'wx' }))).toBe('EEXIST')
    expect(code(() => vfs.rmdir('/dir'))).toBe('ENOTEMPTY')
    expect(code(() => vfs.rm('/dir'))).toBe('EISDIR')
    expect(code(() => vfs.unlink('/dir'))).toBe('EISDIR')
    expect(code(() => vfs.rm('/missing', { force: true }))).toBe('ok')
    const e = (() => {
      try {
        vfs.readFile('/nope')
      } catch (err) {
        return err as KernelError
      }
    })()!
    expect({ message: e.message, errno: e.errno, syscall: e.syscall, path: e.path }).toEqual({ message: "ENOENT: no such file or directory, open '/nope'", errno: -2, syscall: 'open', path: '/nope' })
  })

  it('follows symlinks, relative and absolute, and detects loops', () => {
    const vfs = new Vfs()
    vfs.mkdir('/real/sub', { recursive: true })
    vfs.writeFile('/real/sub/f', bytes('data'))
    vfs.symlink('real/sub', '/rel')
    vfs.symlink('/real', '/abs')
    vfs.symlink('loop2', '/loop1')
    vfs.symlink('loop1', '/loop2')
    expect(vfs.readText('/rel/f')).toBe('data')
    expect(vfs.readText('/abs/sub/f')).toBe('data')
    expect(vfs.realpath('/abs/sub/../sub/f')).toBe('/real/sub/f')
    expect(vfs.lstat('/rel').kind).toBe('symlink')
    expect(vfs.stat('/rel').kind).toBe('dir')
    expect(vfs.readlink('/rel')).toBe('real/sub')
    expect(code(() => vfs.readFile('/loop1'))).toBe('ELOOP')
    vfs.unlink('/rel') // removes the link, not the target
    expect(vfs.exists('/real/sub/f')).toBe(true)
  })

  it('renames, hard-links and removes trees', () => {
    const vfs = new Vfs()
    vfs.mkdir('/src/deep', { recursive: true })
    vfs.writeFile('/src/deep/a', bytes('A'))
    vfs.link('/src/deep/a', '/alias')
    expect(vfs.stat('/alias').nlink).toBe(2)
    vfs.rename('/src', '/dst')
    expect(vfs.readText('/dst/deep/a')).toBe('A')
    vfs.writeFile('/alias', bytes('B')) // same inode
    expect(vfs.readText('/dst/deep/a')).toBe('B')
    vfs.copy('/dst', '/copy')
    vfs.rm('/dst', { recursive: true })
    expect(vfs.exists('/dst')).toBe(false)
    expect(vfs.readText('/alias')).toBe('B')
    expect(vfs.readText('/copy/deep/a')).toBe('B')
  })

  it('notifies watchers of writes and removals', () => {
    const vfs = new Vfs()
    const seen: string[] = []
    const stop = vfs.watch((p) => seen.push(p))
    vfs.writeFile('/w', bytes('1'))
    vfs.unlink('/w')
    stop()
    vfs.writeFile('/w', bytes('2'))
    expect(seen).toEqual(['/w', '/w'])
  })
})

describe('storage seam', () => {
  it('keeps file contents in the BlockStore it is given and frees them when the last link and descriptor go', () => {
    const ops: string[] = []
    const inner = new MemoryBlockStore()
    const store: BlockStore = {
      get: (k) => inner.get(k),
      put: (k, d) => (ops.push('put'), inner.put(k, d)),
      delete: (k) => (ops.push('delete'), inner.delete(k)),
      has: (k) => inner.has(k),
      flush: () => {},
    }
    const fs = new MemFs(store)
    const vfs = new Vfs(fs)
    const h = vfs.writeFile('/f', bytes('persist me'))
    expect(inner.byteLength).toBe(10)
    h.fs.pin(h.ino) // an open descriptor
    vfs.unlink('/f')
    expect(text(h.fs.read(h.ino))).toBe('persist me') // still readable through the descriptor
    h.fs.unpin(h.ino)
    expect(inner.byteLength).toBe(0)
    expect(ops).toEqual(['put', 'delete'])
  })
})

describe('mounts', () => {
  const image = async () =>
    decodeImage(
      (
        await encodeImage({
          meta: { name: 't' },
          dirs: ['empty'],
          files: [
            { path: 'pkg/index.js', data: bytes('module.exports = 1'), mode: 0o644 },
            { path: 'pkg/bin/run', data: bytes('#!/usr/bin/env node\n'), mode: 0o755 },
          ],
          links: [{ path: 'link', target: 'pkg/index.js' }],
        })
      ).bytes,
    )

  it('mounts an image read-only inside the writable tree', async () => {
    const vfs = new Vfs()
    vfs.writeFileDeep('/opt/notes.txt', bytes('n'))
    vfs.mount('/opt/img', new ImageFs(await image()))
    expect(vfs.readdir('/opt').sort((a, b) => a.name.localeCompare(b.name))).toEqual([{ name: 'img', kind: 'dir' }, { name: 'notes.txt', kind: 'file' }])
    expect(vfs.readdir('/opt/img').map((e) => `${e.name}:${e.kind}`).sort()).toEqual(['empty:dir', 'link:symlink', 'pkg:dir'])
    expect(vfs.readText('/opt/img/pkg/index.js')).toBe('module.exports = 1')
    expect(vfs.readText('/opt/img/link')).toBe('module.exports = 1')
    expect(vfs.realpath('/opt/img/link')).toBe('/opt/img/pkg/index.js')
    expect(vfs.stat('/opt/img/pkg/bin/run').mode).toBe(0o755)
    expect(vfs.mountPoints()).toEqual(['/opt/img'])
  })

  it('refuses every write under an image mount with EROFS, and cross-mount renames with EXDEV', async () => {
    const vfs = new Vfs()
    vfs.mount('/img', new ImageFs(await image()))
    vfs.writeFile('/outside', bytes('o'))
    expect(code(() => vfs.writeFile('/img/new', bytes('x')))).toBe('EROFS')
    expect(code(() => vfs.writeFile('/img/pkg/index.js', bytes('x')))).toBe('EROFS')
    expect(code(() => vfs.unlink('/img/pkg/index.js'))).toBe('EROFS')
    expect(code(() => vfs.mkdir('/img/d'))).toBe('EROFS')
    expect(code(() => vfs.chmod('/img/pkg/index.js', 0o777))).toBe('EROFS')
    expect(code(() => vfs.rename('/outside', '/img/inside'))).toBe('EXDEV')
    expect(code(() => vfs.rmdir('/img'))).toBe('EBUSY')
    expect(code(() => vfs.mount('/img', new MemFs()))).toBe('EBUSY')
    expect(vfs.readText('/img/pkg/index.js')).toBe('module.exports = 1')
  })

  it('lets symlinks in the writable tree point into a mount, and unmounts', async () => {
    const vfs = new Vfs()
    vfs.mount('/img', new ImageFs(await image()))
    vfs.symlink('/img/pkg/bin/run', '/usr-bin-run')
    expect(vfs.readText('/usr-bin-run')).toBe('#!/usr/bin/env node\n')
    vfs.unmount('/img')
    expect(vfs.readdir('/img')).toEqual([])
    expect(code(() => vfs.readFile('/usr-bin-run'))).toBe('ENOENT')
  })
})
