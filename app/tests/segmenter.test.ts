import { describe, expect, it } from 'vitest'
import { type SegmentState, shouldFlush } from '../src/renderer/src/segmenter'

const SILENCE_MS = 700
const MAX_MS = 15000

describe('shouldFlush', () => {
  it('does not flush before any speech', () => {
    expect(shouldFlush({ hasSpeech: false, silenceMs: 1000, segmentMs: 1000 }, SILENCE_MS, MAX_MS)).toBe(false)
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
