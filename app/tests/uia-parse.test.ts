import { describe, expect, it } from 'vitest'
import { compactContext, extractIdentifiers, siteFromUrl } from '../src/main/uia-parse'

describe('extractIdentifiers', () => {
  it('pulls camelCase, snake_case, PascalCase, dotted, ALLCAPS', () => {
    const out = extractIdentifiers('const userId = fetchUser(user_id, MAX_RETRIES); api.postMessage()')
    expect(out).toContain('userId')
    expect(out).toContain('fetchUser')
    expect(out).toContain('user_id')
    expect(out).toContain('MAX_RETRIES')
    expect(out).toContain('api.postMessage')
  })
  it('drops plain words, short tokens, and dupes (first-seen order kept)', () => {
    const out = extractIdentifiers('the userId and the userId and go')
    expect(out).toEqual(['userId'])
    expect(out).not.toContain('the')
    expect(out).not.toContain('go')
  })
  it('caps the count', () => {
    const many = Array.from({ length: 100 }, (_, i) => `symUnique${i}`).join(' ')
    expect(extractIdentifiers(many, 10).length).toBe(10)
  })
  it('returns [] for empty/plain prose', () => {
    expect(extractIdentifiers('')).toEqual([])
    expect(extractIdentifiers('just some normal english words here')).toEqual([])
  })
})

describe('siteFromUrl', () => {
  it('reduces a URL to its host, stripping scheme/path/www', () => {
    expect(siteFromUrl('https://www.github.com/Owen-Jz/repo/pull/3')).toBe('github.com')
    expect(siteFromUrl('https://mail.google.com/mail/u/0/#inbox')).toBe('mail.google.com')
    expect(siteFromUrl('github.com/x/y')).toBe('github.com')
  })
  it('returns null for empty/garbage', () => {
    expect(siteFromUrl('')).toBeNull()
    expect(siteFromUrl('   ')).toBeNull()
    expect(siteFromUrl('not a url at all !!!')).toBeNull()
  })
})

describe('compactContext', () => {
  it('keeps the tail (caret end) and collapses whitespace', () => {
    const out = compactContext('  Hello   there\n\n world  ', 100)
    expect(out).toBe('Hello there world')
  })
  it('caps to the last N chars without a leading partial word', () => {
    const out = compactContext('alpha beta gamma delta', 12)
    // last 12 chars = "gamma delta" after dropping the partial leading word
    expect(out).toBe('gamma delta')
    expect(out.length).toBeLessThanOrEqual(12)
  })
  it('returns "" for empty', () => {
    expect(compactContext('   ')).toBe('')
  })
})
