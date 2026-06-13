import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { OwenFlowSettings } from '../src/shared/types'
import {
  initContinuousChannel,
  isContinuousActive,
  startContinuous,
  onSegment,
  stopContinuous,
  onDone,
  cancelContinuous
} from '../src/main/continuous-channel'

// Minimal settings stub — only the fields continuous-channel reads
const makeSettings = (): OwenFlowSettings =>
  ({ flowMode: 'normal', cleanupEnabled: false, dictionary: [] } as unknown as OwenFlowSettings)

function makeDeps(overrides: Partial<{
  transcribeFn: (wav: ArrayBuffer) => { text: string; durationMs: number }
}> = {}) {
  const transcribeFn = overrides.transcribeFn ?? (() => ({ text: 'A', durationMs: 1 }))
  const setPillState = vi.fn()
  const startRecorder = vi.fn()
  const stopRecorder = vi.fn()
  const appendHistory = vi.fn()
  const inject = vi.fn(async () => {})
  const cleanup = vi.fn(async (r: string) => r)
  const transcribe = vi.fn(async (wav: ArrayBuffer, _s: OwenFlowSettings) => transcribeFn(wav))
  return {
    setPillState, startRecorder, stopRecorder, appendHistory, inject, cleanup, transcribe,
    getSettings: () => makeSettings()
  }
}

// Reset module-level state between tests by re-initialising with fresh deps
beforeEach(() => {
  // Cancel any lingering state then re-init with a neutral set of deps
  cancelContinuous()
})

describe('continuous-channel: happy path (two segments in order)', () => {
  it('transcribes and injects both segments in order, then appends one history entry with mode=continuous', async () => {
    const calls: string[] = []
    let segIdx = 0
    const labels = ['A', 'B']
    const deps = makeDeps({
      transcribeFn: () => ({ text: labels[segIdx++] ?? 'X', durationMs: 1 })
    })
    deps.inject = vi.fn(async (text: string) => { calls.push(text) })
    initContinuousChannel(deps)

    startContinuous()
    expect(deps.startRecorder).toHaveBeenCalledTimes(1)
    expect(deps.setPillState).toHaveBeenCalledWith({ state: 'recording' })

    const wavA = new ArrayBuffer(4)
    const wavB = new ArrayBuffer(4)
    onSegment(wavA)
    onSegment(wavB)

    // Drive the serial tail chain to completion via onDone (which awaits tail)
    await onDone()

    // Both segments injected in order
    expect(calls).toEqual(['A', 'B'])

    // Exactly one history entry
    expect(deps.appendHistory).toHaveBeenCalledTimes(1)
    const entry = deps.appendHistory.mock.calls[0][0]
    expect(entry.mode).toBe('continuous')
    expect(entry.final).toBe('A B')

    expect(deps.setPillState).toHaveBeenLastCalledWith({ state: 'done' })
  })
})

describe('continuous-channel: cancel guard', () => {
  it('does not inject after cancel — subsequent onSegment work is dropped', async () => {
    const deps = makeDeps({ transcribeFn: () => ({ text: 'C', durationMs: 1 }) })
    deps.inject = vi.fn(async () => {})
    initContinuousChannel(deps)

    startContinuous()

    const wav = new ArrayBuffer(4)
    onSegment(wav)

    // Cancel immediately — bumps generation, deactivates
    cancelContinuous()
    expect(isContinuousActive()).toBe(false)

    // Queue a second segment after cancel; it should be a no-op (active=false)
    onSegment(wav)

    // Flush microtasks
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // inject must never have been called because gen guard bails it out
    expect(deps.inject).not.toHaveBeenCalled()
  })
})

describe('continuous-channel: transcribe error is skipped', () => {
  it('skips a failing segment but still injects a following good segment', async () => {
    let callCount = 0
    const deps = makeDeps({
      transcribeFn: () => {
        callCount++
        if (callCount === 1) throw new Error('sidecar timeout')
        return { text: 'Good', durationMs: 1 }
      }
    })
    deps.inject = vi.fn(async () => {})
    // Override transcribe so the thrown error propagates
    deps.transcribe = vi.fn(async (wav: ArrayBuffer, s: OwenFlowSettings) => {
      callCount++
      if (callCount === 1) throw new Error('sidecar timeout')
      return { text: 'Good', durationMs: 1 }
    })
    initContinuousChannel(deps)

    startContinuous()

    const wavBad = new ArrayBuffer(4)
    const wavGood = new ArrayBuffer(4)
    onSegment(wavBad)  // will throw — should be swallowed
    onSegment(wavGood) // should succeed

    await onDone()

    // Only the good segment was injected
    expect(deps.inject).toHaveBeenCalledTimes(1)
    expect(deps.inject).toHaveBeenCalledWith('Good')
  })
})
