/**
 * Dictation pipeline:
 *   record (recorder window) → transcribe (sidecar.ts) → cleanup (cleanup.ts)
 *   → dictionary replacements → inject (injector.ts) → history append.
 *
 * Streaming pre-transcription: while the hotkey is still held, the recorder
 * flushes pause-separated segments ("recorder:segment" → onRecorderSegment)
 * that a Pretranscriber transcribes in the background. On release only the
 * final remainder ("recorder:data") is transcribed, the texts are joined,
 * and the EXISTING tail (snippet → cleanup → dictionary → press-enter →
 * inject → one history entry) runs exactly once — same UX, but stop→paste no
 * longer pays for transcribing the whole take. See pretranscribe.ts for the
 * ordering/fallback design.
 *
 * Everything external is injected through a single `PipelineDeps` object so
 * the real modules (sidecar/injector/cleanup) plug in from index.ts and tests
 * can mock the whole flow.
 */

import type { HistoryEntry, OwenFlowSettings, PillState } from '../shared/types'
import { Pretranscriber } from './pretranscribe'
import { applyReplacements, parseDictionary } from './dictionary'
import { matchSnippet, parseSnippets } from './snippets'
import { activeSessionMode, parseSessionTones } from './sessions'
import { matchProfile, applyProfileTransforms, profilePromptRule, profileMode } from './profiles'
import { resolveNormalIntensity } from './cleanup'
import { buildContextHint } from './uia-parse'
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

  /**
   * sidecar.ts — POST wav to the local faster-whisper server. `context` is
   * the trailing words of the transcript so far (segment boundary accuracy);
   * index.ts appends it to the dictionary bias prompt.
   */
  transcribe?: (
    wav: ArrayBuffer,
    settings: OwenFlowSettings,
    context?: string
  ) => Promise<TranscribeResult>
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
  /**
   * meeting-channel.ts — dictations made while a meeting is recording get a
   * 'meeting' history tag, so mid-meeting notes stay traceable to the meeting.
   */
  isMeetingActive?: () => boolean
  /**
   * uia.ts — read code identifiers from the focused editor at dictation start
   * for Whisper biasing. Awaited behind a 250ms cap in stopDictation so a slow
   * UIA read never delays paste.
   */
  readEditorSymbols?: () => Promise<string[]>
  /**
   * uia.ts — read the focused field's text + foreground browser site at
   * dictation stop, in parallel with transcription, for cleanup context
   * awareness (name spelling, register matching). Never throws; returns
   * empty values on any error.
   */
  readFocusContext?: () => Promise<{ text: string; site: string | null }>
  /**
   * scratchpad.ts — route dictated text into the scratchpad when it is open
   * and capturing. Returns true if the text was consumed (inject + pressEnter
   * are skipped); false if the pad is closed or capture is off. Called inside
   * a try-catch so a throwing implementation is treated as not-consumed.
   */
  routeText?: (text: string) => boolean
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
/**
 * Background pre-transcriber for the CURRENT dictation. Created on start,
 * fed by onRecorderSegment while recording, drained by stopDictation, and
 * cancelled+dropped on cancel. Kept non-null until the final recorder:data
 * arrives because renderer IPC ordering guarantees every recorder:segment
 * lands BEFORE it — nulling earlier would drop (lose) tail segments.
 */
let pretrans: Pretranscriber | null = null
/**
 * Promise for editor symbols kicked off at dictation start (target editor is
 * focused then). Awaited behind a 250ms cap in stopDictation so a slow UIA
 * read never delays paste. The resolved list becomes a local `symbolContext`
 * string passed explicitly into acc.finish() — see stopDictation. Null when
 * the dep is absent or already consumed.
 */
let editorSymbolsPromise: Promise<string[]> | null = null

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
  // Fresh accumulator per dictation. Its transcribe closure re-reads settings
  // per segment (cheap, and mid-dictation settings edits stay coherent).
  const d = deps
  pretrans = new Pretranscriber(async (wav, boundaryContext) => {
    if (!d.transcribe) throw new Error('Transcriber unavailable')
    // Background segments use boundary context only. Symbol context (editor
    // identifiers) is passed structurally into finish(wav, symbolContext) at
    // stop time — see stopDictation — so it reaches the final remainder alone
    // and can never leak onto mid-dictation segments or degraded-mode retries.
    return (await d.transcribe(wav, d.getSettings(), boundaryContext)).text
  })
  if (hideTimer) clearTimeout(hideTimer)
  deps.setPillState({ state: 'recording' })
  deps.recorderStart()
  // Editor symbols are read NOW (target editor is focused at start); the read
  // is awaited behind a cap at stop so a slow UIA read never delays paste.
  editorSymbolsPromise = deps.readEditorSymbols ? deps.readEditorSymbols().catch(() => []) : null
}

/**
 * A pause-flushed segment arrived from the recorder while a normal dictation
 * is in flight (index.ts routes "recorder:segment" here when continuous mode
 * isn't the active channel). No generation/dictating check needed: `pretrans`
 * is nulled on cancel and internally refuses pushes after finish().
 */
export function onRecorderSegment(wav: ArrayBuffer): void {
  pretrans?.push(wav)
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
  // Kill background pre-transcription too: no new segment transcribes are
  // issued and anything in flight resolves into a discarded instance.
  pretrans?.cancel()
  pretrans = null
  editorSymbolsPromise = null
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
 * collect final WAV → drain pre-transcriptions + transcribe the remainder →
 * cleanup → dictionary → inject → history.
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
    // The recorder produced nothing — abandon any pre-transcribed segments
    // too (a partial paste would be out-of-order text).
    pretrans?.cancel()
    pretrans = null
    processing = false
    failPill(err instanceof Error ? err.message : 'Recorder failed')
    return
  }
  if (gen !== generation) return // cancelled — discard the audio

  // Every recorder:segment has arrived by now (renderer IPC ordering: they
  // precede recorder:data), so the accumulator can be taken over safely.
  const pt = pretrans
  pretrans = null

  // Await editor symbols behind a 250ms cap — a slow UIA read must never push
  // out the paste. The resolved string is passed explicitly into acc.finish()
  // below and reaches ONLY the final-remainder transcription (not background
  // segments, which ran in the chain before finish() is called, and not
  // degraded-mode retries, which are identified by index inside finish()).
  const symbols = await withCap(editorSymbolsPromise, EDITOR_SYMBOL_CAP_MS, [])
  editorSymbolsPromise = null
  const symbolContext = symbols.length ? `Code identifiers: ${symbols.join(', ')}.` : undefined
  if (gen !== generation) return // cancelled while awaiting symbols

  const settings = deps.getSettings()

  // Focus context kicked off here so it overlaps transcription I/O.
  // The result is awaited just before the cleanup call and merged into
  // extraSystem — it is INDEPENDENT of the symbol-context path (Task 4).
  const focusPromise = deps.readFocusContext
    ? deps.readFocusContext().catch(() => ({ text: '', site: null }))
    : Promise.resolve({ text: '', site: null })

  // 1. Transcribe: wait for in-flight segment transcriptions, transcribe the
  //    final remainder, and join. `pt` is always set on this path (created in
  //    startDictation, and cancel bumps the generation) — the fallback
  //    accumulator is pure defensiveness for a torn state.
  const acc =
    pt ??
    new Pretranscriber(async (w, context) => {
      if (!deps?.transcribe) throw new Error('Transcriber unavailable')
      return (await deps.transcribe(w, settings, context)).text
    })
  const outcome = await acc.finish(wav, symbolContext)
  if (gen !== generation) return // cancelled — ignore the late transcript

  if (!outcome.ok) {
    // A segment failed even after its stop-time retry (sidecar cold/busy).
    // Never lose audio, never paste out of order: queue EVERY segment WAV in
    // order — the transcribe-queue recovers them to History tagged
    // 'recovered' (full dictation, correct order), nothing is pasted.
    processing = false
    if (deps.enqueueTranscription) {
      for (const w of outcome.wavs) deps.enqueueTranscription(w, settings, startedAt)
      failPill('⏳ Queued — will transcribe when ready', 2500)
      return
    }
    failPill(outcome.error)
    return
  }
  const raw = outcome.text

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
    const snippetConsumed = safeRouteText(deps, snippetText)
    if (!snippetConsumed) {
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
    }
    processing = false
    const snippetTags = sessionTag(settings)
    if (snippetConsumed) snippetTags.push('scratchpad')
    appendEntry(raw, snippetText, startedAt, settings.flowMode, snippetTags)
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
      const focus = await focusPromise
      const contextHint = buildContextHint(focus)
      const profileRule = profile ? profilePromptRule(profile) || '' : ''
      const extraSystem = [profileRule, contextHint].filter(Boolean).join('\n') || undefined
      cleaned = (await deps.cleanup(raw, effective, extraSystem)) || raw
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

  // Route to scratchpad when it is open and capturing. Only attempted when
  // there is actual text (empty final = "press enter only" utterance — nothing
  // meaningful to append). Both inject and pressEnter are skipped when consumed.
  const routeConsumed = final ? safeRouteText(deps, final) : false

  // 5. Inject into the focused app. An utterance that was ONLY the command
  //    ("press enter") leaves nothing to paste — skip the inject and go
  //    straight to the keystroke. Both are skipped when scratchpad consumed.
  if (!routeConsumed) {
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
  }

  processing = false
  const entryTags = sessionTag(settings)
  if (routeConsumed) entryTags.push('scratchpad')
  appendEntry(raw, final, startedAt, effective.flowMode, entryTags, app ?? undefined)
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
  const tags = label ? [label.toLowerCase().replace(/\s+/g, '-')] : []
  // Mid-meeting dictations carry a 'meeting' tag so notes taken during a call
  // stay distinguishable from (and traceable alongside) ordinary dictations.
  if (deps?.isMeetingActive?.()) tags.push('meeting')
  return tags
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

/**
 * Call `deps.routeText` inside a try-catch so a throwing router is treated as
 * not-consumed (returns false). Returns false when the dep is absent.
 */
function safeRouteText(deps: PipelineDeps, text: string): boolean {
  if (!deps.routeText) return false
  try {
    return deps.routeText(text)
  } catch {
    return false
  }
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

/** Maximum wait for editor symbol reads before continuing with an empty list. */
const EDITOR_SYMBOL_CAP_MS = 250

/**
 * Race `p` against a `ms`-ms timeout that resolves to `fallback`.
 * Passing `null` skips the race entirely (dep absent → no read).
 */
function withCap<T>(p: Promise<T> | null, ms: number, fallback: T): Promise<T> {
  if (!p) return Promise.resolve(fallback)
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))])
}
