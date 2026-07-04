import { describe, expect, it } from 'vitest'
import {
  computeHomeStats,
  computeStreak,
  countWords,
  hotkeyKeyLabels,
  relativeTime,
  TYPING_WPM
} from '../src/renderer/src/home-stats'
import type { HistoryEntry } from '../src/shared/types'

/** Noon local time on a fixed day — keeps calendar-day math deterministic. */
const NOW = new Date(2026, 6, 4, 12, 0, 0).getTime() // Sat Jul 4 2026, 12:00 local

const DAY = 24 * 60 * 60 * 1000

function entry(ts: number, final: string, durationMs = 0): HistoryEntry {
  return { ts, raw: final, final, durationMs, tags: [] }
}

describe('countWords', () => {
  it('counts whitespace-separated words', () => {
    expect(countWords('hello world')).toBe(2)
    expect(countWords('  one   two\tthree\nfour ')).toBe(4)
  })

  it('returns 0 for empty/blank text', () => {
    expect(countWords('')).toBe(0)
    expect(countWords('   ')).toBe(0)
  })
})

describe('computeHomeStats', () => {
  it('returns zeros for empty history', () => {
    expect(computeHomeStats([], NOW)).toEqual({
      todayCount: 0,
      wordsToday: 0,
      timeSavedMin: 0,
      streakDays: 0
    })
  })

  it("counts only today's dictations and words", () => {
    const entries = [
      entry(NOW - 1000, 'one two three'), // today: 3 words
      entry(NOW - 2000, 'four five'), // today: 2 words
      entry(NOW - DAY, 'yesterday words dont count') // yesterday
    ]
    const stats = computeHomeStats(entries, NOW)
    expect(stats.todayCount).toBe(2)
    expect(stats.wordsToday).toBe(5)
  })

  it('estimates time saved as typing time minus dictation time', () => {
    // 80 words today at TYPING_WPM=40 → 2 min typing; 30s dictated → ~2 min saved.
    const words = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ')
    const stats = computeHomeStats([entry(NOW - 1000, words, 30_000)], NOW)
    expect(TYPING_WPM).toBe(40)
    expect(stats.timeSavedMin).toBe(2) // round(2 - 0.5) = 2
  })

  it('floors time saved at 0 when dictating took longer than typing would', () => {
    const stats = computeHomeStats([entry(NOW - 1000, 'short', 600_000)], NOW)
    expect(stats.timeSavedMin).toBe(0)
  })
})

describe('computeStreak', () => {
  it('is 0 with no entry today (even with entries yesterday)', () => {
    expect(computeStreak([entry(NOW - DAY, 'x')], NOW)).toBe(0)
  })

  it('counts consecutive days ending today', () => {
    const entries = [
      entry(NOW - 1000, 'today'),
      entry(NOW - DAY, 'yesterday'),
      entry(NOW - 2 * DAY, 'two days ago')
    ]
    expect(computeStreak(entries, NOW)).toBe(3)
  })

  it('stops at a gap day', () => {
    const entries = [
      entry(NOW - 1000, 'today'),
      // no entry yesterday
      entry(NOW - 2 * DAY, 'two days ago'),
      entry(NOW - 3 * DAY, 'three days ago')
    ]
    expect(computeStreak(entries, NOW)).toBe(1)
  })

  it('counts multiple entries on one day once', () => {
    const entries = [entry(NOW - 1000, 'a'), entry(NOW - 2000, 'b'), entry(NOW - DAY, 'c')]
    expect(computeStreak(entries, NOW)).toBe(2)
  })
})

describe('relativeTime', () => {
  it('formats now / minutes / hours / days', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('now')
    expect(relativeTime(NOW - 4 * 60_000, NOW)).toBe('4m')
    expect(relativeTime(NOW - 2 * 60 * 60_000, NOW)).toBe('2h')
    expect(relativeTime(NOW - 3 * DAY, NOW)).toBe('3d')
  })

  it('never goes negative for future timestamps', () => {
    expect(relativeTime(NOW + 60_000, NOW)).toBe('now')
  })
})

describe('hotkeyKeyLabels', () => {
  it('splits the Ctrl+Win combo into two keys', () => {
    expect(hotkeyKeyLabels('CtrlWin')).toEqual(['Ctrl', 'Win'])
    expect(hotkeyKeyLabels('Ctrl+Win')).toEqual(['Ctrl', 'Win'])
    expect(hotkeyKeyLabels('ctrl+win')).toEqual(['Ctrl', 'Win'])
  })

  it('spaces CamelCase single keys', () => {
    expect(hotkeyKeyLabels('RightCtrl')).toEqual(['Right Ctrl'])
    expect(hotkeyKeyLabels('LeftAlt')).toEqual(['Left Alt'])
  })

  it('leaves function keys intact', () => {
    expect(hotkeyKeyLabels('F13')).toEqual(['F13'])
  })
})
