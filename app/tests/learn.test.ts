import { describe, expect, it } from 'vitest'
import { proposeReplacements } from '../src/main/learn'

describe('proposeReplacements', () => {
  it('proposes a single substitution, trimming common prefix/suffix', () => {
    expect(proposeReplacements('deploy to zeal vps now', 'deploy to ZEAL VPS now')).toEqual(['zeal vps=>ZEAL VPS'])
  })
  it('handles a single-word fix', () => {
    expect(proposeReplacements('email owen at flux', 'email owen at Fluxboard')).toEqual(['flux=>Fluxboard'])
  })
  it('returns [] when identical', () => {
    expect(proposeReplacements('same text here', 'same text here')).toEqual([])
  })
  it('returns [] when corrected is empty', () => {
    expect(proposeReplacements('some words', '')).toEqual([])
  })
  it('returns [] for a whole-sentence rewrite (too divergent)', () => {
    expect(proposeReplacements('a b c d', 'totally different words entirely now')).toEqual([])
  })
})
