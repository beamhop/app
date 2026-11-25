import { useEffect, useState, useSyncExternalStore } from 'react'
import { store } from '../core/store'

export function useStore() {
  useSyncExternalStore(store.subscribe, store.getVersion)
  return store
}

export function useMedia(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const f = () => setM(mq.matches)
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [q])
  return m
}
export const useDesktop = () => useMedia('(min-width: 900px)')

export function useHash() {
  const [h, setH] = useState(location.hash)
  useEffect(() => {
    const f = () => setH(location.hash)
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])
  return h
}

export function parseRoute(hash: string) {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  return { name: parts[0] ?? '', args: parts.slice(1) }
}

export const go = (path: string, replace = false) => {
  const h = '#/' + path.replace(/^\/+/, '')
  if (replace) history.replaceState(null, '', h)
  else location.hash = h
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'))
}

export function useNow(ms = 30000) {
  const [n, setN] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setN(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return n
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  store.toast('Copied')
}
