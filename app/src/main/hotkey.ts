/**
 * Global push-to-talk hotkey via uiohook-napi.
 *
 * Hold mode:   keydown(target) → onStart, keyup(target) → onStop.
 *              OS key-repeat fires keydown continuously while held — guarded.
 * Toggle mode: keydown toggles start/stop; keyup ignored.
 *
 * Gated on opts.isEnabled() (tray "Enabled" checkbox). uIOhook.stop() MUST be
 * called on app quit — the native hook keeps the process alive otherwise.
 */

import { uIOhook, UiohookKey } from 'uiohook-napi'
import type { DictationMode } from '../shared/types'

// ─── Hotkey name → uiohook keycode ──────────────────────────────────────────

// libuiohook VC_PAUSE — uiohook-napi doesn't export a Pause constant.
const VC_PAUSE = 0x0e45

const KEY_MAP: Record<string, number> = {
  RightCtrl: UiohookKey.CtrlRight,
  LeftCtrl: UiohookKey.Ctrl,
  RightAlt: UiohookKey.AltRight,
  LeftAlt: UiohookKey.Alt,
  RightShift: UiohookKey.ShiftRight,
  LeftShift: UiohookKey.Shift,
  ScrollLock: UiohookKey.ScrollLock,
  Pause: VC_PAUSE,
  F1: UiohookKey.F1,
  F2: UiohookKey.F2,
  F3: UiohookKey.F3,
  F4: UiohookKey.F4,
  F5: UiohookKey.F5,
  F6: UiohookKey.F6,
  F7: UiohookKey.F7,
  F8: UiohookKey.F8,
  F9: UiohookKey.F9,
  F10: UiohookKey.F10,
  F11: UiohookKey.F11,
  F12: UiohookKey.F12
}

export const DEFAULT_HOTKEY = 'RightCtrl'

/** Map a settings hotkey name to a uiohook keycode (falls back to RightCtrl). */
export function resolveHotkeyKeycode(name: string): number {
  return KEY_MAP[name] ?? KEY_MAP[DEFAULT_HOTKEY]
}

export function isKnownHotkeyName(name: string): boolean {
  return name in KEY_MAP
}

// ─── Hook lifecycle ──────────────────────────────────────────────────────────

export interface HotkeyOptions {
  hotkey: string
  mode: DictationMode
  /** Tray "Enabled" flag — when false, key events are ignored. */
  isEnabled: () => boolean
  onStart: () => void
  onStop: () => void
  /**
   * True while a dictation is active (recording OR transcribing). Escape is
   * only intercepted while this returns true, so normal Escape usage in other
   * apps is unaffected.
   */
  isDictationActive: () => boolean
  /** Escape pressed during an active dictation — abort everything. */
  onCancel: () => void
}

let opts: HotkeyOptions | null = null
let targetKeycode = resolveHotkeyKeycode(DEFAULT_HOTKEY)
let mode: DictationMode = 'hold'
/** Hold mode: key currently held. Also the key-repeat guard. */
let held = false
/** Toggle mode: dictation currently active. */
let toggled = false
let running = false

function onKeydown(e: { keycode: number }): void {
  if (!opts) return

  // Escape aborts an active dictation (recording or transcribing). Only act
  // while a dictation is in flight so Escape behaves normally everywhere else.
  if (e.keycode === UiohookKey.Escape) {
    if (!opts.isDictationActive()) return
    // Toggle mode: reset so the next hotkey press starts fresh instead of
    // being treated as "stop". (Hold mode keeps `held` — the upcoming keyup
    // fires onStop, which is a no-op once the dictation is cancelled, and
    // keeping it set prevents OS key-repeat from restarting a recording.)
    toggled = false
    opts.onCancel()
    return
  }

  if (e.keycode !== targetKeycode) return

  if (mode === 'hold') {
    if (held) return // OS key-repeat
    if (!opts.isEnabled()) return
    held = true
    opts.onStart()
    return
  }

  // toggle mode — keydown flips state; ignore repeats while physically held.
  if (held) return
  held = true
  if (toggled) {
    toggled = false
    opts.onStop()
  } else {
    if (!opts.isEnabled()) return
    toggled = true
    opts.onStart()
  }
}

function onKeyup(e: { keycode: number }): void {
  if (!opts || e.keycode !== targetKeycode) return

  if (mode === 'hold') {
    if (!held) return
    held = false
    opts.onStop()
    return
  }

  // toggle mode: keyup only clears the repeat guard.
  held = false
}

/** Register the global hook and start listening. Idempotent. */
export function startHotkey(options: HotkeyOptions): void {
  opts = options
  targetKeycode = resolveHotkeyKeycode(options.hotkey)
  mode = options.mode
  held = false
  toggled = false

  if (!running) {
    uIOhook.on('keydown', onKeydown)
    uIOhook.on('keyup', onKeyup)
    uIOhook.start()
    running = true
  }
}

/** Re-apply hotkey/mode from settings without restarting the native hook. */
export function reconfigureHotkey(hotkey: string, newMode: DictationMode): void {
  const wasActive = mode === 'hold' ? held : toggled
  targetKeycode = resolveHotkeyKeycode(hotkey)
  mode = newMode
  held = false
  // If a dictation was mid-flight, end it cleanly so state can't wedge.
  if (wasActive) opts?.onStop()
  toggled = false
}

/** Stop the native hook. MUST run on app quit or the process never exits. */
export function stopHotkey(): void {
  if (!running) return
  running = false
  uIOhook.removeListener('keydown', onKeydown)
  uIOhook.removeListener('keyup', onKeyup)
  try {
    uIOhook.stop()
  } catch {
    // native hook may already be torn down
  }
}
