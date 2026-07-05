import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeetingEntry, MeetingMeta, OwenFlowSettings, PillState } from '../src/shared/types'
import {
  INAUDIBLE,
  _drainMeetingQueue,
  _resetMeetingChannel,
  activeMeetingId,
  countWords,
  formatMeetingElapsed,
  getMeetingState,
  initMeetingChannel,
  isMeetingActive,
  onCaptureError,
  onCaptureStopped,
  onMeetingSegment,
  onMeetingStateChange,
  startMeeting,
  stopMeeting,
  wrapPillState
} from '../src/main/meeting-channel'

// Minimal settings stub — only passed through to the injected transcribe.
const makeSettings = (): OwenFlowSettings =>
  ({ flowMode: 'normal', dictionary: [], language: '' }) as unknown as OwenFlowSettings

interface Harness {
  deps: {
    setPillState: ReturnType<typeof vi.fn>
    startCapture: ReturnType<typeof vi.fn>
    stopCapture: ReturnType<typeof vi.fn>
    getSettings: () => OwenFlowSettings
    transcribe: ReturnType<typeof vi.fn>
    isPipelineBusy: ReturnType<typeof vi.fn>
    createMeeting: ReturnType<typeof vi.fn>
    appendEntry: ReturnType<typeof vi.fn>
    readMeta: ReturnType<typeof vi.fn>
    writeMeta: ReturnType<typeof vi.fn>
    retryDelayMs: number
    metaWriteIntervalMs: number
    stopFlushTimeoutMs: number
  }
  /** appendEntry log as [id, entry] tuples. */
  appended: Array<[string, MeetingEntry]>
  /** writeMeta log as [id, meta] tuples. */
  metas: Array<[string, MeetingMeta]>
}

function makeHarness(
  transcribeFn?: (wav: ArrayBuffer) => Promise<{ text: string; durationMs: number }>
): Harness {
  const appended: Array<[string, MeetingEntry]> = []
  const metas: Array<[string, MeetingMeta]> = []
  let nextId = 0
  const deps = {
    setPillState: vi.fn(),
    startCapture: vi.fn(),
    // Default stopCapture acknowledges synchronously, like a healthy renderer
    // whose flush segments have all landed (ordered IPC).
    stopCapture: vi.fn(() => onCaptureStopped()),
    getSettings: () => makeSettings(),
    transcribe: vi.fn(transcribeFn ?? (async () => ({ text: 'hello world', durationMs: 1 }))),
    isPipelineBusy: vi.fn(() => false),
    createMeeting: vi.fn(() => `m-${++nextId}`),
    appendEntry: vi.fn((id: string, e: MeetingEntry) => {
      appended.push([id, e])
    }),
    // Behaves like the real store: reads back the last meta written for the
    // id (so merged fields like endedAt survive later words refreshes).
    readMeta: vi.fn((id: string): MeetingMeta | null => {
      for (let i = metas.length - 1; i >= 0; i--) {
        if (metas[i][0] === id) return { ...metas[i][1] }
      }
      return { id, startedAt: 0 }
    }),
    writeMeta: vi.fn((id: string, meta: MeetingMeta) => {
      metas.push([id, meta])
    }),
    retryDelayMs: 0, // no real 3s waits in tests
    metaWriteIntervalMs: 0, // every append refreshes meta (throttle exercised separately)
    stopFlushTimeoutMs: 100
  }
  initMeetingChannel(deps)
  return { deps, appended, metas }
}

const wav = (): ArrayBuffer => new ArrayBuffer(4)

beforeEach(() => {
  _resetMeetingChannel()
})

describe('pure helpers', () => {
  it('countWords splits on whitespace and ignores empties', () => {
    expect(countWords('hello world')).toBe(2)
    expect(countWords('  a  b\tc\nd ')).toBe(4)
    expect(countWords('')).toBe(0)
    expect(countWords('   ')).toBe(0)
  })

  it('formatMeetingElapsed is always h:mm:ss (the tray label shape)', () => {
    expect(formatMeetingElapsed(0)).toBe('0:00:00')
    expect(formatMeetingElapsed(42 * 60_000 + 13_000)).toBe('0:42:13')
    expect(formatMeetingElapsed(3 * 3_600_000 + 5_000)).toBe('3:00:05')
    expect(formatMeetingElapsed(-100)).toBe('0:00:00')
  })
})

describe('start/stop lifecycle', () => {
  it('start creates the store meeting, starts capture, shows the pill, returns true', async () => {
    const h = makeHarness()
    await expect(startMeeting()).resolves.toBe(true)
    expect(h.deps.createMeeting).toHaveBeenCalledTimes(1)
    expect(h.deps.startCapture).toHaveBeenCalledTimes(1)
    expect(h.deps.setPillState).toHaveBeenCalledWith(expect.objectContaining({ state: 'meeting' }))
    expect(isMeetingActive()).toBe(true)
    expect(activeMeetingId()).toBe('m-1')
    expect(getMeetingState().active).toBe(true)
    expect(getMeetingState().startedAt).not.toBeNull()
  })

  it('a second start while active returns false (frozen contract)', async () => {
    const h = makeHarness()
    await expect(startMeeting()).resolves.toBe(true)
    await expect(startMeeting()).resolves.toBe(false)
    expect(h.deps.createMeeting).toHaveBeenCalledTimes(1)
  })

  it('start returns false when the store cannot create the meeting', async () => {
    const h = makeHarness()
    h.deps.createMeeting.mockImplementation(() => {
      throw new Error('disk full')
    })
    await expect(startMeeting()).resolves.toBe(false)
    expect(isMeetingActive()).toBe(false)
  })

  it('start yields the pill to a busy dictation (no meeting push mid-take)', async () => {
    const h = makeHarness()
    h.deps.isPipelineBusy.mockReturnValue(true)
    await startMeeting()
    expect(h.deps.setPillState).not.toHaveBeenCalled()
  })

  it('stop finalizes meta with endedAt/durationMs/words and idles the pill', async () => {
    const h = makeHarness()
    await startMeeting()
    onMeetingSegment(wav(), 'you', 111)
    await _drainMeetingQueue()
    await stopMeeting()
    expect(h.deps.stopCapture).toHaveBeenCalledTimes(1)
    expect(isMeetingActive()).toBe(false)
    const final = h.metas[h.metas.length - 1][1]
    expect(final.endedAt).toBeTypeOf('number')
    expect(final.durationMs).toBeTypeOf('number')
    expect(final.words).toBe(2) // "hello world"
    expect(h.deps.setPillState).toHaveBeenLastCalledWith({ state: 'idle' })
  })

  it('notifies state listeners on start and stop (tray + window pushes)', async () => {
    makeHarness()
    const states: boolean[] = []
    const unsub = onMeetingStateChange((s) => states.push(s.active))
    await startMeeting()
    await stopMeeting()
    expect(states).toEqual([true, false])
    unsub()
  })
})

describe('serial transcription queue', () => {
  it('processes segments strictly serially, interleaved by arrival across streams', async () => {
    let inFlight = 0
    let maxInFlight = 0
    let n = 0
    const h = makeHarness(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return { text: `seg ${++n}`, durationMs: 1 }
    })
    await startMeeting()
    onMeetingSegment(wav(), 'you', 1)
    onMeetingSegment(wav(), 'them', 2)
    onMeetingSegment(wav(), 'you', 3)
    await _drainMeetingQueue()
    // never two transcriptions at once — the sidecar is single-file
    expect(maxInFlight).toBe(1)
    // arrival order preserved across BOTH streams
    expect(h.appended.map(([, e]) => [e.speaker, e.t, e.text])).toEqual([
      ['you', 1, 'seg 1'],
      ['them', 2, 'seg 2'],
      ['you', 3, 'seg 3']
    ])
  })

  it('crash-safety: each segment is appended the moment IT transcribes, not batched', async () => {
    const h = makeHarness()
    await startMeeting()
    onMeetingSegment(wav(), 'you', 1)
    await _drainMeetingQueue()
    // first segment already durable on disk while the meeting keeps running
    expect(h.appended).toHaveLength(1)
    onMeetingSegment(wav(), 'them', 2)
    await _drainMeetingQueue()
    expect(h.appended).toHaveLength(2)
  })

  it('transcribed silence produces no transcript line', async () => {
    const h = makeHarness(async () => ({ text: '   ', durationMs: 1 }))
    await startMeeting()
    onMeetingSegment(wav(), 'you', 1)
    await _drainMeetingQueue()
    expect(h.appended).toHaveLength(0)
  })

  it('segments while no meeting is active are dropped', async () => {
    const h = makeHarness()
    onMeetingSegment(wav(), 'you', 1)
    await _drainMeetingQueue()
    expect(h.deps.transcribe).not.toHaveBeenCalled()
    expect(h.appended).toHaveLength(0)
  })

  it('garbled stream tags from IPC are dropped', async () => {
    const h = makeHarness()
    await startMeeting()
    onMeetingSegment(wav(), 'narrator' as never, 1)
    await _drainMeetingQueue()
    expect(h.appended).toHaveLength(0)
  })
})

describe('failure handling (never stall the queue)', () => {
  it('retries a failed segment once — self-heals when the sidecar warms up', async () => {
    let calls = 0
    const h = makeHarness(async () => {
      calls++
      if (calls === 1) throw new Error('Transcriber not ready (starting)')
      return { text: 'now it works', durationMs: 1 }
    })
    await startMeeting()
    onMeetingSegment(wav(), 'you', 1)
    await _drainMeetingQueue()
    expect(calls).toBe(2)
    expect(h.appended[0][1].text).toBe('now it works')
  })

  it('drops a twice-failed segment as [inaudible] and keeps going', async () => {
    let calls = 0
    const h = makeHarness(async () => {
      calls++
      if (calls <= 2) throw new Error('sidecar down')
      return { text: 'recovered later', durationMs: 1 }
    })
    await startMeeting()
    onMeetingSegment(wav(), 'you', 1) // fails twice
    onMeetingSegment(wav(), 'them', 2) // succeeds (call 3)
    await _drainMeetingQueue()
    expect(h.appended.map(([, e]) => e.text)).toEqual([INAUDIBLE, 'recovered later'])
    // the gap marker never inflates the word count
    const lastMeta = h.metas[h.metas.length - 1][1]
    expect(lastMeta.words).toBe(2) // "recovered later" only
  })

  it('a throwing store append cannot break the chain for later segments', async () => {
    const h = makeHarness()
    h.deps.appendEntry.mockImplementationOnce(() => {
      throw new Error('disk hiccup')
    })
    await startMeeting()
    onMeetingSegment(wav(), 'you', 1) // append throws — swallowed
    onMeetingSegment(wav(), 'you', 2) // must still process
    await _drainMeetingQueue()
    expect(h.deps.appendEntry).toHaveBeenCalledTimes(2)
  })

  it('capture error ends the meeting: meta finalized, pill shows the error', async () => {
    const h = makeHarness()
    await startMeeting()
    onCaptureError('Mic capture failed: denied')
    expect(isMeetingActive()).toBe(false)
    const final = h.metas[h.metas.length - 1][1]
    expect(final.endedAt).toBeTypeOf('number')
    expect(h.deps.setPillState).toHaveBeenLastCalledWith({
      state: 'error',
      message: 'Mic capture failed: denied'
    })
  })
})

describe('generation guard (stop/start cycles cannot interleave)', () => {
  it('a slow segment from a stopped meeting still lands in ITS meeting, never the new one', async () => {
    let release: (() => void) | null = null
    let calls = 0
    const h = makeHarness(async () => {
      calls++
      if (calls === 1) {
        await new Promise<void>((r) => (release = r))
        return { text: 'old meeting words', durationMs: 1 }
      }
      return { text: 'new meeting words', durationMs: 1 }
    })

    await startMeeting() // m-1
    onMeetingSegment(wav(), 'you', 1) // hangs inside transcribe
    await stopMeeting() // m-1 over; its segment still in flight
    await startMeeting() // m-2
    onMeetingSegment(wav(), 'them', 2) // queued behind the hung one

    release!()
    await _drainMeetingQueue()

    expect(h.appended).toEqual([
      ['m-1', { t: 1, speaker: 'you', text: 'old meeting words' }],
      ['m-2', { t: 2, speaker: 'them', text: 'new meeting words' }]
    ])
    // the late words were folded back into m-1's meta after the drain
    const m1Metas = h.metas.filter(([id]) => id === 'm-1')
    expect(m1Metas[m1Metas.length - 1][1].words).toBe(3)
  })

  it('stop is idempotent and start-after-stop uses a fresh meeting id', async () => {
    const h = makeHarness()
    await startMeeting()
    await stopMeeting()
    await stopMeeting() // no-op
    expect(h.deps.stopCapture).toHaveBeenCalledTimes(1)
    await startMeeting()
    expect(activeMeetingId()).toBe('m-2')
  })
})

describe('wrapPillState (idle re-assert)', () => {
  it('turns idle pushes into the meeting state while a meeting runs', async () => {
    makeHarness()
    const base = vi.fn()
    const wrapped = wrapPillState(base as (s: PillState) => void)
    await startMeeting()
    const startedAt = getMeetingState().startedAt
    wrapped({ state: 'idle' })
    expect(base).toHaveBeenCalledWith({ state: 'meeting', startedAt })
  })

  it('dictation states pass through untouched (they take priority)', async () => {
    makeHarness()
    const base = vi.fn()
    const wrapped = wrapPillState(base as (s: PillState) => void)
    await startMeeting()
    wrapped({ state: 'recording' })
    wrapped({ state: 'done' })
    expect(base).toHaveBeenNthCalledWith(1, { state: 'recording' })
    expect(base).toHaveBeenNthCalledWith(2, { state: 'done' })
  })

  it('passes idle through when no meeting is active', () => {
    makeHarness()
    const base = vi.fn()
    const wrapped = wrapPillState(base as (s: PillState) => void)
    wrapped({ state: 'idle' })
    expect(base).toHaveBeenCalledWith({ state: 'idle' })
  })
})

describe('meta write throttle', () => {
  it('skips per-segment meta writes inside the throttle window, but stop always writes', async () => {
    const h = makeHarness()
    h.deps.metaWriteIntervalMs = 60_000 // nothing mid-meeting beats the throttle
    await startMeeting()
    onMeetingSegment(wav(), 'you', 1)
    onMeetingSegment(wav(), 'you', 2)
    await _drainMeetingQueue()
    const midMeetingWrites = h.metas.length
    await stopMeeting()
    expect(h.metas.length).toBeGreaterThan(midMeetingWrites) // the stop write
    const final = h.metas[h.metas.length - 1][1]
    expect(final.words).toBe(4) // both segments counted even without mid writes
    expect(final.endedAt).toBeTypeOf('number')
  })
})
