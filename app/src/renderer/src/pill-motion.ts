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

/**
 * Meeting-length clock: m:ss under an hour, h:mm:ss from there ("42:13",
 * "1:02:13"). Dictations never need hours, so formatElapsed stays untouched;
 * a 3-hour meeting would read "185:12" through it. (formatMeetingElapsed in
 * meeting-channel.ts is the main-process sibling for the tray label — main
 * must not import renderer modules.)
 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
