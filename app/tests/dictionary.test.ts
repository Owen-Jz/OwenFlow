import { describe, expect, it } from 'vitest'
import { applyReplacements, buildBiasPrompt, parseDictionary } from '../src/main/dictionary'

describe('parseDictionary', () => {
  it('splits bias words from wrong=>right replacement pairs', () => {
    const { promptWords, replacements } = parseDictionary([
      'ZEAL',
      'Owen Digitals',
      'wisper=>whisper',
      '  her aldo => Herald ',
      '',
      '   '
    ])
    expect(promptWords).toEqual(['ZEAL', 'Owen Digitals'])
    expect(replacements).toEqual([
      { from: 'wisper', to: 'whisper' },
      { from: 'her aldo', to: 'Herald' }
    ])
  })

  it('ignores entries where => has no left side', () => {
    const { promptWords, replacements } = parseDictionary(['=>nothing'])
    expect(replacements).toEqual([])
    expect(promptWords).toEqual(['=>nothing'])
  })
})

describe('buildBiasPrompt', () => {
  it('returns undefined for empty input', () => {
    expect(buildBiasPrompt([])).toBeUndefined()
  })

  it('returns undefined when all entries are blank', () => {
    expect(buildBiasPrompt(['', '   '])).toBeUndefined()
  })

  it('wraps words in a natural punctuated sentence', () => {
    expect(buildBiasPrompt(['Cresio', 'Fluxboard', 'ZEAL'])).toBe(
      'Vocabulary: Cresio, Fluxboard, ZEAL.'
    )
  })

  it('trims whitespace around words', () => {
    expect(buildBiasPrompt(['  ZEAL  ', 'Owen Digitals'])).toBe('Vocabulary: ZEAL, Owen Digitals.')
  })

  it('caps the prompt near 600 chars by dropping overflow words from the end', () => {
    // 100 ten-char words ≈ 1200 chars joined — well past the cap.
    const words = Array.from({ length: 100 }, (_, i) => `word${String(i).padStart(6, '0')}`)
    const prompt = buildBiasPrompt(words)
    expect(prompt).toBeDefined()
    expect(prompt!.length).toBeLessThanOrEqual(600)
    // The FIRST dictionary entries survive; overflow drops from the end.
    expect(prompt!.startsWith('Vocabulary: word000000, word000001')).toBe(true)
    expect(prompt!.endsWith('.')).toBe(true)
    expect(prompt).not.toContain('word000099')
  })

  it('always keeps the first word even if it alone exceeds the cap', () => {
    const huge = 'x'.repeat(700)
    expect(buildBiasPrompt([huge])).toBe(`Vocabulary: ${huge}.`)
  })
})

describe('applyReplacements', () => {
  it('replaces case-insensitively', () => {
    const out = applyReplacements('Wisper flow uses wisper models. WISPER!', [
      { from: 'wisper', to: 'whisper' }
    ])
    expect(out).toBe('whisper flow uses whisper models. whisper!')
  })

  it('only replaces whole words', () => {
    const out = applyReplacements('cat concatenate cat, scatter', [{ from: 'cat', to: 'dog' }])
    expect(out).toBe('dog concatenate dog, scatter')
  })

  it('handles multi-word and regex-special froms', () => {
    const out = applyReplacements('see plus plus and c++ here', [
      { from: 'see plus plus', to: 'C++' },
      { from: 'c++', to: 'C++' }
    ])
    expect(out).toBe('C++ and C++ here')
  })

  it('applies multiple pairs and leaves untouched text alone', () => {
    const out = applyReplacements('zeel runs on the vps', [
      { from: 'zeel', to: 'ZEAL' },
      { from: 'vps', to: 'VPS' }
    ])
    expect(out).toBe('ZEAL runs on the VPS')
  })

  it('returns text unchanged with no replacements', () => {
    expect(applyReplacements('hello world', [])).toBe('hello world')
  })
})
