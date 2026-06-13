import { describe, expect, it } from 'vitest'
import { computeDigest } from '../src/main/digest'
import type { HistoryEntry } from '../src/shared/types'

const entry = (ts: number, final: string): HistoryEntry => ({ ts, raw: final, final, durationMs: 0, tags: [] })
const DAY = new Date('2026-06-13T12:00:00').getTime()

describe('computeDigest', () => {
  it('counts entries + words for the same calendar day and estimates time saved', () => {
    const entries = [
      entry(new Date('2026-06-13T09:00:00').getTime(), 'one two three four'),
      entry(new Date('2026-06-13T17:00:00').getTime(), 'five six'),
      entry(new Date('2026-06-12T17:00:00').getTime(), 'yesterday words here ignored')
    ]
    const d = computeDigest(entries, DAY, 40)
    expect(d.count).toBe(2)
    expect(d.words).toBe(6)
    expect(d.timeSavedMinutes).toBe(Math.round(6 / 40))
  })
  it('empty day → zeros', () => {
    expect(computeDigest([], DAY, 40)).toEqual({ count: 0, words: 0, timeSavedMinutes: 0 })
  })
})
