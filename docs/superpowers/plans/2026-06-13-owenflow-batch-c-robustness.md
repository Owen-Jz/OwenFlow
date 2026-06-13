# OwenFlow Batch C (Robustness) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps. All commands from `app/` (`C:\Users\owen\Downloads\OwenFlow\app`).

**Goal:** #7 Whisper fallback ladder (in-memory retry queue → recovered dictations land in History + notification, never late-paste) and #8 daily dictation digest (scheduled stats notification, optional LLM themes).

**Spec:** `docs/superpowers/specs/2026-06-13-owenflow-batch-c-robustness-design.md`

---

## Task C1: Types + config (digest settings)

**Files:** `src/shared/types.ts`, `src/main/config.ts`, `tests/config.test.ts`

- [ ] **Step 1 — failing test.** Add to `tests/config.test.ts`:
```ts
describe('config digest', () => {
  it('declares digest defaults', () => {
    expect(DEFAULT_SETTINGS.digestEnabled).toBe(true)
    expect(DEFAULT_SETTINGS.digestHour).toBe(18)
    expect(DEFAULT_SETTINGS.digestThemes).toBe(false)
  })
})
```
- [ ] **Step 2 — FAIL:** `npm run test -- config`
- [ ] **Step 3 — types.** In `OwenFlowSettings` (after `profiles`), add:
```ts
  /** Show a daily dictation digest notification. */
  digestEnabled: boolean
  /** Hour of day (0-23) to fire the digest. */
  digestHour: number
  /** Include an LLM theme summary in the digest (opt-in; uses your provider). */
  digestThemes: boolean
```
- [ ] **Step 4 — config.** In `DEFAULT_SETTINGS` (after `profiles: DEFAULT_PROFILES,`): `digestEnabled: true, digestHour: 18, digestThemes: false,`. In `schema` (after the `profiles` entry):
```ts
    digestEnabled: { type: 'boolean', default: true },
    digestHour: { type: 'number', minimum: 0, maximum: 23, default: 18 },
    digestThemes: { type: 'boolean', default: false },
```
- [ ] **Step 5 — PASS:** `npm run test -- config`; `npm run typecheck:node`.
- [ ] **Step 6 — commit:** `git add src/shared/types.ts src/main/config.ts tests/config.test.ts` → `feat: digest settings`.

## Task C2: digest.ts pure module

**Files:** create `src/main/digest.ts`, `tests/digest.test.ts`

- [ ] **Step 1 — failing tests:**
```ts
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
    expect(d.timeSavedMinutes).toBe(Math.round(6 / 40)) // 0
  })
  it('empty day → zeros', () => {
    expect(computeDigest([], DAY, 40)).toEqual({ count: 0, words: 0, timeSavedMinutes: 0 })
  })
})
```
- [ ] **Step 2 — FAIL.** **Step 3 — implement `src/main/digest.ts`:**
```ts
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
```
- [ ] **Step 4 — PASS:** `npm run test -- digest`. **Step 5 — commit** → `feat: digest stats module`.

## Task C3: transcribe-queue.ts

**Files:** create `src/main/transcribe-queue.ts`, `tests/transcribe-queue.test.ts`

- [ ] **Step 1 — failing tests** (fake timers):
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initTranscribeQueue, enqueue, queueLength, _resetQueue } from '../src/main/transcribe-queue'
import type { OwenFlowSettings } from '../src/shared/types'

const settings = {} as OwenFlowSettings

describe('transcribe-queue', () => {
  beforeEach(() => { vi.useFakeTimers(); _resetQueue() })
  afterEach(() => { vi.useRealTimers() })

  it('retries until transcribe succeeds, then delivers once', async () => {
    let calls = 0
    const transcribe = vi.fn(async () => {
      calls++
      if (calls < 3) throw new Error('Transcriber not ready')
      return { text: 'recovered text', durationMs: 5 }
    })
    const deliver = vi.fn()
    initTranscribeQueue({ transcribe, deliver })
    enqueue(new ArrayBuffer(8), settings, 1000)
    expect(queueLength()).toBe(1)
    await vi.advanceTimersByTimeAsync(3000 * 3 + 100)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][0]).toBe('recovered text')
    expect(queueLength()).toBe(0)
  })

  it('gives up after max attempts → onDrop', async () => {
    const transcribe = vi.fn(async () => { throw new Error('still cold') })
    const deliver = vi.fn()
    const onDrop = vi.fn()
    initTranscribeQueue({ transcribe, deliver, onDrop })
    enqueue(new ArrayBuffer(8), settings, 1000)
    await vi.advanceTimersByTimeAsync(3000 * 41)
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(deliver).not.toHaveBeenCalled()
    expect(queueLength()).toBe(0)
  })
})
```
- [ ] **Step 2 — FAIL.** **Step 3 — implement `src/main/transcribe-queue.ts`:**
```ts
/**
 * In-memory retry queue for dictations that failed to transcribe (sidecar cold
 * or busy). Retries on an interval until success or MAX_ATTEMPTS, then delivers
 * the recovered transcript (never throws). Lost on app quit — by design.
 */
import type { OwenFlowSettings } from '../shared/types'

export interface QueueItem {
  wav: ArrayBuffer
  settings: OwenFlowSettings
  startedAt: number
  attempts: number
}

interface TranscribeResult { text: string; durationMs: number }
interface QueueDeps {
  transcribe: (wav: ArrayBuffer, settings: OwenFlowSettings) => Promise<TranscribeResult>
  deliver: (text: string, item: QueueItem) => void
  onDrop?: (item: QueueItem) => void
}

const RETRY_INTERVAL_MS = 3000
const MAX_ATTEMPTS = 40

let deps: QueueDeps | null = null
let items: QueueItem[] = []
let timer: NodeJS.Timeout | null = null
let draining = false

export function initTranscribeQueue(d: QueueDeps): void {
  deps = d
}

export function queueLength(): number {
  return items.length
}

/** Test helper — clears state. */
export function _resetQueue(): void {
  items = []
  if (timer) clearInterval(timer)
  timer = null
  draining = false
}

export function enqueue(wav: ArrayBuffer, settings: OwenFlowSettings, startedAt: number): void {
  items.push({ wav, settings, startedAt, attempts: 0 })
  startTimer()
}

function startTimer(): void {
  if (timer) return
  timer = setInterval(() => void drain(), RETRY_INTERVAL_MS)
}

function stopTimer(): void {
  if (timer) clearInterval(timer)
  timer = null
}

async function drain(): Promise<void> {
  if (draining || !deps || items.length === 0) return
  draining = true
  try {
    const item = items[0]
    item.attempts++
    try {
      const result = await deps.transcribe(item.wav, item.settings)
      items.shift()
      deps.deliver(result.text, item)
    } catch {
      if (item.attempts >= MAX_ATTEMPTS) {
        items.shift()
        deps.onDrop?.(item)
      }
    }
    if (items.length === 0) stopTimer()
  } finally {
    draining = false
  }
}
```
- [ ] **Step 4 — PASS:** `npm run test -- transcribe-queue`. **Step 5 — commit** → `feat: in-memory transcribe retry queue`.

## Task C4: cleanup.ts summarize()

**Files:** `src/main/cleanup.ts`, `tests/cleanup.test.ts`

- [ ] **Step 1 — failing test:**
```ts
describe('summarize', () => {
  it('posts a summary prompt and returns the model text', async () => {
    fetchMock.mockResolvedValue(okResponse('Themes: code, email.'))
    const out = await summarize('a\nb\nc', settings({ cleanupProvider: 'groq', groqApiKey: 'gk' }))
    expect(out).toBe('Themes: code, email.')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content.toLowerCase()).toContain('summ')
  })
  it('returns empty string with no key', async () => {
    expect(await summarize('x', settings({ cleanupProvider: 'groq', groqApiKey: '' }))).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
```
(Import `summarize` alongside `cleanup` in the test.)
- [ ] **Step 2 — FAIL.** **Step 3 — implement** in `src/main/cleanup.ts`: export an async `summarize(text, settings)` that reuses `resolveProvider(settings, settings.cleanupProvider ?? 'groq')`, returns `''` if no `apiKey`, posts the same request shape as `cleanup` with a system prompt like `'Summarize the recurring themes of these dictation transcripts in one short line. Output only the summary.'` and the user content = `text`, temperature 0, max_tokens 200; returns the trimmed reply or `''` on any error/non-200. Never throws.
- [ ] **Step 4 — PASS:** `npm run test -- cleanup`. **Step 5 — commit** → `feat: cleanup.summarize for digest themes`.

## Task C5: pipeline #7 integration

**Files:** `src/main/pipeline.ts`, `tests/pipeline.test.ts`

- [ ] Read `stopDictation`'s transcribe try/catch + `PipelineDeps` first.
- [ ] **Step 1 — failing tests:** add `enqueueTranscription: vi.fn()` to `makeDeps` deps. Add:
```ts
it('transcribe failure enqueues (does not failPill) when enqueue dep present', async () => {
  const deps = makeDeps(baseSettings(), [])
  deps.transcribe.mockRejectedValue(new Error('Transcriber not ready (starting)'))
  await runDictation(deps)
  expect(deps.enqueueTranscription).toHaveBeenCalledTimes(1)
  expect(deps.inject).not.toHaveBeenCalled()
  expect(deps.appendHistory).not.toHaveBeenCalled()
})
```
- [ ] **Step 2 — FAIL.** **Step 3 — implement:** add `enqueueTranscription?: (wav: ArrayBuffer, settings: OwenFlowSettings, startedAt: number) => void` to `PipelineDeps`. In the `stopDictation` transcribe `catch (err)` block, BEFORE `failPill`, add: if `deps.enqueueTranscription` is defined → call `deps.enqueueTranscription(wav, settings, startedAt)`, set an informational pill `failPill('⏳ Queued — will transcribe when ready', 2500)` (reuses the error state; the message conveys it's queued, not a hard error), `processing = false`, and `return`. (Keep the `gen !== generation` guard before enqueuing.) If no dep, keep the existing `failPill('Transcription failed')`.
- [ ] **Step 4 — PASS:** `npm run test -- pipeline`; `npm run test`. **Step 5 — commit** → `feat: pipeline enqueues failed transcriptions`.

## Task C6: index.ts wiring (queue deliver + digest scheduler + tray)

**Files:** `src/main/digest-scheduler.ts` (new), `src/main/index.ts`, `src/main/tray.ts`

- [ ] **digest-scheduler.ts (new):**
```ts
/**
 * Fires a daily dictation-digest notification at the configured hour. Pure of
 * Date.now only at the edges (uses real timers); the stats math lives in
 * digest.ts. Re-init when digest settings change.
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

let deps: SchedulerDeps | null = null
let timer: NodeJS.Timeout | null = null

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
    const d = computeDigest(deps.listHistory(), Date.now())
    if (d.count > 0) {
      let body = `${d.count} dictations · ${d.words} words · ~${d.timeSavedMinutes} min saved`
      if (s.digestThemes && deps.summarize) {
        const themes = await deps
          .summarize(deps.listHistory().filter((e) => sameDayNow(e.ts)).map((e) => e.final).join('\n'), s)
          .catch(() => '')
        if (themes) body += `\n${themes}`
      }
      deps.notify('OwenFlow — today's dictation digest', body, deps.openHistory)
    }
  } finally {
    schedule() // next day
  }
}

function sameDayNow(ts: number): boolean {
  const a = new Date(ts)
  const b = new Date()
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Build + return today's digest body immediately (tray "Today's digest"). */
export function digestNow(): { title: string; body: string } | null {
  if (!deps) return null
  const d = computeDigest(deps.listHistory(), Date.now())
  return { title: 'OwenFlow — today's dictation digest', body: `${d.count} dictations · ${d.words} words · ~${d.timeSavedMinutes} min saved` }
}
```
- [ ] **index.ts:** import `Notification` from electron; `import { initTranscribeQueue, enqueue } from './transcribe-queue'`; `import { initDigestScheduler, rescheduleDigest, digestNow } from './digest-scheduler'`; `import { summarize } from './cleanup'`; `import { clipboard } from 'electron'` (if not already). A `notify(title, body, onClick)` helper using `new Notification({ title, body })`, `.on('click', onClick)`, `.show()`.
  - `initTranscribeQueue({ transcribe: (wav, s) => transcribe(wav, parseDictionary(s.dictionary).promptWords.join(', ') || undefined, s.language || undefined), deliver, onDrop })` where `deliver(text, item)` = `void (async () => { const cleaned = await cleanup(text, item.settings).catch(() => text); const { replacements } = parseDictionary(item.settings.dictionary); const final = applyReplacements(cleaned, replacements); history.append({ ts: Date.now(), raw: text, final, durationMs: 0, tags: ['recovered'], mode: item.settings.flowMode }); notify('Recovered dictation', final.slice(0, 140), () => clipboard.writeText(final)) })()` and `onDrop(item)` = `notify('Dictation lost', 'Could not transcribe a queued dictation (sidecar unavailable).', () => {})`. (Import `applyReplacements`, `parseDictionary` from `./dictionary`.)
  - In `initPipeline({...})` add `enqueueTranscription: (wav, s, startedAt) => enqueue(wav, s, startedAt)`.
  - After tray creation: `initDigestScheduler({ getSettings, listHistory: () => history.list(Number.MAX_SAFE_INTEGER), summarize, notify, openHistory: () => void openSettingsWindow('history') })`.
  - In `onSettingsChange`, when `digestEnabled`/`digestHour`/`digestThemes` change → `rescheduleDigest()`.
- [ ] **tray.ts:** add a "Today's digest" menu item (after History) → a new callback `onShowDigest`. In `index.ts`, wire `onShowDigest: () => { const d = digestNow(); if (d) notify(d.title, d.body, () => void openSettingsWindow('history')) }`. Add `onShowDigest: () => void` to `TrayCallbacks`.
- [ ] Verify `npm run typecheck:node` + `npm run build`. Commit → `feat: wire transcribe queue + digest scheduler`.

## Task C7: Settings UI for digest toggles

**Files:** `src/renderer/settings.html`, `src/renderer/src/settings.ts`

- [ ] Add a "Digest" card (General page) with `#f-digest-enabled` (checkbox), `#f-digest-hour` (number input 0–23), `#f-digest-themes` (checkbox). Wire refs + `fillForm` (`fDigestEnabled.checked = s.digestEnabled; fDigestHour.value = String(s.digestHour); fDigestThemes.checked = s.digestThemes`) + `readForm` (`digestEnabled, digestHour: Math.min(23, Math.max(0, Number(fDigestHour.value) || 18)), digestThemes`). `npm run typecheck` + `npm run build`. Commit → `feat: digest settings UI`.

## Task C8: Docs + verify + push

- [ ] README: document the fallback ladder + daily digest. `npm run test` (all green, counts), `npm run build`. Commit → `docs: fallback ladder + daily digest`. Then `git push`.

---

## Self-Review Notes
- Pure modules (`digest.ts`, `transcribe-queue.ts`) take `now`/deps in and never throw → fully testable.
- #7 recovered delivery: cleanup + dictionary only (no app profile — no focused app), tagged `recovered`, notification click copies; never pastes.
- Scheduler reschedules after each fire + on settings change; guards invalid hour; only notifies when count > 0.
- `summarize` reuses provider plumbing; off unless `digestThemes`.
- Fixtures: config/pipeline/cleanup + DEFAULT_SETTINGS gain digest fields; `PipelineDeps.enqueueTranscription` optional so existing tests are unaffected.
- NOTE for implementer: the `digest-scheduler.ts` sample uses `'today's'` inside double-quoted strings — fix the apostrophe (use "today's" with escaped or different quotes) so it compiles.
