import { describe, expect, it } from 'vitest'
import { NO_MODS, applyMods, specialKeySeq } from '../src/ui/terminalKeys'

const ctrl = { ...NO_MODS, ctrl: true }
const alt = { ...NO_MODS, alt: true }
const shift = { ...NO_MODS, shift: true }

describe('terminal key bar', () => {
  it('sends arrows as xterm does, in normal and application cursor mode', () => {
    expect(specialKeySeq('up')).toBe('\x1b[A')
    expect(specialKeySeq('left')).toBe('\x1b[D')
    expect(specialKeySeq('up', NO_MODS, true)).toBe('\x1bOA')
  })

  it('adds the modifier parameter to arrows, Home/End and Page keys', () => {
    expect(specialKeySeq('right', shift)).toBe('\x1b[1;2C')
    expect(specialKeySeq('left', ctrl)).toBe('\x1b[1;5D')
    expect(specialKeySeq('up', { ctrl: true, alt: false, shift: true })).toBe('\x1b[1;6A')
    expect(specialKeySeq('home')).toBe('\x1b[H')
    expect(specialKeySeq('end', alt)).toBe('\x1b[1;3F')
    expect(specialKeySeq('pgup')).toBe('\x1b[5~')
    expect(specialKeySeq('pgdn', ctrl)).toBe('\x1b[6;5~')
  })

  it('sends Esc, Tab, Shift-Tab and Return', () => {
    expect(specialKeySeq('esc')).toBe('\x1b')
    expect(specialKeySeq('tab')).toBe('\t')
    expect(specialKeySeq('tab', shift)).toBe('\x1b[Z')
    expect(specialKeySeq('enter')).toBe('\r')
    expect(specialKeySeq('enter', alt)).toBe('\x1b\r')
  })

  it('turns a typed character into its control code with Ctrl', () => {
    expect(applyMods('c', ctrl)).toBe('\x03')
    expect(applyMods('C', ctrl)).toBe('\x03')
    expect(applyMods('d', ctrl)).toBe('\x04')
    expect(applyMods('[', ctrl)).toBe('\x1b')
    expect(applyMods(' ', ctrl)).toBe('\x00')
    expect(applyMods('?', ctrl)).toBe('\x7f')
  })

  it('prefixes Esc for Alt, uppercases for Shift, and leaves pasted text alone', () => {
    expect(applyMods('b', alt)).toBe('\x1bb')
    expect(applyMods('a', shift)).toBe('A')
    expect(applyMods('x', NO_MODS)).toBe('x')
    expect(applyMods('ls -la', ctrl)).toBe('ls -la')
  })
})
