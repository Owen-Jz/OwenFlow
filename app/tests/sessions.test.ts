import { describe, expect, it } from 'vitest'
import { parseSessionTones, activeSessionMode } from '../src/main/sessions'

describe('parseSessionTones', () => {
  it('parses label => mode and drops invalid modes', () => {
    expect(parseSessionTones(['client => formal', 'notes=>normal', 'bad=>nope', 'x=>vibe'])).toEqual([
      { label: 'client', mode: 'formal' },
      { label: 'notes', mode: 'normal' },
      { label: 'x', mode: 'vibe' }
    ])
  })
})

describe('activeSessionMode', () => {
  const tones = parseSessionTones(['client => formal', 'notes => normal'])
  it('looks up case-insensitively', () => {
    expect(activeSessionMode('Client', tones)).toBe('formal')
  })
  it('returns null for none/unmapped', () => {
    expect(activeSessionMode('', tones)).toBeNull()
    expect(activeSessionMode('unknown', tones)).toBeNull()
  })
})
