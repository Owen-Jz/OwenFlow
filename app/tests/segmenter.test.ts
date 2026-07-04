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

  describe('min-segment floor (normal one-shot pre-transcription)', () => {
    const MIN_MS = 3000

    it('suppresses a pause flush while the segment is under the floor', () => {
      expect(
        shouldFlush({ hasSpeech: true, silenceMs: 800, segmentMs: 2000 }, SILENCE_MS, MAX_MS, MIN_MS)
      ).toBe(false)
    })
    it('allows the pause flush once the segment clears the floor', () => {
      expect(
        shouldFlush({ hasSpeech: true, silenceMs: 800, segmentMs: 3500 }, SILENCE_MS, MAX_MS, MIN_MS)
      ).toBe(true)
    })
    it('the hard cap ignores the floor', () => {
      expect(
        shouldFlush({ hasSpeech: true, silenceMs: 0, segmentMs: 15001 }, SILENCE_MS, MAX_MS, MIN_MS)
      ).toBe(true)
    })
    it('omitting the floor keeps continuous-mode behavior byte-identical', () => {
      const s: SegmentState = { hasSpeech: true, silenceMs: 800, segmentMs: 1000 }
      expect(shouldFlush(s, SILENCE_MS, MAX_MS)).toBe(true)
    })
  })
})
