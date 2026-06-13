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
import { matchSnippet, parseSnippets } from './snippets'
import { activeSessionMode, parseSessionTones } from './sessions'

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
}

// ─── State ──────────────────────────────────────────────────────────────────

let deps: PipelineDeps | null = null
/** Recording phase active (mic capturing). */
let dictating = false
/** Stop in-flight (transcribe/cleanup/inject still running). */
let processing = false
/**
 * Cancellation generation counter. Bumped on every start AND on cancel; an
 * in-flight stopDictation() captures the value at entry and bails after every
 * await if it no longer matches — so a late sidecar response can't paste.
 */
let generation = 0
let hideTimer: NodeJS.Timeout | null = null

export function initPipeline(pipelineDeps: PipelineDeps): void {
  deps = pipelineDeps
}

export function isDictating(): boolean {
  return dictating
}

/** True while recording OR while a stop (transcribe/cleanup/inject) is in flight. */
export function isDictationActive(): boolean {
  return dictating || processing
}

// ─── Public API (hotkey layer calls these) ──────────────────────────────────

/** Begin a dictation (hotkey pressed / toggled on). */
export async function startDictation(): Promise<void> {
  if (!deps || dictating || processing) return
  dictating = true
  generation++
  if (hideTimer) clearTimeout(hideTimer)
  deps.setPillState({ state: 'recording' })
  deps.recorderStart()
}

/**
 * Abort the current dictation (Escape pressed). Works while recording AND
 * while transcribing: the recorder is stopped and its audio discarded, any
 * in-flight transcription/cleanup result is invalidated via the generation
 * counter (nothing is injected, nothing goes to history) and the pill hides
 * immediately. Returns true if there was anything to cancel.
 */
export function cancelDictation(): boolean {
  if (!deps || (!dictating && !processing)) return false
  generation++ // invalidate any in-flight stopDictation()
  if (dictating) {
    dictating = false
    // Stop the recorder so the mic releases; discard whatever it captured.
    void Promise.resolve()
      .then(() => deps?.recorderStop())
      .catch(() => {})
  }
  processing = false
  if (hideTimer) clearTimeout(hideTimer)
  deps.setPillState({ state: 'idle' }) // renderer does a brief fade-out
  return true
}

/**
 * End a dictation (hotkey released / toggled off):
 * collect WAV → transcribe → cleanup → dictionary → inject → history.
 */
export async function stopDictation(): Promise<void> {
  if (!deps || !dictating) return
  dictating = false
  processing = true
  const gen = generation
  const startedAt = Date.now()

  deps.setPillState({ state: 'transcribing' })

  let wav: ArrayBuffer
  try {
    wav = await deps.recorderStop()
  } catch (err) {
    if (gen !== generation) return // cancelled mid-flight
    processing = false
    failPill(err instanceof Error ? err.message : 'Recorder failed')
    return
  }
  if (gen !== generation) return // cancelled — discard the audio

  const settings = deps.getSettings()

  // 1. Transcribe (local whisper sidecar).
  let raw: string
  try {
    if (!deps.transcribe) throw new Error('Transcriber unavailable')
    const result = await deps.transcribe(wav, settings)
    raw = result.text.trim()
  } catch (err) {
    if (gen !== generation) return
    processing = false
    failPill(err instanceof Error ? err.message : 'Transcription failed')
    return
  }
  if (gen !== generation) return // cancelled — ignore the late transcript

  // 2. Empty / silence → flash "—", inject nothing.
  if (!raw) {
    processing = false
    failPill('—', 1500)
    return
  }

  // 2b. Voice snippet: whole-utterance trigger -> paste expansion verbatim
  //     (skip cleanup AND dictionary; canned text must not be rewritten).
  const snippetText = matchSnippet(raw, parseSnippets(settings.snippets))
  if (snippetText !== null) {
    try {
      if (!deps.inject) throw new Error('Injector unavailable')
      await deps.inject(snippetText)
    } catch (err) {
      if (gen !== generation) return
      processing = false
      appendEntry(raw, snippetText, startedAt, settings.flowMode, sessionTag(settings))
      failPill(err instanceof Error ? err.message : 'Paste failed')
      return
    }
    if (gen !== generation) return
    processing = false
    appendEntry(raw, snippetText, startedAt, settings.flowMode, sessionTag(settings))
    deps.setPillState({ state: 'done' })
    scheduleHide(1200)
    return
  }

  // 3. AI cleanup / mode rewrite — never blocks (cleanup() already falls back
  //    to raw on any error, but guard here too in case a mock/dep throws).
  //    Normal mode respects the cleanupEnabled toggle; vibe/formal ALWAYS go
  //    through cleanup() (which falls back to raw when no API key is set).
  //    Session tones can override the flow mode for the duration of this run.
  const sessionMode = activeSessionMode(settings.activeSession, parseSessionTones(settings.sessionTones))
  const effective = sessionMode ? { ...settings, flowMode: sessionMode } : settings
  let cleaned = raw
  const wantsCleanup = effective.flowMode !== 'normal' || effective.cleanupEnabled
  if (wantsCleanup && deps.cleanup) {
    try {
      cleaned = (await deps.cleanup(raw, effective)) || raw
    } catch {
      cleaned = raw
    }
    if (gen !== generation) return // cancelled — ignore the cleanup result
  }

  // 4. Dictionary "wrong=>right" replacements.
  const { replacements } = parseDictionary(settings.dictionary)
  const final = applyReplacements(cleaned, replacements)

  // 5. Inject into the focused app.
  try {
    if (!deps.inject) throw new Error('Injector unavailable')
    await deps.inject(final)
  } catch (err) {
    if (gen !== generation) return
    processing = false
    // Text is left on the clipboard by the injector — still record history.
    appendEntry(raw, final, startedAt, effective.flowMode, sessionTag(settings))
    failPill(err instanceof Error ? err.message : 'Paste failed')
    return
  }
  if (gen !== generation) return

  processing = false
  appendEntry(raw, final, startedAt, effective.flowMode, sessionTag(settings))
  deps.setPillState({ state: 'done' })
  scheduleHide(1200)
}

/**
 * Debug affordance: full fake dictation pass (recording → transcribing →
 * done) without touching the mic, so the pill UI can be verified visually.
 */
export async function simulateDictation(): Promise<void> {
  if (!deps || dictating || processing) return
  dictating = true
  generation++
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

function sessionTag(settings: OwenFlowSettings): string[] {
  const label = settings.activeSession?.trim()
  return label ? [label.toLowerCase().replace(/\s+/g, '-')] : []
}

function appendEntry(
  raw: string,
  final: string,
  startedAt: number,
  mode: string,
  tags: string[] = []
): void {
  const ts = Date.now()
  deps?.appendHistory({
    ts,
    raw,
    final,
    durationMs: ts - startedAt,
    tags,
    mode
  })
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
