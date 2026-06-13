import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelDictation,
  initPipeline,
  isDictating,
  isDictationActive,
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
    getForegroundApp: vi.fn(async () => null),
    enqueueTranscription: vi.fn()
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
