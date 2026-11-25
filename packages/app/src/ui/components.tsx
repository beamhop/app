import { useEffect, useRef, useState, type ReactNode } from 'react'
import QRCode from 'qrcode'
import { Icon } from './icons'
import { copyText, useStore } from './hooks'

const PALETTE = ['#5b6cff', '#ff6b5b', '#16a37f', '#e0a100', '#b05bff', '#0ea5e9', '#ef4489', '#64748b', '#f97316']
export const colorFor = (pk: string) => PALETTE[parseInt(pk.slice(0, 6), 16) % PALETTE.length]

export function Avatar({ pk, name, emoji, size = '', online, agent, color }: { pk: string; name: string; emoji?: string; size?: '' | 'sm' | 'xs'; online?: boolean; agent?: boolean; color?: string }) {
  const bg = color ?? (agent ? 'var(--agent)' : colorFor(pk))
  const initials = (name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
  return (
    <div className={`avatar ${size} ${emoji ? 'emoji' : ''} ${agent ? '' : 'round'}`} style={{ background: emoji && agent ? 'var(--agent-soft)' : bg }} title={name}>
      {emoji ?? initials}
      {online !== undefined && <span className={`dot ${online ? 'on' : ''}`} />}
    </div>
  )
}

export function RoomAvatar({ emoji, color, size = '' }: { emoji: string; color: string; size?: '' | 'sm' }) {
  return (
    <div className={`avatar emoji ${size}`} style={{ background: `color-mix(in srgb, ${color} 22%, var(--panel))` }}>
      {emoji}
    </div>
  )
}

export function Sheet({ onClose, children, className = '' }: { onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const start = useRef<{ y: number; t: number } | null>(null)
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  }, [onClose])
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={ref}
        className={`sheet ${className}`}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => {
          if ((ref.current?.scrollTop ?? 0) <= 0) start.current = { y: e.touches[0].clientY, t: Date.now() }
        }}
        onTouchMove={(e) => {
          if (!start.current || !ref.current) return
          const dy = e.touches[0].clientY - start.current.y
          if (dy > 0) ref.current.style.transform = `translateY(${dy}px)`
        }}
        onTouchEnd={(e) => {
          if (!start.current || !ref.current) return
          const dy = e.changedTouches[0].clientY - start.current.y
          ref.current.style.transform = ''
          if (dy > 110 || (dy > 50 && Date.now() - start.current.t < 250)) onClose()
          start.current = null
        }}
      >
        <div className="grab" />
        {children}
      </div>
    </div>
  )
}

export function CopyBox({ value, onCopy }: { value: string; onCopy?: () => void }) {
  return (
    <div className="copy-box">
      <input className="input" readOnly value={value} onFocus={(e) => e.target.select()} />
      <button
        className="btn primary"
        onClick={() => {
          copyText(value)
          onCopy?.()
        }}
      >
        <Icon name="copy" size={18} /> Copy
      </button>
    </div>
  )
}

export function QR({ value }: { value: string }) {
  const [src, setSrc] = useState('')
  useEffect(() => {
    QRCode.toDataURL(value, { margin: 1, width: 400, errorCorrectionLevel: 'M' }).then(setSrc)
  }, [value])
  return <div className="qr">{src && <img src={src} alt="QR code" />}</div>
}

export function Toasts() {
  const s = useStore()
  return (
    <div className="toasts">
      {s.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind ?? ''}`}>
          <span>{t.text}</span>
          {t.action && <a href={t.action.href}>{t.action.label}</a>}
        </div>
      ))}
    </div>
  )
}

export function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  )
}

export function Radio({ on, title, desc, onClick, extra }: { on: boolean; title: string; desc?: string; onClick: () => void; extra?: ReactNode }) {
  return (
    <label className={`radio-card ${on ? 'on' : ''}`} onClick={onClick}>
      <input type="radio" checked={on} readOnly />
      <div>
        <div className="t">
          {title} {extra}
        </div>
        {desc && <div className="d">{desc}</div>}
      </div>
    </label>
  )
}

export function TopBar({ title, onBack, children, sub }: { title?: ReactNode; onBack?: () => void; children?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="topbar">
      {onBack && (
        <button className="icon-btn" onClick={onBack} aria-label="Back">
          <Icon name="back" />
        </button>
      )}
      <div className="grow">
        {typeof title === 'string' ? <h1>{title}</h1> : title}
        {sub && <div className="sub">{sub}</div>}
      </div>
      {children}
    </div>
  )
}

export const timeAgo = (ms: number, now = Date.now()) => {
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`
  return new Date(ms).toLocaleDateString()
}
export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
