/**
 * Fourth global hotkey: meeting mode toggle (default F10).
 *
 * Attaches its OWN listeners to the already-running uIOhook instance —
 * exactly like mode-hotkey.ts (hotkey.ts owns the hook lifecycle via
 * startHotkey()/stopHotkey(); this module NEVER calls uIOhook.start()/stop()).
 *
 * Tap-only: each tap toggles the meeting recorder — start when idle, stop
 * when running. The start/stop decision itself lives in index.ts's onToggle
 * wiring (it consults meeting-channel state), keeping this module a pure
 * key→callback bridge that tests drive without any channel state.
 *
 * Empty hotkey name = feature disabled (resolveHotkeyKeycode would otherwise
 * fall back to RightCtrl, hijacking the dictation key — guard before mapping).
 */

import { uIOhook } from 'uiohook-napi'
import { resolveHotkeyKeycode } from './hotkey'

export interface MeetingHotkeyOptions {
  hotkey: string
  /** Returns true when the toggle is allowed (tray enabled flag). */
  isEnabled: () => boolean
  /** Tap: toggle the meeting (index.ts routes to start/stop by channel state). */
  onToggle: () => void
}

let opts: MeetingHotkeyOptions | null = null
/** 0 = disabled (empty hotkey name); uiohook keycodes are never 0. */
let keycode = 0
/** Physical hold guard (blocks OS key-repeat from machine-gunning the toggle). */
let physHeld = false
let listening = false

/** Empty/blank name disables the hotkey entirely instead of falling back. */
function resolveOrDisable(hotkey: string): number {
  return hotkey.trim() ? resolveHotkeyKeycode(hotkey) : 0
}

function onKeydown(e: { keycode: number }): void {
  if (!opts) return
  if (keycode === 0 || e.keycode !== keycode) return
  if (physHeld) return // OS key-repeat guard
  physHeld = true
  if (!opts.isEnabled()) return
  opts.onToggle()
}

function onKeyup(e: { keycode: number }): void {
  if (!opts) return
  if (keycode === 0 || e.keycode !== keycode) return
  physHeld = false
}

/** Register the meeting hotkey listeners on the shared uIOhook instance. */
export function startMeetingHotkey(options: MeetingHotkeyOptions): void {
  opts = options
  keycode = resolveOrDisable(options.hotkey)
  physHeld = false
  if (!listening) {
    uIOhook.on('keydown', onKeydown)
    uIOhook.on('keyup', onKeyup)
    listening = true
  }
}

/**
 * Re-apply the hotkey from settings without touching the hook lifecycle.
 * Resets the physical state so a mid-flight key can't wedge the repeat guard.
 */
export function reconfigureMeetingHotkey(hotkey: string): void {
  keycode = resolveOrDisable(hotkey)
  physHeld = false
}

/** Remove meeting hotkey listeners. Call on app quit. */
export function stopMeetingHotkey(): void {
  if (!listening) return
  listening = false
  uIOhook.removeListener('keydown', onKeydown)
  uIOhook.removeListener('keyup', onKeyup)
}
