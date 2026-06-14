/**
 * Command-channel orchestration:
 *   copy selection → record → transcribe → classify → run / notify → inject → history.
 *
 * Mirrors the pipeline.ts state machine exactly:
 *   - Same generation-counter cancellation discipline.
 *   - Same `recording`/`processing` flags.
 *   - Same pill-state + scheduleHide pattern.
 *   - Never throws.
 */

import type { HistoryEntry, OwenFlowSettings, PillState } from '../shared/types'
import { classifyCommand } from './command'

// ─── Dependency contract ─────────────────────────────────────────────────────

export interface CommandDeps {
  setPillState: (s: PillState) => void
  recorderStart: () => void
  recorderStop: () => Promise<ArrayBuffer>
  getSettings: () => OwenFlowSettings
  appendHistory: (e: HistoryEntry) => void
  transcribe: (wav: ArrayBuffer, settings: OwenFlowSettings) => Promise<{ text: string; durationMs: number }>
  /** Read the current clipboard selection before recording starts (clipboard read). */
  copySelection: () => Promise<string>
  runCommand: (instruction: string, target: string, settings: OwenFlowSettings) => Promise<string>
  inject: (text: string) => Promise<void>
  notify: (title: string, body: string) => void
  /** Send a voice instruction to the ZEAL VPS endpoint. Never throws. */
  sendZeal: (instruction: string) => Promise<{ ok: boolean; reply: string; error?: string }>
  /** Speak text aloud via the sidecar TTS endpoint (best-effort, optional). */
  speak?: (text: string) => void
}

// ─── Module state ─────────────────────────────────────────────────────────────

let deps: CommandDeps | null = null
/** Hotkey held down — mic is capturing. */
let recording = false
/** Stop in-flight (transcribe/runCommand/inject still running). */
let processing = false
/**
 * Cancellation generation counter. Bumped on every startCommand() AND on
 * cancelCommand(); any in-flight stopCommand() captures `gen` at entry and
 * bails after every await if it no longer matches.
 */
let generation = 0
let hideTimer: NodeJS.Timeout | null = null
/** The clipboard selection captured at startCommand() time, keyed to `generation`. */
let pendingTarget = ''

// ─── Public API ──────────────────────────────────────────────────────────────

export function initCommandChannel(d: CommandDeps): void {
  deps = d
}

/** True while recording OR while a stop is in flight. */
export function isCommandActive(): boolean {
  return recording || processing
}

/** Begin a command (hotkey pressed). Grabs the clipboard selection first. */
export async function startCommand(): Promise<void> {
  if (!deps || recording || processing) return
  generation++
  const gen = generation
  recording = true

  // Grab the target BEFORE showing the pill — copySelection may mutate clipboard.
  let target = ''
  try {
    target = await deps.copySelection()
  } catch {
    target = ''
  }
  // Guard: could have been cancelled while awaiting copySelection.
  if (gen !== generation) return

  pendingTarget = target

  if (hideTimer) clearTimeout(hideTimer)
  deps.setPillState({ state: 'recording' })
  deps.recorderStart()
}

/**
 * Abort the current command (Escape pressed). Works while recording AND while
 * transcribing / running. Invalidates any in-flight stopCommand via the
 * generation counter. Returns true if there was anything to cancel.
 */
export function cancelCommand(): boolean {
  if (!deps || (!recording && !processing)) return false
  generation++ // invalidate any in-flight stopCommand()
  if (recording) {
    recording = false
    void Promise.resolve()
      .then(() => deps?.recorderStop())
      .catch(() => {})
  }
  processing = false
  pendingTarget = ''
  if (hideTimer) clearTimeout(hideTimer)
  deps.setPillState({ state: 'idle' })
  return true
}

/**
 * End a command (hotkey released):
 *   collect WAV → transcribe → classify → runCommand | notify → inject → history.
 */
export async function stopCommand(): Promise<void> {
  if (!deps || !recording) return
  recording = false
  processing = true
  const gen = generation
  const startedAt = Date.now()
  const capturedTarget = pendingTarget

  deps.setPillState({ state: 'transcribing' })

  // 1. Collect WAV.
  let wav: ArrayBuffer
  try {
    wav = await deps.recorderStop()
  } catch (err) {
    if (gen !== generation) return
    processing = false
    failPill(err instanceof Error ? err.message : 'Recorder failed')
    return
  }
  if (gen !== generation) return

  const settings = deps.getSettings()

  // 2. Transcribe.
  let raw: string
  try {
    const result = await deps.transcribe(wav, settings)
    raw = result.text.trim()
  } catch (err) {
    if (gen !== generation) return
    processing = false
    failPill(err instanceof Error ? err.message : 'Transcription failed')
    return
  }
  if (gen !== generation) return

  // 3. Empty / silence → flash "—", do nothing.
  if (!raw) {
    processing = false
    failPill('—', 1500)
    return
  }

  // 4. Classify intent.
  const route = classifyCommand(raw)

  // 5a. Remote sinks — ZEAL voice endpoint (vault routes through the same
  //     endpoint; ZEAL's executor handles note-taking as a dedicated sink later).
  if (route.sink === 'zeal' || route.sink === 'vault') {
    const res = await deps.sendZeal(route.instruction)
    if (gen !== generation) return
    processing = false
    if (res.ok) {
      deps.notify('ZEAL', res.reply)
      deps.appendHistory({
        ts: Date.now(),
        raw: route.instruction,
        final: res.reply,
        durationMs: Date.now() - startedAt,
        tags: [],
        mode: 'command'
      })
      if (settings.zealSpeakReplies && res.reply) deps.speak?.(res.reply)
      deps.setPillState({ state: 'done' })
      scheduleHide(1500)
    } else {
      deps.notify('ZEAL', res.error || 'ZEAL command failed')
      deps.setPillState({ state: 'error', message: res.error || 'ZEAL command failed' })
      scheduleHide(3000)
    }
    return
  }

  // 5b. Local text-edit command.
  let result: string
  try {
    result = (await deps.runCommand(route.instruction, capturedTarget, settings)) || ''
  } catch (err) {
    if (gen !== generation) return
    processing = false
    failPill(err instanceof Error ? err.message : 'Command failed')
    return
  }
  if (gen !== generation) return

  if (!result) {
    processing = false
    failPill('No result')
    return
  }

  // 6. Inject.
  try {
    await deps.inject(result)
  } catch (err) {
    if (gen !== generation) return
    processing = false
    // Text is on the clipboard; still record history.
    deps.appendHistory({
      ts: Date.now(),
      raw: route.instruction,
      final: result,
      durationMs: Date.now() - startedAt,
      tags: [],
      mode: 'command'
    })
    failPill(err instanceof Error ? err.message : 'Paste failed')
    return
  }
  if (gen !== generation) return

  processing = false
  deps.appendHistory({
    ts: Date.now(),
    raw: route.instruction,
    final: result,
    durationMs: Date.now() - startedAt,
    tags: [],
    mode: 'command'
  })
  deps.setPillState({ state: 'done' })
  scheduleHide(1200)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
