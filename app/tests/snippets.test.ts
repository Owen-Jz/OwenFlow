import { describe, expect, it } from 'vitest'
import { parseSnippets, matchSnippet } from '../src/main/snippets'

describe('parseSnippets', () => {
  it('parses trigger => expansion and converts \\n', () => {
    expect(parseSnippets(['sign off=>Best,\\nOwen'])).toEqual([
      { trigger: 'sign off', expansion: 'Best,\nOwen' }
    ])
  })
  it('skips blank and malformed lines', () => {
    expect(parseSnippets(['', '   ', 'noarrow', '=>x', 'a=>b'])).toEqual([
      { trigger: 'a', expansion: 'b' }
    ])
  })
})

describe('matchSnippet', () => {
  const snips = parseSnippets(['my address=>10 Main St', 'sign off=>Best,\\nOwen'])
  it('matches whole utterance case-insensitively', () => {
    expect(matchSnippet('My Address', snips)).toBe('10 Main St')
  })
  it('tolerates trailing sentence punctuation/whitespace', () => {
    expect(matchSnippet('  sign off.  ', snips)).toBe('Best,\nOwen')
  })
  it('returns null when no whole-utterance match (substring is not enough)', () => {
    expect(matchSnippet('please sign off now', snips)).toBeNull()
    expect(matchSnippet('', snips)).toBeNull()
  })
})
