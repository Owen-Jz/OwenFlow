# OwenFlow Batch D (slice 3) — Continuous / Draft Mode — Design Spec

- **Date:** 2026-06-13
- **Status:** Locked (sensible defaults chosen); → implementation plan
- **Repo:** `OwenFlow` (standalone)

## Goal

A long-form **draft mode**: hold the dictation hotkey and keep talking; the recorder splits on natural pauses, and each spoken segment is transcribed + (optionally cleaned) + pasted **as you continue**, so text streams into the focused app segment-by-segment. Release the hotkey to finish. One History entry per session.

## Decisions (made, not asked)

- **Trigger:** a `continuousMode: boolean` setting (default `false`). When on, the existing dictation hotkey behaves continuously (no new hotkey). When off, today's one-shot behavior is unchanged.
- **Segmentation:** silence-based. The recorder already computes a level every 50ms; track it. After accumulated speech, a pause of ≥ `SILENCE_MS` (~700ms) flushes the current segment. A hard `MAX_SEGMENT_MS` (~15s) cap flushes even without a pause (so a non-stop talker still streams).
- **Per-segment processing:** transcribe → cleanup (current flowMode/provider) → global dictionary → inject (append at cursor). No app-profile transforms per segment (kept simple). Segments paste sequentially (a queue ensures order; a segment never pastes before the previous one finishes).
- **History:** ONE entry per continuous session, `mode: 'continuous'`, `final` = the concatenation of segment outputs, written on stop.
- **Pill:** stays `recording`; same waveform. (A distinct "draft" indicator is out of scope.)

## Architecture

### Recorder (`recorder.ts`, renderer)
- A `continuous` flag set when capture starts in continuous mode (main passes it on the start message — extend `recorder:start` to carry a boolean, or a separate `recorder:startContinuous`; simplest: a new IPC `recorder:start` payload OR read a flag. Use a dedicated start signal that carries `{ continuous }`).
- Pure helper `segmentDecision(levelHistory, msSinceLastFlush, hasSpeech)` (extract to a tiny pure module `segmenter.ts`) → boolean "flush now". Testable.
- While recording in continuous mode: maintain a rolling RMS/level; when `segmentDecision` says flush AND the buffer has speech, encode the accumulated samples to a WAV, send via **`recorder:segment`**, and reset the buffer (keep capturing). On final stop: send the remaining buffer via `recorder:segment` (if non-empty) then **`recorder:done`**.
- Non-continuous mode: unchanged (one `recorder:data` on stop).

### Continuous channel (`continuous-channel.ts`, main)
- `initContinuousChannel(deps)`, `startContinuous()`, `stopContinuous()`, `cancelContinuous()`, `isContinuousActive()`.
- On start: pill recording; tell the recorder to start in continuous mode; reset the accumulator + segment queue.
- On each `recorder:segment` (wav): enqueue; a single-worker queue transcribes → cleanup → dictionary → inject (append), in order; appends the result to the session accumulator. Generation-guarded so cancel/stop stops further pastes.
- On `recorder:done` (after the user released): flush the queue, write one History entry (`mode: 'continuous'`), pill done.
- Never throws; a failed segment is skipped (logged), the session continues.

### Routing (`index.ts` / hotkey)
- The dictation hotkey's `onStart`/`onStop`: if `getSettings().continuousMode` → route to `startContinuous`/`stopContinuous`; else the existing `startDictation`/`stopDictation`. Cancel (Escape) routes likewise. Mutual exclusion with the command channel still applies (both check active states).
- Segment events from the recorder are dispatched to the continuous channel only while it is active.

### Settings / types
- `continuousMode: boolean` (default false) in `OwenFlowSettings` + schema + `DEFAULT_SETTINGS`.
- New IPC channels `recorderSegment: 'recorder:segment'`, `recorderDone: 'recorder:done'`, plus a continuous start signal. Preload exposes the renderer→main segment/done senders and the main→renderer continuous-start.
- Settings UI: a "Continuous draft mode" toggle (General/Modes) with a one-line hint.

## Testing

- `segmenter.test.ts` — `segmentDecision`: flushes after a silence run past `SILENCE_MS` with speech; not during continuous speech; forces a flush at `MAX_SEGMENT_MS`; no flush when no speech yet.
- `continuous-channel.test.ts` — DI: two segments → two transcribe+cleanup+inject in order, accumulator concatenates, one history entry on done (`mode: 'continuous'`); cancel stops further pastes; a throwing segment is skipped.
- Recorder audio + IPC wiring: build-verified + manual GUI smoke.

## Out of scope (v1)

- True real-time partial-word streaming (segment granularity is pause-based, not word-by-word).
- App-profile transforms per segment.
- A distinct draft-mode pill visual.
- Editing already-pasted segments.
