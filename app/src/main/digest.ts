/**
 * Daily dictation digest stats. Pure module (no electron, no Date.now —
 * callers pass `now`) so it is fully testable.
 */
import type { HistoryEntry } from '../shared/types'

export interface DigestStats {
  count: number
  words: number
  timeSavedMinutes: number
}

function sameDay(a: number, b: number): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  )
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length
}

/** Stats for entries dictated on the same calendar day as `now`. */
export function computeDigest(entries: HistoryEntry[], now: number, wpm = 40): DigestStats {
  let count = 0
  let words = 0
  for (const e of entries) {
    if (!sameDay(e.ts, now)) continue
    count++
    words += wordCount(e.final)
  }
  return { count, words, timeSavedMinutes: Math.round(words / wpm) }
}
