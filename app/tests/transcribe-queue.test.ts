import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initTranscribeQueue, enqueue, queueLength, _resetQueue } from '../src/main/transcribe-queue'
import type { OwenFlowSettings } from '../src/shared/types'

const settings = {} as OwenFlowSettings

describe('transcribe-queue', () => {
  beforeEach(() => { vi.useFakeTimers(); _resetQueue() })
  afterEach(() => { vi.useRealTimers() })

  it('retries until transcribe succeeds, then delivers once', async () => {
    let calls = 0
    const transcribe = vi.fn(async () => {
      calls++
      if (calls < 3) throw new Error('Transcriber not ready')
      return { text: 'recovered text', durationMs: 5 }
    })
    const deliver = vi.fn()
    initTranscribeQueue({ transcribe, deliver })
    enqueue(new ArrayBuffer(8), settings, 1000)
    expect(queueLength()).toBe(1)
    await vi.advanceTimersByTimeAsync(3000 * 3 + 100)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][0]).toBe('recovered text')
    expect(queueLength()).toBe(0)
  })

  it('gives up after max attempts → onDrop', async () => {
    const transcribe = vi.fn(async () => { throw new Error('still cold') })
    const deliver = vi.fn()
    const onDrop = vi.fn()
    initTranscribeQueue({ transcribe, deliver, onDrop })
    enqueue(new ArrayBuffer(8), settings, 1000)
    await vi.advanceTimersByTimeAsync(3000 * 41)
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(deliver).not.toHaveBeenCalled()
    expect(queueLength()).toBe(0)
  })
})
