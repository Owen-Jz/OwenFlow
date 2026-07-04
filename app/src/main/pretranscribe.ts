/**
 * Streaming pre-transcription accumulator for the NORMAL one-shot dictation
 * path (continuous mode has its own per-segment paste flow in
 * continuous-channel.ts — untouched by this module).
 *
 * While the user is still holding the hotkey, the recorder flushes audio
 * segments on natural pauses ("recorder:segment"). Each segment is
 * transcribed HERE in the background, strictly serially — segment N+1 waits
 * for N — so the final join is deterministic and boundary context (below) is
 * always available. On hotkey release only the small final remainder still
 * needs transcribing, so a 30s ramble no longer pays a 30s-audio
 * transcription between release and paste.
 *
 * Boundary accuracy: words spoken right at a pause boundary transcribe badly
 * without context, so each segment after the first gets the last
 * CONTEXT_WORDS words of everything transcribed so far threaded into its
 * whisper prompt (the caller appends it to the dictionary bias prompt —
 * whisper conditions most strongly on the trailing tokens, so context goes
 * last).
 *
 * Failure design — the SIMPLEST scheme that never loses audio and never
 * pastes out-of-order text:
 *   - The first mid-recording transcription failure marks the run degraded:
 *     no further background attempts (a cold/busy sidecar shouldn't be
 *     hammered while the mic is still hot). Segment WAVs keep accumulating.
 *   - finish() then gives every still-missing segment exactly ONE (re)try,
 *     in order (so context threading stays correct).
 *   - If ANY segment still fails, the whole run reports ok:false carrying
 *     ALL segment WAVs — succeeded ones included — so the caller can hand
 *     them to the existing transcribe-queue in order. Recovered transcripts
 *     land in History tagged 'recovered' (the full dictation, not just the
 *     failed slices) and NOTHING is pasted: pasting the surviving segments
 *     would silently drop a middle chunk, which is worse than the
 *     pre-existing "recovered, never pasted late" contract.
 *
 * Pure/DI: the only dependency is the injected transcribe function, so tests
 * drive it directly. Cancellation is a one-way flag — once cancelled, no new
 * transcriptions are issued and finish() resolves to a harmless empty result
 * (the pipeline's generation counter discards it anyway).
 */

/** Transcribe one segment WAV; `context` is prior-transcript tail for the prompt. */
export type SegmentTranscribe = (wav: ArrayBuffer, context?: string) => Promise<string>

/** How many trailing words of prior transcript are threaded into the next prompt. */
export const CONTEXT_WORDS = 15

/**
 * Last `n` whitespace-separated words of `text`, or undefined when there are
 * none (an all-silence segment transcribes to '' — no context to give).
 */
export function lastWords(text: string, n = CONTEXT_WORDS): string | undefined {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  if (words.length === 0) return undefined
  return words.slice(-n).join(' ')
}

export type PretranscribeOutcome =
  /** Every segment transcribed; `text` is the single-space join (may be ''). */
  | { ok: true; text: string }
  /** At least one segment failed even after its retry: all WAVs, in order, for the queue. */
  | { ok: false; wavs: ArrayBuffer[]; error: string }

interface Segment {
  wav: ArrayBuffer
  /** null = not (successfully) transcribed yet. '' = transcribed silence. */
  text: string | null
}

export class Pretranscriber {
  private segments: Segment[] = []
  /** Serial chain: each background transcription queues behind the previous. */
  private chain: Promise<void> = Promise.resolve()
  /** First background failure stops further pre-transcription (see header). */
  private degraded = false
  private cancelled = false
  private finished = false
  private lastError = 'Transcription failed'

  constructor(private readonly transcribe: SegmentTranscribe) {}

  /** Segment count so far (introspection/test aid). */
  get size(): number {
    return this.segments.length
  }

  /**
   * A pause-flushed segment arrived while recording. Stored immediately (the
   * WAV is never lost) and transcribed in the background unless the run is
   * already degraded/cancelled/finished.
   */
  push(wav: ArrayBuffer): void {
    if (this.cancelled || this.finished) return
    const seg: Segment = { wav, text: null }
    this.segments.push(seg)
    const index = this.segments.length - 1
    this.chain = this.chain.then(async () => {
      if (this.cancelled || this.degraded) return
      try {
        seg.text = (await this.transcribe(wav, this.contextFor(index))).trim()
      } catch (err) {
        this.degraded = true
        this.lastError = err instanceof Error ? err.message : 'Transcription failed'
      }
    })
  }

  /**
   * Hotkey released: append the final remainder as the last segment, wait for
   * the background chain, then resolve every still-missing segment with one
   * attempt each (in order). Never throws.
   */
  async finish(finalWav: ArrayBuffer): Promise<PretranscribeOutcome> {
    this.finished = true
    this.segments.push({ wav: finalWav, text: null })
    await this.chain
    if (this.cancelled) return { ok: true, text: '' } // caller discards via generation guard

    // One attempt per unresolved segment: for a mid-run failure this is its
    // retry; for the final remainder (and degraded-skipped segments) it's the
    // first attempt. Serial + in-order so context comes from resolved text.
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i]
      if (seg.text !== null) continue
      if (this.cancelled) return { ok: true, text: '' }
      try {
        seg.text = (await this.transcribe(seg.wav, this.contextFor(i))).trim()
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : 'Transcription failed'
        return { ok: false, wavs: this.segments.map((s) => s.wav), error: this.lastError }
      }
    }

    const text = this.segments
      .map((s) => s.text!)
      .filter((t) => t.length > 0)
      .join(' ')
    return { ok: true, text }
  }

  /**
   * Escape/cancel: stop issuing transcriptions; in-flight results are kept
   * only in this discarded instance (the pipeline nulls its reference and its
   * generation counter ignores anything already awaited).
   */
  cancel(): void {
    this.cancelled = true
  }

  /**
   * Prompt context for segment `index`: the trailing words of everything
   * transcribed before it. Joining ALL prior texts (not just index-1) means a
   * silence segment ('') between speech doesn't drop the context.
   */
  private contextFor(index: number): string | undefined {
    if (index === 0) return undefined
    const prior = this.segments
      .slice(0, index)
      .map((s) => s.text ?? '')
      .filter((t) => t.length > 0)
      .join(' ')
    return lastWords(prior)
  }
}
