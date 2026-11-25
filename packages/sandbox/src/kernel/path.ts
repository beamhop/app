// POSIX path helpers for the kernel. Paths inside the machine are always absolute and '/'-separated.

/** Collapse '.', '..' and repeated slashes. The result is absolute and has no trailing slash (except '/'). */
export function normalize(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

/** Resolve `path` against `cwd` (which must be absolute). */
export function resolve(cwd: string, path: string): string {
  return normalize(path.startsWith('/') ? path : cwd + '/' + path)
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function join(dir: string, name: string): string {
  return dir === '/' ? '/' + name : dir + '/' + name
}
