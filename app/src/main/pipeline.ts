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
import { matchProfile, applyProfileTransforms, profilePromptRule, profileMode } from './profiles'
import { resolveNormalIntensity } from './cleanup'
import { isCommandActive } from './command-channel'
import { detectPressEnter } from './press-enter'

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
  cleanup?: (raw: string, settings: OwenFlowSettings, extraSystem?: string) => Promise<string>
  /** injector.ts — clipboard-swap paste into the focused app. */
  inject?: (text: string) => Promise<void>
  /** injector.ts — single Enter keystroke for the "press enter" voice command. */
  pressEnter?: () => Promise<void>
  /** injector.ts — focused process name for app profiles. */
  getForegroundApp?: () => Promise<string | null>
  /** transcribe-queue.ts — queue a failed dictation for retry. */
  enqueueTranscription?: (wav: ArrayBuffer, settings: OwenFlowSettings, startedAt: number) => void
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
  if (isCommandActive()) return
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
    if (deps.enqueueTranscription) {
      deps.enqueueTranscription(wav, settings, startedAt)
      failPill('⏳ Queued — will transcribe when ready', 2500)
      return
    }
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
  //     (skip cleanup AND dictionary AND app-profile detection; canned text must not be rewritten).
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

  // App profile: detect focused app and match a formatting profile (when enabled).
  const app = settings.appProfilesEnabled ? (await deps.getForegroundApp?.()) ?? null : null
  if (gen !== generation) return
  const profile = settings.appProfilesEnabled ? matchProfile(app, settings.profiles) : null

  // Session tones can override the flow mode; profile pins secondary; global is fallback.
  const sessionMode = activeSessionMode(settings.activeSession, parseSessionTones(settings.sessionTones))
  const effMode = sessionMode ?? profileMode(profile) ?? settings.flowMode
  const effective = effMode !== settings.flowMode ? { ...settings, flowMode: effMode } : settings

  // 3. AI cleanup / mode rewrite — never blocks (cleanup() already falls back
  //    to raw on any error, but guard here too in case a mock/dep throws).
  //    Normal mode respects the Auto Cleanup intensity (anything but 'none'
  //    wants the pass; legacy cleanupEnabled=false counts as 'none');
  //    vibe/formal/translate ALWAYS go through cleanup() (which falls back to
  //    raw when no API key is set).
  let cleaned = raw
  const wantsCleanup =
    effective.flowMode !== 'normal' || resolveNormalIntensity(effective) !== 'none'
  if (wantsCleanup && deps.cleanup) {
    try {
      cleaned = (await deps.cleanup(raw, effective, profile ? profilePromptRule(profile) || undefined : undefined)) || raw
    } catch {
      cleaned = raw
    }
    if (gen !== generation) return // cancelled — ignore the cleanup result
  }

  // 4. Dictionary "wrong=>right" replacements, then profile-specific transforms.
  const { replacements } = parseDictionary(settings.dictionary)
  const replaced = applyReplacements(cleaned, replacements)
  const transformed = profile ? applyProfileTransforms(replaced, profile) : replaced

  // 4b. "Press enter" voice command: a TRAILING "press enter" / "hit enter"
  //     is stripped from the paste (and from history) and turned into an
  //     Enter keystroke AFTER the successful inject — so "sounds good press
  //     enter" sends the Slack/AI-chat message hands-free. Detected on the
  //     fully-transformed text because cleanup often reshapes the phrase
  //     ("… Press enter.") and dictionary/profile edits come first.
  const { text: final, pressEnter } = detectPressEnter(transformed)

  // 5. Inject into the focused app. An utterance that was ONLY the command
  //    ("press enter") leaves nothing to paste — skip the inject and go
  //    straight to the keystroke.
  try {
    if (!deps.inject) throw new Error('Injector unavailable')
    if (final) await deps.inject(final)
  } catch (err) {
    if (gen !== generation) return
    processing = false
    // Text is left on the clipboard by the injector — still record history.
    // NOTE: pressEnter is deliberately NOT fired here — pressing Enter after
    // a failed paste would submit whatever half-typed text the app holds.
    appendEntry(raw, final, startedAt, effective.flowMode, sessionTag(settings), app ?? undefined)
    failPill(err instanceof Error ? err.message : 'Paste failed')
    return
  }
  if (gen !== generation) return

  // 5b. Enter keystroke, only after the paste landed (never before, never on
  //     inject failure). A missed Enter must not fail the dictation — the
  //     text is already pasted — so any error is swallowed.
  if (pressEnter && deps.pressEnter) {
    try {
      await deps.pressEnter()
    } catch (err) {
      console.warn('[pipeline] press-enter failed:', err instanceof Error ? err.message : err)
    }
    if (gen !== generation) return
  }

  processing = false
  appendEntry(raw, final, startedAt, effective.flowMode, sessionTag(settings), app ?? undefined)
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
  tags: string[] = [],
  app?: string
): void {
  const ts = Date.now()
  const entry: HistoryEntry = {
    ts,
    raw,
    final,
    durationMs: ts - startedAt,
    tags,
    mode
  }
  if (app !== undefined) entry.app = app
  deps?.appendHistory(entry)
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
