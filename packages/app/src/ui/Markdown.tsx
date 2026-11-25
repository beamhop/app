import { memo, useEffect, useMemo, useRef } from 'react'
import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import { copyText } from './hooks'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      // ```js title=app.js  or  ```py:script.py
      const info = (lang ?? '').trim()
      let language = info.split(/\s+/)[0] ?? ''
      let file = ''
      const m = info.match(/(?:title|file|filename)=["']?([^"'\s]+)/)
      if (m) file = m[1]
      else if (language.includes(':')) [language, file] = language.split(':')
      const label = [language || 'code', file].filter(Boolean).join(' · ')
      return `<div class="code"><div class="code-head"><span>${esc(label)}</span><button class="btn small ghost" data-copy="1">Copy</button></div><pre><code>${esc(text)}</code></pre></div>`
    },
    link({ href, text }) {
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`
    },
  },
})

export interface MentionName {
  name: string
  agent: boolean
}

function highlightMentions(root: HTMLElement, names: MentionName[]) {
  if (!names.length) return
  const sorted = [...names].sort((a, b) => b.name.length - a.name.length)
  const re = new RegExp(`@(${sorted.map((n) => n.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`, 'gi')
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) {
    const n = walker.currentNode as Text
    if (n.parentElement?.closest('pre,code,a')) continue
    if (re.test(n.data)) nodes.push(n)
    re.lastIndex = 0
  }
  for (const n of nodes) {
    const frag = document.createDocumentFragment()
    let last = 0
    n.data.replace(re, (m, name, idx) => {
      frag.appendChild(document.createTextNode(n.data.slice(last, idx)))
      const span = document.createElement('span')
      const isAgent = sorted.find((x) => x.name.toLowerCase() === String(name).toLowerCase())?.agent
      span.className = 'mention' + (isAgent ? ' agent' : '')
      span.textContent = m
      frag.appendChild(span)
      last = idx + m.length
      return m
    })
    frag.appendChild(document.createTextNode(n.data.slice(last)))
    n.replaceWith(frag)
  }
}

export const Markdown = memo(function Markdown({ text, names = [] }: { text: string; names?: MentionName[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string, { ADD_ATTR: ['target', 'data-copy'] }), [text])
  const namesKey = names.map((n) => n.name).join('|')
  useEffect(() => {
    if (ref.current) highlightMentions(ref.current, names)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, namesKey])
  return (
    <div
      ref={ref}
      className="md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const b = (e.target as HTMLElement).closest('[data-copy]')
        if (b) {
          const code = b.closest('.code')?.querySelector('code')?.textContent ?? ''
          copyText(code)
        }
      }}
    />
  )
})
