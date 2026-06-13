/**
 * Fires a daily dictation-digest notification at the configured hour. Stats
 * math lives in digest.ts; this module owns the timer + content assembly.
 */
import type { OwenFlowSettings, HistoryEntry } from '../shared/types'
import { computeDigest } from './digest'

interface SchedulerDeps {
  getSettings: () => OwenFlowSettings
  listHistory: () => HistoryEntry[]
  summarize?: (text: string, settings: OwenFlowSettings) => Promise<string>
  notify: (title: string, body: string, onClick: () => void) => void
  openHistory: () => void
}

const TITLE = 'OwenFlow — daily dictation digest'
let deps: SchedulerDeps | null = null
let timer: ReturnType<typeof setTimeout> | null = null

export function initDigestScheduler(d: SchedulerDeps): void {
  deps = d
  schedule()
}

/** Recompute the next fire time (call on settings change). */
export function rescheduleDigest(): void {
  schedule()
}

function msUntilNextHour(hour: number): number {
  const now = new Date()
  const next = new Date(now)
  next.setHours(hour, 0, 0, 0)
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

function sameDayNow(ts: number): boolean {
  const a = new Date(ts)
  const b = new Date()
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function statsBody(): { count: number; body: string } {
  const d = computeDigest(deps!.listHistory(), Date.now())
  return {
    count: d.count,
    body: `${d.count} dictations · ${d.words} words · ~${d.timeSavedMinutes} min saved`
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (!deps) return
  const s = deps.getSettings()
  if (!s.digestEnabled) return
  const hour = Math.min(23, Math.max(0, Math.floor(s.digestHour ?? 18)))
  timer = setTimeout(() => void fire(), msUntilNextHour(hour))
}

async function fire(): Promise<void> {
  if (!deps) return
  try {
    const s = deps.getSettings()
    const { count, body } = statsBody()
    if (count > 0) {
      let full = body
      if (s.digestThemes && deps.summarize) {
        const texts = deps
          .listHistory()
          .filter((e) => sameDayNow(e.ts))
          .map((e) => e.final)
          .join('\n')
        const themes = await deps.summarize(texts, s).catch(() => '')
        if (themes) full += `\n${themes}`
      }
      deps.notify(TITLE, full, deps.openHistory)
    }
  } finally {
    schedule()
  }
}

/** Build today's digest immediately (tray "Today's digest"); null if empty. */
export function digestNow(): { title: string; body: string } | null {
  if (!deps) return null
  const { count, body } = statsBody()
  if (count === 0) return null
  return { title: TITLE, body }
}
