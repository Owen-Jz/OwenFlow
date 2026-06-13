# OwenFlow Batch C — Robustness — Design Spec

- **Date:** 2026-06-13
- **Status:** Locked (design approved); → implementation plan
- **Repo:** `OwenFlow` (standalone, `github.com/Owen-Jz/OwenFlow`)

Two features. Both preserve the never-throw / never-block contract.

---

## #7 Whisper fallback ladder (retry queue)

**Goal:** Never lose a dictation to a cold/busy/dead sidecar. If transcription fails, queue the audio and retry until it succeeds; the recovered transcript lands in History + a notification (never a late paste, since focus has moved).

- **New module `transcribe-queue.ts` (main):** in-memory queue, dependency-injected.
  - `initTranscribeQueue({ transcribe, deliver, onDrop? })`.
  - `enqueue(wav, settings, startedAt)` — adds an item `{ wav, settings, startedAt, attempts }` and starts the drain loop.
  - Drain loop: every `RETRY_INTERVAL_MS` (3s), retry `transcribe(head.wav, head.settings)`. On success → `deliver(text, item)` + remove. On failure → `attempts++`; give up after `MAX_ATTEMPTS` (40 ≈ 2 min) → `onDrop(item)`. Stops the timer when the queue empties.
  - `queueLength()` for tests/visibility. In-memory only (survives sidecar cold-starts/crashes; lost on app quit — accepted).
- **Pipeline (`stopDictation`):** add an optional dep `enqueueTranscription?: (wav, settings, startedAt) => void`. When `deps.transcribe(...)` throws AND `enqueueTranscription` is provided, enqueue the WAV, show a brief informational pill ("⏳ Queued — will transcribe when ready"), and return (don't fail the dictation). If no enqueue dep, keep today's `failPill`.
- **Delivery (wired in `index.ts`):** `deliver(text, item)` runs the recovered transcript through `cleanup(text, item.settings)` + global dictionary replacements (NO app-profile transforms — no focused app), appends to History tagged `recovered`, and shows an Electron `Notification` ("Recovered dictation" + preview). Notification **click → copy the text to the clipboard**. Never pastes. `onDrop` shows a "couldn't transcribe — gave up" notification.
- Pill: reuse the existing `error` state with a friendly queued message (no new PillState needed).

## #8 Daily dictation digest

**Goal:** A scheduled end-of-day summary of what you dictated — counts, words, time saved vs 40 WPM typing — via a tray/desktop notification; optional LLM theme summary.

- **New settings:** `digestEnabled: boolean` (default `true`), `digestHour: number` (0–23, default `18`), `digestThemes: boolean` (default `false`, LLM theme summary — opt-in to save tokens).
- **New pure module `digest.ts`:** `computeDigest(entries, now, wpm = 40): { count, words, timeSavedMinutes, periodStart, periodEnd }` — filters entries to the same calendar day as `now`, sums words of `final`, `timeSavedMinutes = round(words / wpm)`. Pure (takes `now` in; no `Date.now()` inside), testable.
- **Scheduler `digest-scheduler.ts` (main):** `initDigestScheduler({ getSettings, listHistory, summarize?, openHistory, now })`. Computes ms to the next `digestHour:00`, `setTimeout`; on fire (if `digestEnabled`): build digest from `listHistory()`, optionally append an LLM theme line via `summarize(...)`, show a `Notification` (click → `openHistory()`), then reschedule for the next day. Re-init when `digestEnabled`/`digestHour` change (via `onSettingsChange`).
- **LLM themes (optional):** `cleanup.ts` exports `summarize(text, settings): Promise<string>` — reuses the provider resolution with a terse "1-line summary of recurring themes" prompt; returns `''` on any failure/no-key. Only called when `digestThemes` is on.
- **On-demand:** a tray item **"Today's digest"** that builds + shows the same notification immediately (so it's testable without waiting for the hour).
- **UI:** the notification carries the stats; clicking opens the History window (existing `openSettingsWindow('history')`). No new settings page beyond the three toggles (placed in an "About"/"General" card or a small "Digest" card).

---

## Cross-cutting

- **Types/config:** `digestEnabled`/`digestHour`/`digestThemes` added to `OwenFlowSettings` + schema + `DEFAULT_SETTINGS`. (No new settings for #7 — the queue is in-memory.)
- **Safety:** queue + digest modules never throw; `summarize` falls back to `''`; the scheduler guards against invalid hours; recovered delivery catches cleanup errors (raw fallback).

## Testing

- `transcribe-queue.test.ts` — enqueue retries until transcribe succeeds → `deliver` called once with the text; gives up after MAX_ATTEMPTS → `onDrop`; uses fake timers; `queueLength` reflects state.
- `digest.test.ts` — `computeDigest` filters to today, sums words, computes timeSaved; empty day → zeros; ignores other-day entries.
- `cleanup.test.ts` (extend) — `summarize` posts a summary prompt to the provider; no key → `''`.
- `pipeline.test.ts` (extend) — transcribe failure WITH `enqueueTranscription` → enqueues + does not failPill + no history/inject; WITHOUT it → today's failPill path.
- `config.test.ts` (extend) — digest defaults + schema.

## Out of scope (v1)

- Persisting the queue across app restarts.
- A rich digest dashboard (notification + History link only).
- Weekly/monthly digests; per-app or per-tag breakdowns.
