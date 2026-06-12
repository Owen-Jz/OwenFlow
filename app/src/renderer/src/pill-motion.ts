/**
 * Pure motion math for the pill renderer — kept free of DOM/canvas so it can
 * be unit-tested. Used by pill.ts for the hardware-meter peak-hold caps and
 * the mono elapsed counter.
 */

/** Tuning for the peak-hold caps (classic studio meter behavior). */
export interface PeakConfig {
  /** ms a fresh peak stays pinned before it starts falling */
  holdMs: number
  /** fall speed once released, in height-fraction per second */
  decayPerSec: number
}

export const PEAK_DEFAULTS: PeakConfig = { holdMs: 280, decayPerSec: 1.4 }

/** Mutable per-bar peak state. */
export interface PeakState {
  /** current cap position, 0..1 */
  value: number
  /** ms remaining before the cap starts decaying */
  holdLeftMs: number
}

/**
 * Advance one peak cap by dtMs given the bar's current level.
 * - level >= cap: cap snaps up to level and the hold timer resets
 * - otherwise the hold timer drains, then the cap falls at decayPerSec
 * Returns the same object, mutated (avoids per-frame allocation).
 */
export function stepPeak(
  peak: PeakState,
  level: number,
  dtMs: number,
  cfg: PeakConfig = PEAK_DEFAULTS
): PeakState {
  if (level >= peak.value) {
    peak.value = level
    peak.holdLeftMs = cfg.holdMs
    return peak
  }
  if (peak.holdLeftMs > 0) {
    peak.holdLeftMs = Math.max(0, peak.holdLeftMs - dtMs)
    return peak
  }
  peak.value = Math.max(level, peak.value - (cfg.decayPerSec * dtMs) / 1000)
  return peak
}

/** Format elapsed milliseconds as a compact mono counter, e.g. 0:04, 1:23. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
