import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  initPipeline,
  isDictating,
  startDictation,
  stopDictation,
  type PipelineDeps
} from '../src/main/pipeline'
import type { OwenFlowSettings, PillState } from '../src/shared/types'

const baseSettings = (patch: Partial<OwenFlowSettings> = {}): OwenFlowSettings => ({
  hotkey: 'RightCtrl',
  mode: 'hold',
  model: 'small',
  language: 'en',
  cleanupEnabled: true,
  minimaxApiKey: 'key',
  minimaxGroupId: '',
  dictionary: [],
  launchOnStartup: false,
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
    inject: vi.fn(async () => void callOrder.push('inject'))
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

  it('skips cleanup when cleanupEnabled is false', async () => {
    const order: string[] = []
    const deps = makeDeps(baseSettings({ cleanupEnabled: false }), order)
    await runDictation(deps)
    expect(deps.cleanup).not.toHaveBeenCalled()
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
    deps.transcribe.mockRejectedValue(new Error('Transcriber not ready (starting)'))
    await runDictation(deps)

    expect(deps.inject).not.toHaveBeenCalled()
    expect(deps.appendHistory).not.toHaveBeenCalled()
    const last = pillStates(deps).at(-1)
    expect(last?.state).toBe('error')
    expect(last?.message).toContain('Transcriber not ready')
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
})
