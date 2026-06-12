import { describe, expect, it } from 'vitest'
import { applyReplacements, parseDictionary } from '../src/main/dictionary'

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
