/**
 * Pure Home-tab math: today's dictation stats, streaks, relative times and
 * hotkey hint formatting. No DOM, no IPC — unit-tested in tests/home-stats.test.ts.
 */

import type { HistoryEntry } from '../../shared/types'

/** Average typing speed used for the "time saved" estimate (words/minute). */
export const TYPING_WPM = 40

export interface HomeStats {
  /** Dictations made today (local calendar day). */
  todayCount: number
  /** Total words across today's `final` texts. */
  wordsToday: number
  /**
   * Estimated minutes saved today: time to type today's words at TYPING_WPM
   * minus the actual time spent dictating, floored at 0.
   */
  timeSavedMin: number
  /** Consecutive calendar days ending today with >= 1 dictation (0 if none today). */
  streakDays: number
}

/** Word count of a text (whitespace-separated tokens). */
export function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

/** Local calendar-day key for an epoch-ms timestamp, e.g. "2026-7-4". */
function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** True when both timestamps fall on the same local calendar day. */
function sameDay(a: number, b: number): boolean {
  return dayKey(a) === dayKey(b)
}

/**
 * Consecutive calendar days ending today (inclusive) that each have at least
 * one entry. 0 when there is no entry today.
 */
export function computeStreak(entries: HistoryEntry[], now = Date.now()): number {
  const days = new Set(entries.map((e) => dayKey(e.ts)))
  let streak = 0
  const cursor = new Date(now)
  // Walk backwards day by day via Date mutation (handles month/DST edges).
  while (days.has(`${cursor.getFullYear()}-${cursor.getMonth()}-${cursor.getDate()}`)) {
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

/** All Home stat numbers from a history slice (newest-first or any order). */
export function computeHomeStats(entries: HistoryEntry[], now = Date.now()): HomeStats {
  const today = entries.filter((e) => sameDay(e.ts, now))
  const wordsToday = today.reduce((sum, e) => sum + countWords(e.final), 0)
  const dictatedMin = today.reduce((sum, e) => sum + e.durationMs, 0) / 60_000
  const typedMin = wordsToday / TYPING_WPM
  return {
    todayCount: today.length,
    wordsToday,
    timeSavedMin: Math.max(0, Math.round(typedMin - dictatedMin)),
    streakDays: computeStreak(entries, now)
  }
}

/** Compact relative time for the Recent list: "now", "4m", "2h", "3d". */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * Split a settings hotkey name into display key labels for the footer hint.
 * "CtrlWin"/"Ctrl+Win" → ["Ctrl","Win"]; "RightCtrl" → ["Right Ctrl"]; "F13" → ["F13"].
 */
export function hotkeyKeyLabels(hotkey: string): string[] {
  const normalized = hotkey.replace(/\+/g, '').toLowerCase()
  if (normalized === 'ctrlwin') return ['Ctrl', 'Win']
  // "RightCtrl" → "Right Ctrl" (split CamelCase); leave "F13" etc. intact.
  const spaced = hotkey.replace(/([a-z])([A-Z])/g, '$1 $2').trim()
  return [spaced || 'Right Ctrl']
}
