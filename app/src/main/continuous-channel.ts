import type { HistoryEntry, OwenFlowSettings, PillState } from '../shared/types'
import { applyReplacements, parseDictionary } from './dictionary'

export interface ContinuousDeps {
  setPillState: (s: PillState) => void
  startRecorder: () => void
  stopRecorder: () => void
  getSettings: () => OwenFlowSettings
  appendHistory: (e: HistoryEntry) => void
  transcribe: (wav: ArrayBuffer, settings: OwenFlowSettings) => Promise<{ text: string; durationMs: number }>
  cleanup: (raw: string, settings: OwenFlowSettings) => Promise<string>
  inject: (text: string) => Promise<void>
}

let deps: ContinuousDeps | null = null
let active = false
let generation = 0
let parts: string[] = []
let tail: Promise<void> = Promise.resolve()
let settings: OwenFlowSettings | null = null
let startedAt = 0

export function initContinuousChannel(d: ContinuousDeps): void {
  deps = d
}
export function isContinuousActive(): boolean {
  return active
}

export function startContinuous(): void {
  if (!deps || active) return
  active = true
  generation++
  parts = []
  tail = Promise.resolve()
  settings = deps.getSettings()
  startedAt = Date.now()
  deps.setPillState({ state: 'recording' })
  deps.startRecorder()
}

export function onSegment(wav: ArrayBuffer): void {
  if (!deps || !active || !settings) return
  const gen = generation
  const s = settings
  const d = deps
  tail = tail
    .then(async () => {
      if (gen !== generation) return
      const r = await d.transcribe(wav, s)
      const raw = r.text.trim()
      if (!raw || gen !== generation) return
      const wantsCleanup = s.flowMode !== 'normal' || s.cleanupEnabled
      const cleaned = wantsCleanup ? (await d.cleanup(raw, s).catch(() => raw)) || raw : raw
      const { replacements } = parseDictionary(s.dictionary)
      const final = applyReplacements(cleaned, replacements)
      if (gen !== generation) return
      await d.inject(final).catch(() => {})
      parts.push(final)
    })
    .catch(() => {})
}

export function stopContinuous(): void {
  if (!deps || !active) return
  deps.stopRecorder() // recorder flushes the final segment(s) then calls onDone
}

export async function onDone(): Promise<void> {
  if (!deps || !active) return
  const gen = generation
  await tail
  if (gen !== generation || !active) return
  active = false
  if (parts.length > 0) {
    const text = parts.join(' ')
    deps.appendHistory({ ts: Date.now(), raw: text, final: text, durationMs: Date.now() - startedAt, tags: [], mode: 'continuous' })
  }
  deps.setPillState({ state: 'done' })
}

export function cancelContinuous(): void {
  if (!deps || !active) return
  generation++
  // ORDER MATTERS: clear `active` BEFORE stopRecorder(). stopRecorder makes the
  // recorder flush + emit recorder:done, which calls onDone() — onDone's first
  // guard is `!active`, so it must already be false here or a cancelled session
  // would still write a history entry.
  active = false
  deps.stopRecorder()
  deps.setPillState({ state: 'idle' })
}
