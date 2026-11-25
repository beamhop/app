import { describe, expect, it } from 'vitest'
import { isMixedContent } from '../src/agents/localServer'

describe('local model servers', () => {
  it('flags plain http:// addresses on the network from an https page', () => {
    expect(isMixedContent('http://192.168.1.20:11434/v1/models', 'https:')).toBe(true)
    expect(isMixedContent('http://desktop.local:11434', 'https:')).toBe(true)
  })

  it('allows localhost, https servers, and any address from an http page', () => {
    expect(isMixedContent('http://localhost:11434', 'https:')).toBe(false)
    expect(isMixedContent('http://127.0.0.1:11434', 'https:')).toBe(false)
    expect(isMixedContent('http://[::1]:11434', 'https:')).toBe(false)
    expect(isMixedContent('https://ollama.example.ts.net', 'https:')).toBe(false)
    expect(isMixedContent('http://192.168.1.20:11434', 'http:')).toBe(false)
    expect(isMixedContent('not a url', 'https:')).toBe(false)
  })
})
