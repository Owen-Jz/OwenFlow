/**
 * Dictation pipeline:
 *   record (recorder window) → transcribe (sidecar.ts) → cleanup (cleanup.ts)
 *   → dictionary replacements → inject (injector.ts) → history append.
 *
 * Everything external is injected through a single `PipelineDeps` object so
 * the real modules (sidecar/injector/cleanup) plug in from index.ts and tests
 * can mock the whole flow.
 */

import type { HistoryEntry, OwenFlowSettings, PillState } from '../shared/types'
import { applyReplacements, parseDictionary } from './dictionary'

// ─── Dependency contract ─────────────────────────────────────────────────────

export interface TranscribeResult {
  text: string
  durationMs: number
}

export interface PipelineDeps {
  /** Push a state to the pill overlay. */
  setPillState: (state: PillState) => void
  /** Tell the hidden recorder window to start capturing. */
  recorderStart: () => void
  /**
   * Tell the recorder to stop; resolves with the 16kHz mono WAV the renderer
   * sends back on "recorder:data" (or rejects on timeout / recorder error).
   */
  recorderStop: () => Promise<ArrayBuffer>
  /** Current settings snapshot. */
  getSettings: () => OwenFlowSettings
  /** Append a finished dictation to history.jsonl. */
  appendHistory: (entry: HistoryEntry) => void

  /** sidecar.ts — POST wav to the local faster-whisper server. */
  transcribe?: (wav: ArrayBuffer, settings: OwenFlowSettings) => Promise<TranscribeResult>
  /** cleanup.ts — mode-aware MiniMax pass (6s/12s timeout, raw fallback). */
  cleanup?: (raw: string, settings: OwenFlowSettings) => Promise<string>
  /** injector.ts — clipboard-swap paste into the focused app. */
  inject?: (text: string) => Promise<void>
  /**
   * tagger.ts — fire-and-forget background topic-tagging of the appended
   * history entry. Called AFTER inject; must never block or throw.
   */
  autoTag?: (ts: number, transcript: string) => void
}

// ─── State ──────────────────────────────────────────────────────────────────

let deps: PipelineDeps | null = null
let dictating = false
let hideTimer: NodeJS.Timeout | null = null

export function initPipeline(pipelineDeps: PipelineDeps): void {
  deps = pipelineDeps
}

export function isDictating(): boolean {
  return dictating
}

// ─── Public API (hotkey layer calls these) ──────────────────────────────────

/** Begin a dictation (hotkey pressed / toggled on). */
export async function startDictation(): Promise<void> {
  if (!deps || dictating) return
  dictating = true
  if (hideTimer) clearTimeout(hideTimer)
  deps.setPillState({ state: 'recording' })
  deps.recorderStart()
}

/**
 * End a dictation (hotkey released / toggled off):
 * collect WAV → transcribe → cleanup → dictionary → inject → history.
 */
export async function stopDictation(): Promise<void> {
  if (!deps || !dictating) return
  dictating = false
  const startedAt = Date.now()

  deps.setPillState({ state: 'transcribing' })

  let wav: ArrayBuffer
  try {
    wav = await deps.recorderStop()
  } catch (err) {
    failPill(err instanceof Error ? err.message : 'Recorder failed')
    return
  }

  const settings = deps.getSettings()

  // 1. Transcribe (local whisper sidecar).
  let raw: string
  try {
    if (!deps.transcribe) throw new Error('Transcriber unavailable')
    const result = await deps.transcribe(wav, settings)
    raw = result.text.trim()
  } catch (err) {
    failPill(err instanceof Error ? err.message : 'Transcription failed')
    return
  }

  // 2. Empty / silence → flash "—", inject nothing.
  if (!raw) {
    failPill('—', 1500)
    return
  }

  // 3. AI cleanup / mode rewrite — never blocks (cleanup() already falls back
  //    to raw on any error, but guard here too in case a mock/dep throws).
  //    Normal mode respects the cleanupEnabled toggle; vibe/formal ALWAYS go
  //    through cleanup() (which falls back to raw when no API key is set).
  let cleaned = raw
  const wantsCleanup = settings.flowMode !== 'normal' || settings.cleanupEnabled
  if (wantsCleanup && deps.cleanup) {
    try {
      cleaned = (await deps.cleanup(raw, settings)) || raw
    } catch {
      cleaned = raw
    }
  }

  // 4. Dictionary "wrong=>right" replacements.
  const { replacements } = parseDictionary(settings.dictionary)
  const final = applyReplacements(cleaned, replacements)

  // 5. Inject into the focused app.
  try {
    if (!deps.inject) throw new Error('Injector unavailable')
    await deps.inject(final)
  } catch (err) {
    // Text is left on the clipboard by the injector — still record history.
    appendEntry(raw, final, startedAt, settings.flowMode)
    failPill(err instanceof Error ? err.message : 'Paste failed')
    return
  }

  const ts = appendEntry(raw, final, startedAt, settings.flowMode)
  deps.setPillState({ state: 'done' })
  scheduleHide(1200)

  // 6. Background auto-tagging — fire-and-forget AFTER inject, never delays paste.
  try {
    deps.autoTag?.(ts, final)
  } catch {
    /* tagging is best-effort */
  }
}

/**
 * Debug affordance: full fake dictation pass (recording → transcribing →
 * done) without touching the mic, so the pill UI can be verified visually.
 */
export async function simulateDictation(): Promise<void> {
  if (!deps || dictating) return
  dictating = true
  deps.setPillState({ state: 'recording' })
  await delay(1500)
  deps.setPillState({ state: 'transcribing' })
  await delay(1200)
  deps.appendHistory({
    ts: Date.now(),
    raw: 'this is a simulated dictation um with some filler words',
    final: 'This is a simulated dictation with some filler words.',
    durationMs: 2700,
    tags: ['demo'],
    mode: deps.getSettings().flowMode
  })
  deps.setPillState({ state: 'done' })
  dictating = false
  scheduleHide(1200)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function appendEntry(raw: string, final: string, startedAt: number, mode: string): number {
  const ts = Date.now()
  deps?.appendHistory({
    ts,
    raw,
    final,
    durationMs: ts - startedAt,
    tags: [],
    mode
  })
  return ts
}

function failPill(message: string, hideAfterMs = 3000): void {
  deps?.setPillState({ state: 'error', message })
  scheduleHide(hideAfterMs)
}

function scheduleHide(ms: number): void {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    deps?.setPillState({ state: 'idle' })
  }, ms)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
