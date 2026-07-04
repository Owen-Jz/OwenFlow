import { describe, expect, it, vi } from 'vitest'
import { CONTEXT_WORDS, lastWords, Pretranscriber } from '../src/main/pretranscribe'

/** Distinct dummy WAVs so identity/order assertions are meaningful. */
const wav = (n: number): ArrayBuffer => new ArrayBuffer(n + 1)

/** Flush microtasks until cond() holds (bounded) — background chain is promise-based. */
async function flushUntil(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !cond(); i++) await Promise.resolve()
  expect(cond()).toBe(true)
}

describe('lastWords', () => {
  it('returns the last n words joined with single spaces', () => {
    expect(lastWords('a b c d', 2)).toBe('c d')
  })
  it('returns everything when shorter than n', () => {
    expect(lastWords('hello world', 15)).toBe('hello world')
  })
  it('collapses irregular whitespace', () => {
    expect(lastWords('  a\n b\t c  ', 2)).toBe('b c')
  })
  it('returns undefined for empty/whitespace text', () => {
    expect(lastWords('')).toBeUndefined()
    expect(lastWords('   ')).toBeUndefined()
  })
  it('defaults to CONTEXT_WORDS', () => {
    const words = Array.from({ length: 40 }, (_, i) => `w${i}`)
    expect(lastWords(words.join(' '))).toBe(words.slice(-CONTEXT_WORDS).join(' '))
  })
})

describe('Pretranscriber', () => {
  it('finish() alone transcribes the final wav with no context (single-segment path)', async () => {
    const transcribe = vi.fn(async () => ' hello world ')
    const pt = new Pretranscriber(transcribe)
    const outcome = await pt.finish(wav(0))
    expect(outcome).toEqual({ ok: true, text: 'hello world' })
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(transcribe).toHaveBeenCalledWith(wav(0), undefined)
  })

  it('transcribes pushed segments serially, in order, and joins with single spaces', async () => {
    const started: number[] = []
    let release: (() => void) | null = null
    const transcribe = vi.fn(async (w: ArrayBuffer) => {
      started.push(w.byteLength)
      // First segment blocks until we release it — proves segment 2 WAITS.
      if (w.byteLength === 1) await new Promise<void>((r) => (release = r))
      return `seg${w.byteLength}`
    })
    const pt = new Pretranscriber(transcribe)
    pt.push(wav(0))
    pt.push(wav(1))
    await flushUntil(() => release !== null)
    // Segment 2's transcription must NOT have started while 1 is in flight.
    expect(started).toEqual([1])
    release!()
    const outcome = await pt.finish(wav(2))
    expect(started).toEqual([1, 2, 3]) // strict order, final last
    expect(outcome).toEqual({ ok: true, text: 'seg1 seg2 seg3' })
  })

  it('threads the previous transcript tail as context for segments after the first', async () => {
    const contexts: (string | undefined)[] = []
    const texts = ['one two three', 'four five', 'six']
    const transcribe = vi.fn(async (_w: ArrayBuffer, context?: string) => {
      contexts.push(context)
      return texts[contexts.length - 1]
    })
    const pt = new Pretranscriber(transcribe)
    pt.push(wav(0))
    pt.push(wav(1))
    const outcome = await pt.finish(wav(2))
    expect(outcome).toEqual({ ok: true, text: 'one two three four five six' })
    expect(contexts).toEqual([undefined, 'one two three', 'one two three four five'])
  })

  it('caps the context at CONTEXT_WORDS trailing words', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')
    const contexts: (string | undefined)[] = []
    const transcribe = vi.fn(async (_w: ArrayBuffer, context?: string) => {
      contexts.push(context)
      return contexts.length === 1 ? many : 'tail'
    })
    const pt = new Pretranscriber(transcribe)
    pt.push(wav(0))
    await pt.finish(wav(1))
    expect(contexts[1]).toBe(
      many.split(' ').slice(-CONTEXT_WORDS).join(' ')
    )
  })

  it('silence segments ("") are dropped from the join and skipped for context', async () => {
    const contexts: (string | undefined)[] = []
    const texts = ['hello there', '   ', 'goodbye']
    const transcribe = vi.fn(async (_w: ArrayBuffer, context?: string) => {
      contexts.push(context)
      return texts[contexts.length - 1]
    })
    const pt = new Pretranscriber(transcribe)
    pt.push(wav(0))
    pt.push(wav(1))
    const outcome = await pt.finish(wav(2))
    expect(outcome).toEqual({ ok: true, text: 'hello there goodbye' })
    // Segment 3's context looks THROUGH the silence back to segment 1.
    expect(contexts[2]).toBe('hello there')
  })

  it('a mid-run failure degrades the run (no further background attempts), then the stop-time retry recovers', async () => {
    let calls = 0
    const transcribe = vi.fn(async (w: ArrayBuffer) => {
      calls++
      if (calls === 1) throw new Error('sidecar busy') // segment 1 background attempt fails
      return `seg${w.byteLength}`
    })
    const pt = new Pretranscriber(transcribe)
    pt.push(wav(0))
    await flushUntil(() => calls === 1)
    pt.push(wav(1))
    await Promise.resolve() // give the chain a chance to (wrongly) transcribe seg 2
    // Degraded: segment 2 was stored but NOT background-transcribed.
    expect(calls).toBe(1)
    const outcome = await pt.finish(wav(2))
    // finish resolved all three: seg1 retry, seg2 first attempt, final.
    expect(calls).toBe(4)
    expect(outcome).toEqual({ ok: true, text: 'seg1 seg2 seg3' })
  })

  it('a segment that fails its stop-time retry too → ok:false with ALL wavs in order', async () => {
    const transcribe = vi.fn(async () => {
      throw new Error('Transcriber not ready (starting)')
    })
    const pt = new Pretranscriber(transcribe)
    pt.push(wav(0))
    pt.push(wav(1))
    await flushUntil(() => transcribe.mock.calls.length === 1) // degraded after the first failure
    const outcome = await pt.finish(wav(2))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    // All three segments — succeeded-or-not — for the recovery queue, in order.
    expect(outcome.wavs).toEqual([wav(0), wav(1), wav(2)])
    expect(outcome.error).toContain('Transcriber not ready')
    // Background attempt (1) + one retry in finish for the first unresolved
    // segment, which fails → bail immediately (no pointless further calls).
    expect(transcribe).toHaveBeenCalledTimes(2)
  })

  it('cancel() stops new transcriptions and finish() resolves to a discardable empty result', async () => {
    let resolveFirst!: (t: string) => void
    const transcribe = vi.fn(
      (): Promise<string> => new Promise((resolve) => (resolveFirst = resolve))
    )
    const pt = new Pretranscriber(transcribe)
    pt.push(wav(0))
    await flushUntil(() => transcribe.mock.calls.length === 1)
    pt.cancel()
    pt.push(wav(1)) // ignored — cancelled
    expect(pt.size).toBe(1)
    resolveFirst('late text that must be discarded')
    const outcome = await pt.finish(wav(2))
    expect(outcome).toEqual({ ok: true, text: '' })
    // The in-flight call was the only one ever issued.
    expect(transcribe).toHaveBeenCalledTimes(1)
  })

  it('push() after finish() is ignored', async () => {
    const transcribe = vi.fn(async () => 'text')
    const pt = new Pretranscriber(transcribe)
    await pt.finish(wav(0))
    pt.push(wav(1))
    expect(pt.size).toBe(1)
    expect(transcribe).toHaveBeenCalledTimes(1)
  })

  it('all-silence run joins to the empty string (caller shows "—")', async () => {
    const transcribe = vi.fn(async () => '  ')
    const pt = new Pretranscriber(transcribe)
    pt.push(wav(0))
    const outcome = await pt.finish(wav(1))
    expect(outcome).toEqual({ ok: true, text: '' })
  })
})
