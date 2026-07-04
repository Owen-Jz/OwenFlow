/**
 * Pure pause-segmentation decision, shared by continuous dictation AND the
 * normal one-shot path's background pre-transcription. The recorder tracks
 * how long it has been silent and how long the current segment is, and asks
 * shouldFlush() whether to cut the segment here.
 */
export interface SegmentState {
  /** Has any above-threshold audio occurred in the current segment? */
  hasSpeech: boolean
  /** Continuous silence so far (ms). */
  silenceMs: number
  /** Length of the current segment so far (ms). */
  segmentMs: number
}

/**
 * Flush when a real pause follows speech, or the segment hits the hard cap.
 *
 * `minMs` (default 0 — continuous mode's original behavior, byte-identical)
 * is a floor on pause-triggered flushes: the normal one-shot path uses it so
 * tiny dictations stay a single segment (pre-transcribing a 1s utterance
 * buys nothing and costs a boundary). The hard cap ignores the floor — a cap
 * hit means the segment is long by definition.
 */
export function shouldFlush(
  s: SegmentState,
  silenceMs: number,
  maxMs: number,
  minMs = 0
): boolean {
  if (s.hasSpeech && s.segmentMs >= maxMs) return true
  return s.hasSpeech && s.silenceMs >= silenceMs && s.segmentMs >= minMs
}
