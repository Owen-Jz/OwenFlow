/**
 * Pure pre-roll ring buffer for the warm-mic recorder.
 *
 * While the mic stream is warm but no dictation is active, the recorder feeds
 * every audio callback chunk in here. When recording starts, drain() hands
 * back the most recent ~capacity of audio to prepend to the capture — this is
 * what covers the gap between the hotkey press and the first processed audio
 * callback, so the first word isn't clipped.
 *
 * Eviction is whole-chunk (audio callbacks arrive as fixed-size Float32Array
 * blocks): the oldest chunk is dropped only once the REMAINING chunks still
 * hold at least `capacitySamples`. That guarantees drain() never returns less
 * than the requested pre-roll (once enough audio has flowed), at the cost of
 * up to one extra chunk of context — extra leading audio is harmless, missing
 * audio is a clipped word.
 */
export class PrerollBuffer {
  private chunks: Float32Array[] = []
  private total = 0

  constructor(private readonly capacitySamples: number) {}

  /** Total samples currently buffered (test/introspection aid). */
  get size(): number {
    return this.total
  }

  /** Append one audio callback chunk, evicting stale audio beyond capacity. */
  push(chunk: Float32Array): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.total += chunk.length
    // Drop the oldest chunk only while what's left still covers the capacity.
    while (this.chunks.length > 1 && this.total - this.chunks[0].length >= this.capacitySamples) {
      this.total -= this.chunks[0].length
      this.chunks.shift()
    }
  }

  /** Return the buffered chunks oldest-first and reset to empty. */
  drain(): Float32Array[] {
    const out = this.chunks
    this.chunks = []
    this.total = 0
    return out
  }

  /** Discard everything (e.g. when the warm stream is released). */
  clear(): void {
    this.chunks = []
    this.total = 0
  }
}
