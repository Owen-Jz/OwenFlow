/**
 * Pure motion math for the pill renderer — kept free of DOM/canvas so it can
 * be unit-tested. Used by pill.ts for the dim elapsed counter shown while
 * recording. (The old hardware-meter peak-hold caps were removed in the
 * Wispr-Flow-style redesign — the bar look is now plain white and calm.)
 */

/** Format elapsed milliseconds as a compact counter, e.g. 0:04, 1:23. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
