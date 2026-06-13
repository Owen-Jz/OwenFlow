# OwenFlow Batch D (slice 3) — Continuous Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps. All commands from `app/`.

**Goal:** A `continuousMode` setting that turns the dictation hotkey into long-form draft mode: the recorder splits on pauses, each segment streams through transcribe→cleanup→paste while you keep talking; one History entry per session.

**Spec:** `docs/superpowers/specs/2026-06-13-owenflow-batch-d-continuous-mode-design.md`

---

## Task E1: Settings + IPC types

**Files:** `src/shared/types.ts`, `src/main/config.ts`, `tests/config.test.ts`

- [ ] Test: `DEFAULT_SETTINGS.continuousMode === false`.
- [ ] `types.ts` — `OwenFlowSettings` (after `commandHotkey`): `/** Long-form draft mode: stream segments on pauses. */ continuousMode: boolean`. In the `IPC` const add `recorderSegment: 'recorder:segment'`, `recorderDone: 'recorder:done'`. In `OwenFlowApi.recorder`, add: `sendSegment: (wav: ArrayBuffer) => void`, `sendDone: () => void`, and change `onStart` to `onStart: (cb: (continuous: boolean) => void) => () => void`.
- [ ] `config.ts` — `DEFAULT_SETTINGS`: `continuousMode: false,`. schema: `continuousMode: { type: 'boolean', default: false },`.
- [ ] `npm run test -- config` PASS. (Typecheck will break in preload/recorder until E4 — that's expected; run `npm run test -- config` only here.) Commit → `feat: continuous mode setting + segment IPC`.

## Task E2: segmenter.ts pure module

**Files:** create `src/renderer/src/segmenter.ts`, `tests/segmenter.test.ts`

(Placed in renderer/src because the recorder uses it; it's pure so the test imports it directly.)

- [ ] Tests:
```ts
import { describe, expect, it } from 'vitest'
import { SegmentState, shouldFlush } from '../src/renderer/src/segmenter'

const SILENCE_MS = 700
const MAX_MS = 15000

describe('shouldFlush', () => {
  it('does not flush before any speech', () => {
    const s: SegmentState = { hasSpeech: false, silenceMs: 1000, segmentMs: 1000 }
    expect(shouldFlush(s, SILENCE_MS, MAX_MS)).toBe(false)
  })
  it('flushes after a silence run past the threshold once speech occurred', () => {
    expect(shouldFlush({ hasSpeech: true, silenceMs: 800, segmentMs: 2000 }, SILENCE_MS, MAX_MS)).toBe(true)
  })
  it('does not flush during continuous speech', () => {
    expect(shouldFlush({ hasSpeech: true, silenceMs: 100, segmentMs: 2000 }, SILENCE_MS, MAX_MS)).toBe(false)
  })
  it('force-flushes at the max segment length even without silence', () => {
    expect(shouldFlush({ hasSpeech: true, silenceMs: 0, segmentMs: 15001 }, SILENCE_MS, MAX_MS)).toBe(true)
  })
})
```
- [ ] Implement `src/renderer/src/segmenter.ts`:
```ts
/**
 * Pure pause-segmentation decision for continuous dictation. The recorder
 * tracks how long it has been silent and how long the current segment is, and
 * asks shouldFlush() whether to cut the segment here.
 */
export interface SegmentState {
  /** Has any above-threshold audio occurred in the current segment? */
  hasSpeech: boolean
  /** Continuous silence so far (ms). */
  silenceMs: number
  /** Length of the current segment so far (ms). */
  segmentMs: number
}

/** Flush when a real pause follows speech, or the segment hits the hard cap. */
export function shouldFlush(s: SegmentState, silenceMs: number, maxMs: number): boolean {
  if (s.hasSpeech && s.segmentMs >= maxMs) return true
  return s.hasSpeech && s.silenceMs >= silenceMs
}
```
- [ ] `npm run test -- segmenter` PASS. Commit → `feat: pause segmentation helper`.

## Task E3: continuous-channel.ts

**Files:** create `src/main/continuous-channel.ts`, `tests/continuous-channel.test.ts`

- [ ] DI channel. Deps:
```ts
interface ContinuousDeps {
  setPillState: (s: PillState) => void
  startRecorder: () => void          // tells recorder to start in continuous mode
  stopRecorder: () => void           // tells recorder to stop (it will flush + send done)
  getSettings: () => OwenFlowSettings
  appendHistory: (e: HistoryEntry) => void
  transcribe: (wav: ArrayBuffer, settings: OwenFlowSettings) => Promise<{ text: string; durationMs: number }>
  cleanup: (raw: string, settings: OwenFlowSettings) => Promise<string>
  inject: (text: string) => Promise<void>
}
```
Exports `initContinuousChannel(deps)`, `startContinuous()`, `stopContinuous()`, `cancelContinuous()`, `isContinuousActive()`, `onSegment(wav)`, `onDone()`.
Behavior:
- `startContinuous`: if active → return; `active=true`, `generation++`, reset `parts: string[] = []` and a serial promise chain `tail = Promise.resolve()`, `startedAt=Date.now()`; pill recording; `deps.startRecorder()`.
- `onSegment(wav)`: if not active → ignore. Capture `gen`. Chain the work onto `tail` so segments process IN ORDER: `tail = tail.then(async () => { if (gen !== generation) return; const r = await deps.transcribe(wav, settings); const raw = r.text.trim(); if (!raw) return; const cleaned = settings.cleanupEnabled || settings.flowMode !== 'normal' ? await deps.cleanup(raw, settings).catch(() => raw) : raw; const { replacements } = parseDictionary(settings.dictionary); const final = applyReplacements(cleaned, replacements); if (gen !== generation) return; await deps.inject(final).catch(() => {}); parts.push(final) }).catch(() => {})`. (settings snapshotted at start.)
- `stopContinuous`: if not active → return; `deps.stopRecorder()` (recorder will emit the final segment(s) then done). Set a `stopping` flag. (Do NOT finalize yet — wait for onDone.)
- `onDone()`: if not active → return; `await tail` (drain), then write ONE history entry `{ ts, raw: parts.join(' '), final: parts.join(' '), durationMs: Date.now()-startedAt, tags: [], mode: 'continuous' }` (only if parts non-empty), pill done, `active=false`.
- `cancelContinuous()`: `generation++`, `active=false`, `deps.stopRecorder()`, pill idle. Drops pending pastes via the gen guard.
- Never throws; per-segment failures are swallowed (segment skipped).
Import `parseDictionary`, `applyReplacements` from `./dictionary`.
- [ ] Tests (`continuous-channel.test.ts`, mocked deps): start → onSegment(a) → onSegment(b) → onDone: transcribe+inject called twice in order, one appendHistory with `mode: 'continuous'` and concatenated final; cancel after one segment stops further injects; a transcribe-throwing segment is skipped (no inject for it, others proceed). Drive the serial chain by awaiting a microtask flush between calls (mirror how other channel tests await).
- [ ] `npm run test -- continuous-channel` PASS. Commit → `feat: continuous dictation channel`.

## Task E4: recorder.ts segmentation + preload/IPC

**Files:** `src/renderer/src/recorder.ts`, `src/preload/index.ts`, `src/main/index.ts` (recorder bridge only)

- [ ] **preload:** `onStart` cb now receives `continuous: boolean` (the main send includes it). Add `sendSegment: (wav) => ipcRenderer.send(IPC.recorderSegment, wav)`, `sendDone: () => ipcRenderer.send(IPC.recorderDone)`. (Match the existing `sendData` pattern.)
- [ ] **recorder.ts:** `startCapture(continuous)` stores the flag. In `onaudioprocess` (or via the existing 50ms level timer), when `continuous`, track `silenceMs`/`segmentMs`/`hasSpeech` from the audio level (RMS of the chunk, threshold e.g. 0.01) and call `shouldFlush(...)` (import from `./segmenter`, `SILENCE_MS=700`, `MAX_SEGMENT_MS=15000`). On flush: encode the accumulated samples → `window.owenflow.recorder.sendSegment(wav)`, clear the buffer + reset segment counters (keep recording). `onStart((continuous) => startCapture(continuous))`. `stopCapture()`: in continuous mode, send the remaining buffer via `sendSegment` (if non-empty) then `sendDone()`; in normal mode, unchanged (`sendData`).
- [ ] **index.ts (recorder bridge):** `recorderStart` gains a `continuous` arg → `getRecorderWindow()?.webContents.send(IPC.recorderStart, continuous)`. Register `ipcMain.on(IPC.recorderSegment, (_e, wav) => onSegment(wav))` and `ipcMain.on(IPC.recorderDone, () => onDone())` (from continuous-channel) — only meaningful while continuous is active (the channel ignores when inactive).
- [ ] `npm run typecheck` + `npm run build`. Commit → `feat: recorder pause-segmentation + segment IPC`.

## Task E5: routing (hotkey → continuous vs one-shot)

**Files:** `src/main/index.ts`

- [ ] The dictation hotkey callbacks branch on `getSettings().continuousMode`:
  - `onStart`: `if (getSettings().continuousMode) startContinuous(); else void startDictation()` (keep the existing command-active guard).
  - `onStop`: `if (isContinuousActive()) stopContinuous(); else void stopDictation()`.
  - `onCancel`: `if (isContinuousActive()) cancelContinuous(); else cancelDictation()`.
- [ ] `initContinuousChannel({ setPillState, startRecorder: () => recorderStart(true), stopRecorder: () => getRecorderWindow()?.webContents.send(IPC.recorderStop), getSettings, appendHistory: history.append, transcribe: (wav, s) => transcribe(wav, parseDictionary(s.dictionary).promptWords.join(', ') || undefined, s.language || undefined), cleanup, inject })`. (Normal `recorderStart()` calls now pass `false`.)
- [ ] Ensure the command channel + continuous are mutually exclusive too (command onStart already guards on `isDictationActive` — extend to also check `isContinuousActive()`; and dictation/continuous start guards include command).
- [ ] `npm run typecheck` + `npm run build`; `npm run test`. Commit → `feat: route hotkey to continuous mode when enabled`.

## Task E6: Settings UI toggle

**Files:** `src/renderer/settings.html`, `src/renderer/src/settings.ts`

- [ ] Add a row (Dictation card on General, or Modes): `#f-continuous` checkbox "Continuous draft mode" with hint "Keep talking; text streams in on pauses (long-form)." Wire `fillForm` (`fContinuous.checked = s.continuousMode`) + `readForm` (`continuousMode: fContinuous.checked`). `npm run typecheck` + `npm run build`. Commit → `feat: continuous mode settings toggle`.

## Task E7: Docs + verify + push

- [ ] README: document continuous/draft mode. `npm run test` (all green, counts), `npm run build`. Commit → `docs: continuous draft mode`. `git push`.

---

## Self-Review Notes
- Pure `segmenter.ts` + DI `continuous-channel.ts` are unit-tested; recorder audio + routing are build-verified + need a GUI smoke.
- Segments process in a serial promise chain (ordered pastes); generation guard drops pending work on cancel/stop.
- One History entry per session (`mode: 'continuous'`).
- `onStart` IPC signature change ripples to preload + recorder (done together by E1+E4); run full typecheck only after E4.
- Mutual exclusion extended to three channels (dictation, command, continuous) — continuous reuses the dictation hotkey, so it's naturally exclusive with one-shot dictation; just guard vs command.
