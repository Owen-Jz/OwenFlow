import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelDictation,
  initPipeline,
  isDictating,
  isDictationActive,
  onRecorderSegment,
  startDictation,
  stopDictation,
  type PipelineDeps
} from '../src/main/pipeline'
import type { OwenFlowSettings, PillState } from '../src/shared/types'

const baseSettings = (patch: Partial<OwenFlowSettings> = {}): OwenFlowSettings => ({
  hotkey: 'RightCtrl',
  mode: 'hold',
  flowMode: 'normal',
  model: 'small',
  language: 'en',
  cleanupEnabled: true,
  cleanupIntensity: 'medium',
  cleanupProvider: 'groq',
  minimaxApiKey: 'key',
  minimaxGroupId: '',
  groqApiKey: 'key',
  groqModel: 'llama-3.3-70b-versatile',
  dictionary: [],
  snippets: [],
  translateTarget: 'English',
  sessionTones: [],
  activeSession: '',
  appProfilesEnabled: false,
  profiles: [],
  launchOnStartup: false,
  theme: 'dark',
  ...patch
})

interface MockedDeps extends PipelineDeps {
  setPillState: ReturnType<typeof vi.fn>
  recorderStart: ReturnType<typeof vi.fn>
  recorderStop: ReturnType<typeof vi.fn>
  appendHistory: ReturnType<typeof vi.fn>
  transcribe: ReturnType<typeof vi.fn>
  cleanup: ReturnType<typeof vi.fn>
  inject: ReturnType<typeof vi.fn>
  pressEnter: ReturnType<typeof vi.fn>
  getForegroundApp: ReturnType<typeof vi.fn>
  enqueueTranscription: ReturnType<typeof vi.fn>
}

function makeDeps(settings: OwenFlowSettings, callOrder: string[]): MockedDeps {
  const wav = new ArrayBuffer(32)
  return {
    setPillState: vi.fn(),
    recorderStart: vi.fn(() => void callOrder.push('record')),
    recorderStop: vi.fn(async () => {
      callOrder.push('recorderStop')
      return wav
    }),
    getSettings: () => settings,
    appendHistory: vi.fn(() => void callOrder.push('history')),
    transcribe: vi.fn(async () => {
      callOrder.push('transcribe')
      return { text: ' um hello wisper world ', durationMs: 420 }
    }),
    cleanup: vi.fn(async (raw: string) => {
      callOrder.push('cleanup')
      return raw.replace(/\bum\s+/i, '').trim()
    }),
    inject: vi.fn(async () => void callOrder.push('inject')),
    pressEnter: vi.fn(async () => void callOrder.push('pressEnter')),
    getForegroundApp: vi.fn(async () => null),
    enqueueTranscription: vi.fn()
  }
}

/** Minimal full-pipeline deps with sensible defaults; accepts per-test overrides. */
function makePipelineDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  const wav = new ArrayBuffer(32)
  return {
    setPillState: vi.fn(),
    recorderStart: vi.fn(),
    recorderStop: vi.fn(async () => wav),
    getSettings: () => baseSettings(),
    appendHistory: vi.fn(),
    transcribe: vi.fn(async () => ({ text: 'hello', durationMs: 1 })),
    cleanup: vi.fn(async (raw: string) => raw),
    inject: vi.fn(async () => {}),
    pressEnter: vi.fn(async () => {}),
    getForegroundApp: vi.fn(async () => null),
    enqueueTranscription: vi.fn(),
    ...overrides
  }
}

const pillStates = (deps: MockedDeps): PillState[] =>
  deps.setPillState.mock.calls.map(([s]) => s as PillState)

async function runDictation(deps: MockedDeps): Promise<void> {
  initPipeline(deps)
  await startDictation()
  await stopDictation()
}

describe('pipeline', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('runs record → transcribe → cleanup → inject → history in order', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings({ dictionary: ['wisper=>whisper'] }), order)
    await runDictation(deps)

    expect(order).toEqual(['record', 'recorderStop', 'transcribe', 'cleanup', 'inject', 'history'])
    // dictionary replacement applied after cleanup
    expect(deps.inject).toHaveBeenCalledWith('hello whisper world')
    expect(deps.appendHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        raw: 'um hello wisper world',
        final: 'hello whisper world'
      })
    )
    const states = pillStates(deps).map((s) => s.state)
    expect(states).toEqual(['recording', 'transcribing', 'done'])
    expect(isDictating()).toBe(false)
  })

  it('normal mode skips cleanup when cleanupEnabled is false', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings({ flowMode: 'normal', cleanupEnabled: false }), order)
    await runDictation(deps)
    expect(deps.cleanup).not.toHaveBeenCalled()
    expect(deps.inject).toHaveBeenCalledWith('um hello wisper world')
  })

  it('normal mode skips cleanup when cleanupIntensity is none (raw verbatim)', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings({ flowMode: 'normal', cleanupIntensity: 'none' }), order)
    await runDictation(deps)
    expect(deps.cleanup).not.toHaveBeenCalled()
    expect(deps.inject).toHaveBeenCalledWith('um hello wisper world')
  })

  it('normal mode wants cleanup at every non-none intensity', async () => {
    for (const cleanupIntensity of ['light', 'medium', 'high'] as const) {
      const deps = makeDeps(baseSettings({ flowMode: 'normal', cleanupIntensity }), [])
      await runDictation(deps)
      expect(deps.cleanup).toHaveBeenCalledTimes(1)
      // The effective settings (intensity included) reach the cleanup dep.
      expect(deps.cleanup.mock.calls[0][1].cleanupIntensity).toBe(cleanupIntensity)
    }
  })

  it('vibe mode runs cleanup even when cleanupIntensity is none (modes ignore intensity)', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings({ flowMode: 'vibe', cleanupIntensity: 'none' }), order)
    await runDictation(deps)
    expect(deps.cleanup).toHaveBeenCalledTimes(1)
  })

  it('vibe mode runs cleanup even when cleanupEnabled is false', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings({ flowMode: 'vibe', cleanupEnabled: false }), order)
    await runDictation(deps)
    expect(deps.cleanup).toHaveBeenCalledTimes(1)
    expect(deps.inject).toHaveBeenCalledWith('hello wisper world')
  })

  it('formal mode runs cleanup even when cleanupEnabled is false', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings({ flowMode: 'formal', cleanupEnabled: false }), order)
    await runDictation(deps)
    expect(deps.cleanup).toHaveBeenCalledTimes(1)
  })

  it('vibe mode falls back to raw when the cleanup dep throws', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings({ flowMode: 'vibe', cleanupEnabled: false }), order)
    deps.cleanup.mockRejectedValue(new Error('boom'))
    await runDictation(deps)
    expect(deps.inject).toHaveBeenCalledWith('um hello wisper world')
  })

  it('falls back to raw when the cleanup dep throws', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings(), order)
    deps.cleanup.mockRejectedValue(new Error('boom'))
    await runDictation(deps)
    expect(deps.inject).toHaveBeenCalledWith('um hello wisper world')
  })

  it('empty transcript short-circuits: pill "—", no inject, no history', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings(), order)
    deps.transcribe.mockResolvedValue({ text: '   ', durationMs: 100 })
    await runDictation(deps)

    expect(deps.cleanup).not.toHaveBeenCalled()
    expect(deps.inject).not.toHaveBeenCalled()
    expect(deps.appendHistory).not.toHaveBeenCalled()
    const last = pillStates(deps).at(-1)
    expect(last).toEqual({ state: 'error', message: '—' })
  })

  it('transcription failure → pill error, nothing injected', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings(), order)
    delete (deps as Partial<typeof deps>).enqueueTranscription // no enqueue dep → failPill path
    deps.transcribe.mockRejectedValue(new Error('Transcriber not ready (starting)'))
    await runDictation(deps)

    expect(deps.inject).not.toHaveBeenCalled()
    expect(deps.appendHistory).not.toHaveBeenCalled()
    const last = pillStates(deps).at(-1)
    expect(last?.state).toBe('error')
    expect(last?.message).toContain('Transcriber not ready')
  })

  it('transcribe failure enqueues (does not failPill) when enqueue dep present', async () => {
    const deps = makeDeps(baseSettings(), [])
    deps.transcribe.mockRejectedValue(new Error('Transcriber not ready (starting)'))
    await runDictation(deps)
    expect(deps.enqueueTranscription).toHaveBeenCalledTimes(1)
    expect(deps.inject).not.toHaveBeenCalled()
    expect(deps.appendHistory).not.toHaveBeenCalled()
  })

  it('injector failure → history still recorded, pill shows the paste error', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings({ cleanupEnabled: false }), order)
    deps.inject.mockRejectedValue(
      Object.assign(new Error('Copied — paste manually'), { name: 'PasteFailedError' })
    )
    await runDictation(deps)

    expect(deps.appendHistory).toHaveBeenCalledTimes(1)
    const last = pillStates(deps).at(-1)
    expect(last).toEqual({ state: 'error', message: 'Copied — paste manually' })
  })

  it('recorder failure → pill error, transcribe never called', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings(), order)
    deps.recorderStop.mockRejectedValue(new Error('Recorder timed out'))
    await runDictation(deps)

    expect(deps.transcribe).not.toHaveBeenCalled()
    const last = pillStates(deps).at(-1)
    expect(last).toEqual({ state: 'error', message: 'Recorder timed out' })
  })

  it('startDictation is a no-op while already dictating', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings(), order)
    initPipeline(deps)
    await startDictation()
    await startDictation()
    expect(deps.recorderStart).toHaveBeenCalledTimes(1)
    await stopDictation()
    await stopDictation() // second stop is a no-op too
    expect(deps.transcribe).toHaveBeenCalledTimes(1)
  })

  it('snippet match short-circuits: injects expansion verbatim, no cleanup/dictionary', async () => {
    const order: string[] = []
    const deps = makeDeps(
      baseSettings({ snippets: ['sign off=>Best,\\nOwen'], dictionary: ['Owen=>OWEN'] }),
      order
    )
    deps.transcribe.mockResolvedValue({ text: 'sign off', durationMs: 10 })
    await runDictation(deps)
    expect(deps.cleanup).not.toHaveBeenCalled()
    expect(deps.inject).toHaveBeenCalledWith('Best,\nOwen') // dictionary 'Owen=>OWEN' NOT applied
  })

  it('active session overrides flow mode and auto-tags history', async () => {
    const order: string[] = []
    const deps = makeDeps(
      baseSettings({
        flowMode: 'normal',
        cleanupEnabled: false,
        sessionTones: ['client=>formal'],
        activeSession: 'client'
      }),
      order
    )
    deps.transcribe.mockResolvedValue({ text: 'please review the attached', durationMs: 10 })
    await runDictation(deps)
    expect(deps.cleanup).toHaveBeenCalledTimes(1) // formal runs despite cleanupEnabled:false
    expect(deps.cleanup.mock.calls[0][1].flowMode).toBe('formal') // effective settings passed
    const entry = deps.appendHistory.mock.calls.at(-1)[0]
    expect(entry.tags).toContain('client')
  })

  it('applies a matching app profile: pins mode, records app, transforms after dictionary', async () => {
    const deps = makeDeps(baseSettings({
      appProfilesEnabled: true,
      flowMode: 'normal', cleanupEnabled: false,
      profiles: [{ match: ['Code'], flowMode: 'vibe', stripTrailingPeriod: true }]
    }), [])
    deps.getForegroundApp = vi.fn(async () => 'Code')
    deps.transcribe.mockResolvedValue({ text: 'add a helper function.', durationMs: 10 })
    deps.cleanup.mockImplementation(async (raw: string) => raw) // passthrough so we can see transforms
    await runDictation(deps)
    expect(deps.cleanup).toHaveBeenCalled()
    expect(deps.cleanup.mock.calls[0][1].flowMode).toBe('vibe')          // profile pin
    expect(deps.inject).toHaveBeenCalledWith('add a helper function')    // trailing period stripped
    const entry = deps.appendHistory.mock.calls.at(-1)[0]
    expect(entry.app).toBe('Code')
  })

  it('reads editor symbols at start and feeds them to transcribe at stop', async () => {
    const symbols = vi.fn().mockResolvedValue(['userId', 'fetchUser'])
    const transcribe = vi.fn().mockResolvedValue({ text: 'hello', durationMs: 1 })
    const deps = { ...makeDeps(baseSettings({ cleanupEnabled: false }), []), readEditorSymbols: symbols, transcribe }
    initPipeline(deps)
    await startDictation()
    expect(symbols).toHaveBeenCalledOnce() // fired at start, not stop
    await stopDictation()
    const ctx = transcribe.mock.calls[0][2] as string
    expect(ctx).toContain('userId')
    expect(ctx).toContain('fetchUser')
  })

  it('does not block stop when the symbol read hangs past the cap', async () => {
    vi.useFakeTimers()
    const symbols = vi.fn().mockReturnValue(new Promise<string[]>(() => {})) // never resolves
    const transcribe = vi.fn().mockResolvedValue({ text: 'hi', durationMs: 1 })
    const deps = { ...makeDeps(baseSettings({ cleanupEnabled: false }), []), readEditorSymbols: symbols, transcribe }
    initPipeline(deps)
    await startDictation()
    const stopped = stopDictation()
    await vi.advanceTimersByTimeAsync(300) // past the 250ms cap
    await stopped
    expect(transcribe).toHaveBeenCalledOnce() // proceeded without symbols
  })

  it('skips the symbol read entirely when the dep is absent', async () => {
    const transcribe = vi.fn().mockResolvedValue({ text: 'hi', durationMs: 1 })
    const deps = { ...makeDeps(baseSettings({ cleanupEnabled: false }), []), transcribe }
    initPipeline(deps)
    await startDictation()
    await stopDictation()
    expect(transcribe).toHaveBeenCalledOnce()
  })

  it('session pick beats an app profile mode', async () => {
    const deps = makeDeps(baseSettings({
      appProfilesEnabled: true,
      sessionTones: ['client=>formal'], activeSession: 'client',
      profiles: [{ match: ['Code'], flowMode: 'vibe' }]
    }), [])
    deps.getForegroundApp = vi.fn(async () => 'Code')
    deps.transcribe.mockResolvedValue({ text: 'please review the attached', durationMs: 10 })
    await runDictation(deps)
    expect(deps.cleanup.mock.calls[0][1].flowMode).toBe('formal')
  })

  it('passes focused-field context to cleanup as extra system guidance', async () => {
    const focus = vi.fn().mockResolvedValue({ text: 'Hi Tunde, about the Nomba invoice', site: 'mail.google.com' })
    const cleanup = vi.fn().mockResolvedValue('cleaned')
    initPipeline(makePipelineDeps({
      readFocusContext: focus,
      transcribe: vi.fn().mockResolvedValue({ text: 'thanks for the update', durationMs: 1 }),
      cleanup
    }))
    await startDictation()
    await stopDictation()
    const extra = cleanup.mock.calls[0][2] as string
    expect(extra).toContain('Tunde')        // surrounding text available for name spelling
    expect(extra).toContain('mail.google.com') // site register hint
  })

  it('cleans normally when focus context is empty (no dep / blank read)', async () => {
    const cleanup = vi.fn().mockResolvedValue('cleaned')
    initPipeline(makePipelineDeps({
      readFocusContext: vi.fn().mockResolvedValue({ text: '', site: null }),
      transcribe: vi.fn().mockResolvedValue({ text: 'hello there world', durationMs: 1 }),
      cleanup
    }))
    await startDictation()
    await stopDictation()
    expect(cleanup.mock.calls[0][2]).toBeUndefined() // empty context → no extra system
  })
})

describe('streaming pre-transcription (normal one-shot path)', () => {
  /** Flush microtasks until cond() holds (bounded) — background segment work is promise-based. */
  async function flushUntil(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 50 && !cond(); i++) await Promise.resolve()
    expect(cond()).toBe(true)
  }

  it('segments flushed while recording pre-transcribe; stop joins them + runs the tail ONCE', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings({ cleanupEnabled: false }), order)
    const texts = ['first segment', 'second segment', 'final bit']
    let call = 0
    deps.transcribe.mockImplementation(async () => {
      order.push('transcribe')
      return { text: texts[call++], durationMs: 50 }
    })
    initPipeline(deps)

    await startDictation()
    onRecorderSegment(new ArrayBuffer(8))
    onRecorderSegment(new ArrayBuffer(16))
    // Both background transcriptions complete BEFORE the hotkey is released —
    // that's the whole latency win.
    await flushUntil(() => call === 2)
    await stopDictation()

    // 3 transcribes (2 background + final remainder) but ONE cleanup-tail:
    // one inject, one history entry, joined with single spaces.
    expect(deps.transcribe).toHaveBeenCalledTimes(3)
    expect(deps.inject).toHaveBeenCalledTimes(1)
    expect(deps.inject).toHaveBeenCalledWith('first segment second segment final bit')
    expect(deps.appendHistory).toHaveBeenCalledTimes(1)
    expect(deps.appendHistory).toHaveBeenCalledWith(
      expect.objectContaining({ raw: 'first segment second segment final bit' })
    )
    expect(pillStates(deps).at(-1)).toEqual({ state: 'done' })
  })

  it('threads boundary context (prior transcript tail) into each segment after the first', async () => {
    const deps = makeDeps(baseSettings({ cleanupEnabled: false }), [])
    const texts = ['one two three', 'four five', 'six']
    const contexts: (string | undefined)[] = []
    deps.transcribe.mockImplementation(async (_wav: ArrayBuffer, _s: unknown, context?: string) => {
      contexts.push(context)
      return { text: texts[contexts.length - 1], durationMs: 10 }
    })
    initPipeline(deps)

    await startDictation()
    onRecorderSegment(new ArrayBuffer(8))
    onRecorderSegment(new ArrayBuffer(16))
    await stopDictation()

    expect(contexts).toEqual([undefined, 'one two three', 'one two three four five'])
    expect(deps.inject).toHaveBeenCalledWith('one two three four five six')
  })

  it('a mid-recording segment failure recovers via the stop-time retry — still pastes normally', async () => {
    const deps = makeDeps(baseSettings({ cleanupEnabled: false }), [])
    let call = 0
    deps.transcribe.mockImplementation(async () => {
      call++
      if (call === 1) throw new Error('sidecar busy') // background attempt fails
      return { text: call === 2 ? 'first segment' : 'final bit', durationMs: 10 }
    })
    initPipeline(deps)

    await startDictation()
    onRecorderSegment(new ArrayBuffer(8))
    await flushUntil(() => call === 1)
    await stopDictation()

    // Retry on stop (call 2) + final remainder (call 3) → normal paste path.
    expect(deps.transcribe).toHaveBeenCalledTimes(3)
    expect(deps.inject).toHaveBeenCalledWith('first segment final bit')
    expect(deps.enqueueTranscription).not.toHaveBeenCalled()
    expect(pillStates(deps).at(-1)).toEqual({ state: 'done' })
  })

  it('a segment failing its retry too → ALL segment WAVs queued in order, nothing pasted', async () => {
    const deps = makeDeps(baseSettings(), [])
    deps.transcribe.mockRejectedValue(new Error('Transcriber not ready (starting)'))
    initPipeline(deps)

    await startDictation()
    onRecorderSegment(new ArrayBuffer(8))
    onRecorderSegment(new ArrayBuffer(16))
    await stopDictation()

    // 2 pause segments + the final remainder, each enqueued for recovery
    // (History 'recovered' entries, in order) — never a partial paste.
    expect(deps.enqueueTranscription).toHaveBeenCalledTimes(3)
    expect(deps.inject).not.toHaveBeenCalled()
    expect(deps.appendHistory).not.toHaveBeenCalled()
    const last = pillStates(deps).at(-1)
    expect(last?.state).toBe('error')
    expect(last?.message).toContain('Queued')
  })

  it('escape discards in-flight segment transcriptions — late result never pastes', async () => {
    const deps = makeDeps(baseSettings(), [])
    let resolveSeg!: (r: { text: string; durationMs: number }) => void
    deps.transcribe.mockImplementation(
      () => new Promise<{ text: string; durationMs: number }>((r) => (resolveSeg = r))
    )
    initPipeline(deps)

    await startDictation()
    onRecorderSegment(new ArrayBuffer(8))
    await flushUntil(() => deps.transcribe.mock.calls.length === 1)

    expect(cancelDictation()).toBe(true)
    resolveSeg({ text: 'late segment that must not paste', durationMs: 999 })
    await flushUntil(() => !isDictationActive())

    // A segment arriving after the cancel is dropped, not pre-transcribed.
    onRecorderSegment(new ArrayBuffer(16))
    await stopDictation() // no-op — dictation was cancelled
    expect(deps.transcribe).toHaveBeenCalledTimes(1)
    expect(deps.inject).not.toHaveBeenCalled()
    expect(deps.appendHistory).not.toHaveBeenCalled()
    expect(pillStates(deps).at(-1)).toEqual({ state: 'idle' })
  })

  it('no segments flushed (short dictation) behaves exactly like the old single-shot path', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings({ cleanupEnabled: false }), order)
    initPipeline(deps)
    await startDictation()
    await stopDictation()
    expect(order).toEqual(['record', 'recorderStop', 'transcribe', 'inject', 'history'])
    expect(deps.transcribe).toHaveBeenCalledTimes(1)
    expect(deps.inject).toHaveBeenCalledWith('um hello wisper world')
  })

  it('a background segment pushed during recording does NOT receive the symbol context', async () => {
    // Regression guard for the Path-B leak: a background segment queued in
    // the serial chain must NEVER observe the editor-symbol context that
    // stopDictation resolves at hotkey release. Only the final remainder
    // (the segment appended inside finish()) should carry it.
    const symbols = vi.fn().mockResolvedValue(['userId', 'fetchUser'])
    const capturedContexts: (string | undefined)[] = []
    const transcribe = vi.fn().mockImplementation(
      async (_wav: ArrayBuffer, _s: unknown, ctx?: string) => {
        capturedContexts.push(ctx)
        return { text: 'hello world', durationMs: 10 }
      }
    )
    const deps = {
      ...makeDeps(baseSettings({ cleanupEnabled: false }), []),
      readEditorSymbols: symbols,
      transcribe
    }
    initPipeline(deps)

    await startDictation()
    onRecorderSegment(new ArrayBuffer(8)) // push one background segment
    // Wait for the background transcription to finish before releasing the
    // hotkey — this is the normal latency-win path.
    await flushUntil(() => transcribe.mock.calls.length === 1)
    await stopDictation()

    // Two transcribe calls: background segment (index 0) + final remainder (index 1).
    expect(transcribe).toHaveBeenCalledTimes(2)
    // Background segment: boundary context only — no "Code identifiers" prefix.
    expect(capturedContexts[0] ?? '').not.toContain('Code identifiers')
    // Final remainder: symbol context prepended (plus boundary context tail).
    expect(capturedContexts[1]).toContain('userId')
    expect(capturedContexts[1]).toContain('fetchUser')
  })
})

describe('press enter voice command', () => {
  it('trailing "press enter" strips the phrase, pastes, then presses Enter (in that order)', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings({ cleanupEnabled: false }), order)
    deps.transcribe.mockImplementation(async () => {
      order.push('transcribe')
      return { text: 'reply sounds good press enter', durationMs: 10 }
    })
    await runDictation(deps)

    expect(deps.inject).toHaveBeenCalledWith('reply sounds good')
    expect(deps.pressEnter).toHaveBeenCalledTimes(1)
    // Enter fires strictly AFTER the successful paste, never before.
    expect(order).toEqual(['record', 'recorderStop', 'transcribe', 'inject', 'pressEnter', 'history'])
    // History gets the stripped text, not the spoken command.
    const entry = deps.appendHistory.mock.calls.at(-1)[0]
    expect(entry.final).toBe('reply sounds good')
    expect(pillStates(deps).at(-1)).toEqual({ state: 'done' })
  })

  it('detects the command on the POST-cleanup text ("… Press enter.")', async () => {
    const deps = makeDeps(baseSettings(), [])
    deps.transcribe.mockResolvedValue({ text: 'um sounds good press enter', durationMs: 10 })
    deps.cleanup.mockResolvedValue('Sounds good. Press enter.')
    await runDictation(deps)
    expect(deps.inject).toHaveBeenCalledWith('Sounds good.')
    expect(deps.pressEnter).toHaveBeenCalledTimes(1)
  })

  it('mid-sentence "press enter" does not trigger — text pastes untouched', async () => {
    const deps = makeDeps(baseSettings({ cleanupEnabled: false }), [])
    deps.transcribe.mockResolvedValue({ text: 'press enter to submit the form', durationMs: 10 })
    await runDictation(deps)
    expect(deps.inject).toHaveBeenCalledWith('press enter to submit the form')
    expect(deps.pressEnter).not.toHaveBeenCalled()
  })

  it('inject failure → Enter is NEVER pressed (would submit stale text)', async () => {
    const deps = makeDeps(baseSettings({ cleanupEnabled: false }), [])
    deps.transcribe.mockResolvedValue({ text: 'send it press enter', durationMs: 10 })
    deps.inject.mockRejectedValue(new Error('Copied — paste manually'))
    await runDictation(deps)
    expect(deps.pressEnter).not.toHaveBeenCalled()
    // stripped text still recorded in history (clipboard fallback path)
    const entry = deps.appendHistory.mock.calls.at(-1)[0]
    expect(entry.final).toBe('send it')
  })

  it('pressEnter failure is swallowed: paste already landed, pipeline still succeeds', async () => {
    const deps = makeDeps(baseSettings({ cleanupEnabled: false }), [])
    deps.transcribe.mockResolvedValue({ text: 'send it press enter', durationMs: 10 })
    deps.pressEnter.mockRejectedValue(new Error('SendInput failed'))
    await runDictation(deps)
    expect(deps.inject).toHaveBeenCalledWith('send it')
    expect(deps.appendHistory).toHaveBeenCalledTimes(1)
    expect(pillStates(deps).at(-1)).toEqual({ state: 'done' })
  })

  it('utterance that is ONLY "press enter" skips the paste and just presses Enter', async () => {
    const deps = makeDeps(baseSettings({ cleanupEnabled: false }), [])
    deps.transcribe.mockResolvedValue({ text: 'press enter', durationMs: 10 })
    await runDictation(deps)
    expect(deps.inject).not.toHaveBeenCalled()
    expect(deps.pressEnter).toHaveBeenCalledTimes(1)
    expect(pillStates(deps).at(-1)).toEqual({ state: 'done' })
  })

  it('missing pressEnter dep: phrase still stripped, dictation completes normally', async () => {
    const deps = makeDeps(baseSettings({ cleanupEnabled: false }), [])
    delete (deps as Partial<typeof deps>).pressEnter // dep is optional
    deps.transcribe.mockResolvedValue({ text: 'sounds good press enter', durationMs: 10 })
    await runDictation(deps)
    expect(deps.inject).toHaveBeenCalledWith('sounds good')
    expect(pillStates(deps).at(-1)).toEqual({ state: 'done' })
  })
})

describe('escape cancel', () => {
  /** Flush microtasks until cond() holds (bounded) — makes in-flight tests deterministic. */
  async function flushUntil(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 50 && !cond(); i++) await Promise.resolve()
    expect(cond()).toBe(true)
  }

  it('cancel while recording: audio discarded, nothing transcribed/injected/recorded', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings(), order)
    initPipeline(deps)

    await startDictation()
    expect(isDictationActive()).toBe(true)

    expect(cancelDictation()).toBe(true)
    expect(isDictating()).toBe(false)
    expect(isDictationActive()).toBe(false)
    // recorder stopped so the mic releases (result discarded)
    await Promise.resolve() // flush the fire-and-forget recorderStop
    expect(deps.recorderStop).toHaveBeenCalledTimes(1)
    // pill hidden immediately
    expect(pillStates(deps).at(-1)).toEqual({ state: 'idle' })

    // a stop after cancel is a no-op — nothing runs
    await stopDictation()
    expect(deps.transcribe).not.toHaveBeenCalled()
    expect(deps.inject).not.toHaveBeenCalled()
    expect(deps.appendHistory).not.toHaveBeenCalled()
  })

  it('cancel while transcribing: late sidecar result is ignored, no inject, no history', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings(), order)
    // transcription resolves only when WE say so (after the cancel)
    let resolveTranscribe!: (r: { text: string; durationMs: number }) => void
    deps.transcribe.mockImplementation(
      () => new Promise((resolve) => (resolveTranscribe = resolve))
    )
    initPipeline(deps)

    await startDictation()
    const stopPromise = stopDictation() // in-flight: awaiting the sidecar
    await flushUntil(() => deps.transcribe.mock.calls.length === 1)
    expect(isDictationActive()).toBe(true)

    expect(cancelDictation()).toBe(true)
    expect(isDictationActive()).toBe(false)

    // sidecar responds LATE, after the cancel — must be ignored entirely
    resolveTranscribe({ text: 'late response that must not paste', durationMs: 999 })
    await stopPromise

    expect(deps.cleanup).not.toHaveBeenCalled()
    expect(deps.inject).not.toHaveBeenCalled()
    expect(deps.appendHistory).not.toHaveBeenCalled()
    // no done/error state after the cancel — pill stays hidden
    expect(pillStates(deps).at(-1)).toEqual({ state: 'idle' })
  })

  it('cancel while cleanup is in flight: cleaned text never pastes', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings(), order)
    let resolveCleanup!: (s: string) => void
    deps.cleanup.mockImplementation(() => new Promise((resolve) => (resolveCleanup = resolve)))
    initPipeline(deps)

    await startDictation()
    const stopPromise = stopDictation()
    await flushUntil(() => deps.cleanup.mock.calls.length === 1)

    cancelDictation()
    resolveCleanup('cleaned text that must not paste')
    await stopPromise

    expect(deps.inject).not.toHaveBeenCalled()
    expect(deps.appendHistory).not.toHaveBeenCalled()
  })

  it('cancel with nothing active is a no-op', () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings(), order)
    initPipeline(deps)
    expect(cancelDictation()).toBe(false)
    expect(deps.setPillState).not.toHaveBeenCalled()
    expect(deps.recorderStop).not.toHaveBeenCalled()
  })

  it('a fresh dictation after a cancel runs end-to-end normally', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings({ cleanupEnabled: false }), order)
    initPipeline(deps)

    await startDictation()
    cancelDictation()

    await startDictation()
    await stopDictation()
    expect(deps.inject).toHaveBeenCalledTimes(1)
    expect(deps.inject).toHaveBeenCalledWith('um hello wisper world')
    expect(deps.appendHistory).toHaveBeenCalledTimes(1)
    expect(pillStates(deps).at(-1)).toEqual({ state: 'done' })
  })
})
