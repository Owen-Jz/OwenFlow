import { describe, expect, it } from 'vitest'
import { matchProfile, applyProfileTransforms, profilePromptRule, DEFAULT_PROFILES } from '../src/main/profiles'

describe('matchProfile', () => {
  it('matches a process name case-insensitively', () => {
    expect(matchProfile('code', [{ match: ['Code', 'Cursor'] }])).not.toBeNull()
  })
  it('returns null for no match or null app', () => {
    expect(matchProfile('chrome', [{ match: ['Code'] }])).toBeNull()
    expect(matchProfile(null, [{ match: ['Code'] }])).toBeNull()
  })
  it('does not throw on malformed profile entries (hand-edited config)', () => {
    // @ts-expect-error intentionally corrupt entries
    expect(matchProfile('code', [{ match: null }, { foo: 1 }, { match: ['Code'] }])).not.toBeNull()
    // @ts-expect-error intentionally corrupt profiles arg
    expect(matchProfile('code', null)).toBeNull()
  })
})

describe('applyProfileTransforms', () => {
  it('strips trailing period', () => {
    expect(applyProfileTransforms('hello world.', { match: [], stripTrailingPeriod: true })).toBe('hello world')
  })
  it('lowercases first letter when noAutoCapitalize', () => {
    expect(applyProfileTransforms('Hello', { match: [], noAutoCapitalize: true })).toBe('hello')
  })
  it('collapses newlines when singleLine', () => {
    expect(applyProfileTransforms('a\nb\n c', { match: [], singleLine: true })).toBe('a b c')
  })
  it('applies per-app replacements before boolean transforms', () => {
    expect(applyProfileTransforms('say cat.', { match: [], replacements: ['cat=>dog'], stripTrailingPeriod: true })).toBe('say dog')
  })
  it('no-ops when no transforms set', () => {
    expect(applyProfileTransforms('Hello world.', { match: [] })).toBe('Hello world.')
  })
})

describe('profilePromptRule + presets', () => {
  it('returns the rule or empty string', () => {
    expect(profilePromptRule({ match: [], promptRule: 'be terse' })).toBe('be terse')
    expect(profilePromptRule({ match: [] })).toBe('')
  })
  it('ships editable presets including a Code profile', () => {
    expect(DEFAULT_PROFILES.some((p) => p.match.includes('Code'))).toBe(true)
  })
})
