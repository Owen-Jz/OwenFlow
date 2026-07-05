/**
 * Meeting mode orchestrator (main side).
 *
 * A meeting captures TWO live streams in the hidden meeting window — the mic
 * ('you') and Windows loopback/system audio ('them': everyone else in the
 * Meet/Zoom/Slack call) — which arrive here as pause-flushed segment WAVs
 * ("meeting:segment"). Both streams share ONE serial transcription queue
 * (interleaved by arrival, like continuous-channel's tail chain) so the
 * sidecar is never hit concurrently, and each transcribed segment is appended
 * to <userData>/meetings/<id>/transcript.jsonl IMMEDIATELY (meeting-store).
 *
 * 3-hour design constraints this module owns:
 *  - Memory-bounded: a segment WAV lives only inside its queue task — it is
 *    transcribed and dropped; nothing accumulates. (The renderer likewise
 *    holds only the current segment's Float32 chunks per stream.)
 *  - Crash-safe: append-per-segment means a crash 2h in loses at most the
 *    in-flight segment. meta.json words are refreshed on a throttle (30s)
 *    plus on stop, so a crash under-counts words at worst.
 *  - Never stalls: a failed segment gets ONE retry after 3s (covers a cold
 *    sidecar warming up — the transcript self-heals as the model loads);
 *    a second failure appends '[inaudible]' so the gap stays visible, and
 *    the queue moves on.
 *
 * Meetings and dictation COEXIST (Owen dictates notes mid-meeting): nothing
 * here blocks the pipeline. The pill is shared, though — dictation states
 * take priority, and wrapPillState() re-asserts the calm 'meeting' state
 * whenever the pipeline pushes 'idle' while a meeting runs.
 *
 * Stop/start cycling can't interleave: each start creates a fresh session
 * object that every queue task captures by closure — a late segment from a
 * stopped meeting still appends to ITS meeting's file, never the new one.
 * The generation counter guards the shared bits (pill, state listeners).
 *
 * Pure/DI like continuous-channel: everything external (capture IPC, store,
 * transcribe, pill) is injected so tests drive the whole flow.
 */

import type {
  MeetingEntry,
  MeetingMeta,
  MeetingStateInfo,
  MeetingStream,
  OwenFlowSettings,
  PillState
} from '../shared/types'

/** Wait before a failed segment's single retry (sidecar cold/busy breathing room). */
const RETRY_DELAY_MS = 3000
/** meta.json words refresh cadence while running (plus a final write on stop). */
const META_WRITE_INTERVAL_MS = 30_000
/** How long stop() waits for the renderer's flush-then-stopped handshake. */
const STOP_FLUSH_TIMEOUT_MS = 5000
/** Appended in place of a segment that failed transcription twice. */
export const INAUDIBLE = '[inaudible]'

export interface MeetingDeps {
  /** windows.setPillState — RAW, not the wrapped one (see wrapPillState). */
  setPillState: (s: PillState) => void
  /** Tell the hidden meeting window to start capturing (created lazily by index.ts). */
  startCapture: () => void
  /** Tell it to stop: flush remainders → segments → "meeting:capture:stopped". */
  stopCapture: () => void
  getSettings: () => OwenFlowSettings
  /** sidecar.ts with the bias prompt + language pre-wired (index.ts, like continuous). */
  transcribe: (
    wav: ArrayBuffer,
    settings: OwenFlowSettings
  ) => Promise<{ text: string; durationMs: number }>
  /**
   * True while a dictation/command/continuous take owns the pill. Meeting
   * pushes yield to it — the idle re-assert (wrapPillState) restores the
   * meeting display when the dictation finishes.
   */
  isPipelineBusy: () => boolean
  // meeting-store.ts (injected so tests run without electron/fs)
  createMeeting: (startedAt: number) => string
  appendEntry: (id: string, entry: MeetingEntry) => void
  readMeta: (id: string) => MeetingMeta | null
  writeMeta: (id: string, meta: MeetingMeta) => void
  /** Test seams — production wiring omits them for the documented defaults. */
  retryDelayMs?: number
  metaWriteIntervalMs?: number
  stopFlushTimeoutMs?: number
}

/**
 * Per-meeting session. Queue tasks capture THIS object (not module state), so
 * a stop/start cycle can never cross-wire a late segment into the new meeting.
 */
interface MeetingSession {
  id: string
  startedAt: number
  /** Running transcript word count (excludes INAUDIBLE markers). */
  words: number
  lastMetaWriteAt: number
  /** stop() in flight — rejects re-entrant stops and new starts. */
  stopping: boolean
}

let deps: MeetingDeps | null = null
let session: MeetingSession | null = null
/** Bumped on every start; guards shared-state mutations against stale sessions. */
let generation = 0
/** Shared serial transcription queue — 'you' and 'them' interleave by arrival. */
let tail: Promise<void> = Promise.resolve()
/** Resolves the pending stop() when "meeting:capture:stopped" arrives. */
let stopWaiter: (() => void) | null = null

type StateListener = (s: MeetingStateInfo) => void
const stateListeners: StateListener[] = []

export function initMeetingChannel(d: MeetingDeps): void {
  deps = d
}

/** Test helper — clears module state (mirrors transcribe-queue._resetQueue). */
export function _resetMeetingChannel(): void {
  session = null
  generation++
  tail = Promise.resolve()
  stopWaiter = null
  stateListeners.length = 0
}

/** Test helper — resolves once every queued segment task has settled. */
export function _drainMeetingQueue(): Promise<void> {
  return tail
}

export function isMeetingActive(): boolean {
  return session !== null
}

/** Folder id of the running meeting (index.ts refuses to delete it), or null. */
export function activeMeetingId(): string | null {
  return session?.id ?? null
}

export function getMeetingState(): MeetingStateInfo {
  return { active: session !== null, startedAt: session?.startedAt ?? null }
}

/** Subscribe to state changes (tray rebuild + window pushes). Returns unsubscribe. */
export function onMeetingStateChange(listener: StateListener): () => void {
  stateListeners.push(listener)
  return () => {
    const i = stateListeners.indexOf(listener)
    if (i >= 0) stateListeners.splice(i, 1)
  }
}

function notifyState(): void {
  const s = getMeetingState()
  for (const l of [...stateListeners]) l(s)
}

/** Whitespace word count; the words meta field and summary chunking both use it. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/**
 * Tray-label clock, always h:mm:ss ("0:42:13") — meetings run for hours, so
 * the hour slot is permanent. (The pill uses pill-motion's formatClock, its
 * renderer-side sibling — main must not import renderer modules.)
 */
export function formatMeetingElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * Wrap the pill-state pusher handed to the dictation channels: an 'idle' push
 * while a meeting runs becomes the meeting re-assert (the dictation just
 * ended — the pill returns to the calm meeting display instead of hiding).
 * Every other state passes through untouched, which is exactly "dictation
 * states take priority".
 */
export function wrapPillState(base: (s: PillState) => void): (s: PillState) => void {
  return (s) => {
    if (s.state === 'idle' && session) {
      base({ state: 'meeting', startedAt: session.startedAt })
      return
    }
    base(s)
  }
}

// ─── Start / stop ────────────────────────────────────────────────────────────

/**
 * Start a meeting. Returns false when one is already active/stopping or the
 * store couldn't create the folder — the frozen meetings.start() contract.
 */
export async function startMeeting(): Promise<boolean> {
  if (!deps || session) return false
  const startedAt = Date.now()
  let id: string
  try {
    id = deps.createMeeting(startedAt)
  } catch (err) {
    console.error('[meeting] store create failed:', err instanceof Error ? err.message : err)
    return false
  }
  generation++
  session = { id, startedAt, words: 0, lastMetaWriteAt: Date.now(), stopping: false }
  deps.startCapture()
  // Pill: the calm persistent meeting state — unless a dictation owns the
  // pill right now (its own flow renders; the idle re-assert restores us).
  if (!deps.isPipelineBusy()) deps.setPillState({ state: 'meeting', startedAt })
  notifyState()
  return true
}

/**
 * Stop the active meeting: stop capture, wait for the renderer's flush
 * handshake (ordered IPC guarantees every flush segment precedes it, so the
 * whole meeting is queued by then), finalize meta with endedAt/duration, and
 * hand the pill back. The queue keeps draining in the background — a final
 * meta refresh rides behind it so late words are still counted.
 */
export async function stopMeeting(): Promise<void> {
  if (!deps || !session || session.stopping) return
  const d = deps
  const sess = session
  const gen = generation
  sess.stopping = true

  // Register the waiter BEFORE poking the renderer — a synchronous (test) or
  // very fast 'stopped' reply must not slip past an unregistered waiter.
  const stopped = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      stopWaiter = null
      resolve() // renderer wedged/dead — finalize anyway, segments already queued
    }, d.stopFlushTimeoutMs ?? STOP_FLUSH_TIMEOUT_MS)
    stopWaiter = () => {
      clearTimeout(timer)
      resolve()
    }
  })
  d.stopCapture()
  await stopped

  // The meeting is over the moment capture stops — release module state so a
  // new meeting can start while this one's queue still drains.
  if (gen === generation && session === sess) {
    session = null
    notifyState()
    if (!d.isPipelineBusy()) d.setPillState({ state: 'idle' })
  }

  const endedAt = Date.now()
  writeMetaMerged(d, sess, { endedAt, durationMs: endedAt - sess.startedAt })
  // Late segments (queued before 'stopped', transcribed after) still bump
  // sess.words — refresh meta once more when the queue settles.
  void tail.then(() => writeMetaMerged(d, sess, {})).catch(() => {})
}

/**
 * Graceful-quit hook (will-quit is synchronous): stamp endedAt on a running
 * meeting so it doesn't list as crashed. Queued segments are lost — same
 * contract as quitting mid-dictation.
 */
export function endMeetingOnQuit(): void {
  if (!deps || !session) return
  const sess = session
  session = null
  const endedAt = Date.now()
  writeMetaMerged(deps, sess, { endedAt, durationMs: endedAt - sess.startedAt })
}

// ─── Capture events (wired from index.ts IPC) ────────────────────────────────

/** "meeting:capture:stopped" — the renderer finished its stop-flush. */
export function onCaptureStopped(): void {
  stopWaiter?.()
  stopWaiter = null
}

/**
 * "meeting:capture:error" — capture died (mic/loopback denied, device lost).
 * The meeting can't produce audio anymore, so end it like a stop (meta gets
 * endedAt; whatever was queued still drains) and surface the error briefly.
 */
export function onCaptureError(message: string): void {
  if (!deps || !session) return
  const d = deps
  const sess = session
  session = null
  d.stopCapture() // best-effort: release any half-acquired tracks
  notifyState()
  const endedAt = Date.now()
  writeMetaMerged(d, sess, { endedAt, durationMs: endedAt - sess.startedAt })
  d.setPillState({ state: 'error', message: message || 'Meeting capture failed' })
  // Main owns the hide timer (pipeline failPill pattern); skip the hide when
  // a meeting restarted or a dictation took the pill in the meantime.
  setTimeout(() => {
    if (!session && deps && !deps.isPipelineBusy()) deps.setPillState({ state: 'idle' })
  }, 3000)
}

/**
 * "meeting:segment" — one pause-flushed WAV from either stream. Queued on the
 * shared serial chain; the WAV is dropped the moment its task completes
 * (memory bound). Accepted while a session exists — including during the
 * stop-flush window, which is exactly when the final segments arrive.
 */
export function onMeetingSegment(
  wav: ArrayBuffer,
  stream: MeetingStream,
  startedAtMs: number
): void {
  if (!deps || !session) return
  if (stream !== 'you' && stream !== 'them') return // hostile/garbled IPC payload
  const d = deps
  const sess = session
  tail = tail
    .then(async () => {
      // Settings re-read per segment (cheap; mid-meeting dictionary/language
      // edits apply from the next segment on — same policy as the pipeline).
      const settings = d.getSettings()
      let text: string | null = null
      try {
        text = (await d.transcribe(wav, settings)).text.trim()
      } catch {
        // One retry after a beat: covers the cold-sidecar case — each queued
        // segment gets its own retry when its turn comes, so the transcript
        // self-heals as the model warms without ever stalling the queue.
        await delay(d.retryDelayMs ?? RETRY_DELAY_MS)
        try {
          text = (await d.transcribe(wav, settings)).text.trim()
        } catch {
          text = null
        }
      }
      if (text === null) {
        // Failed twice: drop the audio but keep the gap visible.
        d.appendEntry(sess.id, { t: startedAtMs, speaker: stream, text: INAUDIBLE })
        return
      }
      if (!text) return // transcribed silence — no line
      d.appendEntry(sess.id, { t: startedAtMs, speaker: stream, text })
      sess.words += countWords(text)
      maybeWriteMeta(d, sess)
    })
    .catch(() => {}) // the chain itself must never break — appendEntry/store errors included
}

// ─── Meta helpers ────────────────────────────────────────────────────────────

/** Throttled words refresh: at most one meta write per META_WRITE_INTERVAL_MS. */
function maybeWriteMeta(d: MeetingDeps, sess: MeetingSession): void {
  const now = Date.now()
  if (now - sess.lastMetaWriteAt < (d.metaWriteIntervalMs ?? META_WRITE_INTERVAL_MS)) return
  sess.lastMetaWriteAt = now
  writeMetaMerged(d, sess, {})
}

/**
 * Read-merge-write the session's meta with the current word count + a patch.
 * A missing meta (deleted mid-meeting, torn disk) is rebuilt from the session
 * so endedAt/words are never silently lost. Never throws — a store error
 * must not break the queue or stop().
 */
function writeMetaMerged(d: MeetingDeps, sess: MeetingSession, patch: Partial<MeetingMeta>): void {
  try {
    const meta = d.readMeta(sess.id) ?? { id: sess.id, startedAt: sess.startedAt }
    d.writeMeta(sess.id, { ...meta, words: sess.words, ...patch })
  } catch (err) {
    console.warn('[meeting] meta write failed:', err instanceof Error ? err.message : err)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
