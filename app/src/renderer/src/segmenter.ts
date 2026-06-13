/**
 * Pure pause-segmentation decision for continuous dictation. The recorder
 * tracks how long it has been silent and how long the current segment is, and
 * asks shouldFlush() whether to cut the segment here.
 */
export interface SegmentState {
  /** Has any above-threshold audio occurred in the current segment? */
  hasSpeech: boolean
  /** Continuous silence so far (ms). */
  silenceMs: number
  /** Length of the current segment so far (ms). */
  segmentMs: number
}

/** Flush when a real pause follows speech, or the segment hits the hard cap. */
export function shouldFlush(s: SegmentState, silenceMs: number, maxMs: number): boolean {
  if (s.hasSpeech && s.segmentMs >= maxMs) return true
  return s.hasSpeech && s.silenceMs >= silenceMs
}
