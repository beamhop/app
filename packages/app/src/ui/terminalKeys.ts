// Keys a phone keyboard doesn't have, for the machine's terminal: what each sends to the pty, and
// how the sticky Ctrl / Alt / Shift modifiers change what the user types next.

export interface Mods {
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export const NO_MODS: Mods = { ctrl: false, alt: false, shift: false }

export type SpecialKey = 'esc' | 'tab' | 'enter' | 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pgup' | 'pgdn'

const CURSOR: Partial<Record<SpecialKey, string>> = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' }
const TILDE: Partial<Record<SpecialKey, string>> = { pgup: '5', pgdn: '6' }

/** xterm's modifier parameter: 1 + Shift(1) + Alt(2) + Ctrl(4). */
const modParam = (m: Mods) => 1 + (m.shift ? 1 : 0) + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0)

/**
 * The bytes a special key sends, as xterm would send them. `appCursor`: the program switched the
 * terminal to application cursor keys (vim, less, readline in some modes), which sends ESC O A
 * instead of ESC [ A for an unmodified arrow.
 */
export function specialKeySeq(key: SpecialKey, m: Mods = NO_MODS, appCursor = false): string {
  const p = modParam(m)
  const c = CURSOR[key]
  if (c) return p > 1 ? `\x1b[1;${p}${c}` : `${appCursor ? '\x1bO' : '\x1b['}${c}`
  const t = TILDE[key]
  if (t) return p > 1 ? `\x1b[${t};${p}~` : `\x1b[${t}~`
  if (key === 'tab') return m.shift ? '\x1b[Z' : (m.alt ? '\x1b' : '') + '\t'
  if (key === 'enter') return (m.alt ? '\x1b' : '') + '\r'
  return '\x1b' // esc
}

/** Applies sticky modifiers to text the user typed on the device keyboard. */
export function applyMods(data: string, m: Mods): string {
  if (!m.ctrl && !m.alt && !m.shift) return data
  // Only a single typed character takes modifiers; pasted text passes through.
  if ([...data].length !== 1) return data
  let ch = m.shift ? data.toUpperCase() : data
  if (m.ctrl) {
    const u = ch.toUpperCase()
    const code = u.charCodeAt(0)
    if (code >= 64 && code <= 95) ch = String.fromCharCode(code - 64) // @ A-Z [ \ ] ^ _
    else if (ch === ' ' || ch === '2') ch = '\x00'
    else if (ch === '?' || ch === '8') ch = '\x7f'
    else if (ch >= '3' && ch <= '7') ch = String.fromCharCode(27 + ch.charCodeAt(0) - 51) // 3..7 → ESC, FS, GS, RS, US
  }
  return (m.alt ? '\x1b' : '') + ch
}
