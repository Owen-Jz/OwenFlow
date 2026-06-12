/**
 * Global push-to-talk hotkey via uiohook-napi.
 *
 * Hotkey can be a single key (e.g. "RightCtrl") or the Wispr-style combo
 * "CtrlWin" (also accepted as "Ctrl+Win" / "ctrl+win"): either Ctrl + either
 * Win/Meta key. The combo is "down" while BOTH are held; releasing either is
 * the combo "up".
 *
 * Hold mode (Wispr behavior — hold AND double-tap on the same hotkey):
 *   - Recording starts immediately on hotkey-down.
 *   - Hold (>TAP_MAX_MS or until release) = push-to-talk: release stops.
 *   - Quick tap (<TAP_MAX_MS): release does NOT stop immediately — we wait
 *     DOUBLE_TAP_GAP_MS for a second tap. If it arrives, dictation LOCKS
 *     hands-free (same recording continues, no restart); the next single tap
 *     stops + transcribes. If no second tap arrives, the recording stops
 *     normally (too-short dictation handled downstream).
 *   - Escape cancels in every state (held, waiting-for-second-tap, locked)
 *     and fully resets the tap/lock state machine.
 *
 * Toggle mode (legacy): keydown toggles start/stop; keyup ignored.
 *
 * OS key-repeat fires keydown continuously while held — guarded.
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

// Tap vs hold classification (recording starts on key-down regardless).
export const TAP_MAX_MS = 300
// Max gap after a quick tap for the second (locking) tap to arrive.
export const DOUBLE_TAP_GAP_MS = 400

/** "Ctrl+Win" / "CtrlWin" / "ctrl+win" → "ctrlwin". */
function normalizeHotkeyName(name: string): string {
  return name.replace(/\+/g, '').toLowerCase()
}

/** True if the hotkey name is the Ctrl+Win combo (any accepted alias). */
export function isComboHotkey(name: string): boolean {
  return normalizeHotkeyName(name) === 'ctrlwin'
}

/**
 * Map a settings hotkey name to a uiohook keycode (falls back to RightCtrl).
 * Combo hotkeys have no single keycode — combo detection happens in the
 * event handlers; this fallback is never consulted while a combo is active.
 */
export function resolveHotkeyKeycode(name: string): number {
  return KEY_MAP[name] ?? KEY_MAP[DEFAULT_HOTKEY]
}

export function isKnownHotkeyName(name: string): boolean {
  return name in KEY_MAP || isComboHotkey(name)
}

const isCtrlKey = (keycode: number): boolean =>
  keycode === UiohookKey.Ctrl || keycode === UiohookKey.CtrlRight

const isMetaKey = (keycode: number): boolean =>
  keycode === UiohookKey.Meta || keycode === UiohookKey.MetaRight

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

/**
 * Hold-mode (Wispr) tap/lock state machine:
 *   idle       — no dictation owned by the hotkey.
 *   held       — hotkey down, recording; release classifies tap vs hold.
 *   waitGap    — quick tap released; recording continues while we wait
 *                DOUBLE_TAP_GAP_MS for a second tap (gapTimer pending).
 *   lockedHeld — second tap is down; lock confirmed, recording continues.
 *   locked     — hands-free lock; next single tap (keydown) stops.
 */
type TapState = 'idle' | 'held' | 'waitGap' | 'lockedHeld' | 'locked'

let opts: HotkeyOptions | null = null
let targetKeycode = resolveHotkeyKeycode(DEFAULT_HOTKEY)
let comboMode = false
let mode: DictationMode = 'hold'
/** Single-key: physically held (also the key-repeat guard). */
let physHeld = false
/** Combo: physical state of each half. Repeats can't re-edge the combo. */
let ctrlDown = false
let metaDown = false
/** Toggle mode: dictation currently active. */
let toggled = false
/** Hold mode (Wispr) state machine. */
let tapState: TapState = 'idle'
let pressedAt = 0
let gapTimer: ReturnType<typeof setTimeout> | null = null
/**
 * Escape fired while the hotkey was physically held: the upcoming hotkey-up
 * still fires onStop (a no-op downstream once cancelled) — legacy behavior
 * that keeps the up-edge from being silently swallowed.
 */
let cancelledWhileHeld = false
let running = false

function clearGapTimer(): void {
  if (gapTimer !== null) {
    clearTimeout(gapTimer)
    gapTimer = null
  }
}

/** Logical hotkey-down edge (single key pressed, or combo became complete). */
function hotkeyDown(): void {
  if (!opts) return

  if (mode === 'toggle') {
    if (toggled) {
      toggled = false
      opts.onStop()
    } else {
      if (!opts.isEnabled()) return
      toggled = true
      opts.onStart()
    }
    return
  }

  // hold mode — Wispr tap/lock state machine
  switch (tapState) {
    case 'idle':
      if (!opts.isEnabled()) return
      cancelledWhileHeld = false
      pressedAt = Date.now()
      tapState = 'held'
      opts.onStart() // recording starts immediately on key-down
      return
    case 'waitGap':
      // Second tap arrived in time → hands-free lock. The recording from the
      // first tap simply continues — no stop/restart.
      clearGapTimer()
      tapState = 'lockedHeld'
      return
    case 'locked':
      // Single tap while locked stops + transcribes.
      tapState = 'idle'
      opts.onStop()
      return
    // 'held' / 'lockedHeld' are unreachable: the physical repeat guards
    // suppress keydown while the key/combo is already down.
  }
}

/** Logical hotkey-up edge (single key released, or combo broken). */
function hotkeyUp(): void {
  if (!opts) return

  if (mode === 'toggle') return // toggle: keyup ignored

  switch (tapState) {
    case 'held': {
      const heldFor = Date.now() - pressedAt
      if (heldFor < TAP_MAX_MS) {
        // Quick tap: don't stop yet — wait for a possible second (locking) tap.
        tapState = 'waitGap'
        gapTimer = setTimeout(() => {
          gapTimer = null
          if (tapState !== 'waitGap') return
          // No second tap: too-short dictation, stop via the normal path.
          tapState = 'idle'
          opts?.onStop()
        }, DOUBLE_TAP_GAP_MS)
      } else {
        // Classic push-to-talk release.
        tapState = 'idle'
        opts.onStop()
      }
      return
    }
    case 'lockedHeld':
      // Release of the locking tap — stay locked, recording continues.
      tapState = 'locked'
      return
    case 'idle':
      if (cancelledWhileHeld) {
        cancelledWhileHeld = false
        opts.onStop() // no-op downstream once cancelled
      }
      return
    // 'waitGap' / 'locked' have no key physically down → no up-edge arrives.
  }
}

function onKeydown(e: { keycode: number }): void {
  if (!opts) return

  // Escape aborts an active dictation (recording or transcribing). Only act
  // while a dictation is in flight so Escape behaves normally everywhere else.
  if (e.keycode === UiohookKey.Escape) {
    if (!opts.isDictationActive()) return
    if (mode === 'hold') {
      // Fully reset the tap/lock state machine in every state.
      cancelledWhileHeld = tapState === 'held' || tapState === 'lockedHeld'
      clearGapTimer()
      tapState = 'idle'
    }
    // Toggle mode: reset so the next hotkey press starts fresh instead of
    // being treated as "stop".
    toggled = false
    opts.onCancel()
    return
  }

  if (comboMode) {
    const wasComboDown = ctrlDown && metaDown
    if (isCtrlKey(e.keycode)) ctrlDown = true
    else if (isMetaKey(e.keycode)) metaDown = true
    else return
    // Edge-trigger only: key-repeat keydowns don't change ctrlDown/metaDown.
    if (!wasComboDown && ctrlDown && metaDown) hotkeyDown()
    return
  }

  if (e.keycode !== targetKeycode) return
  if (physHeld) return // OS key-repeat
  physHeld = true
  hotkeyDown()
}

function onKeyup(e: { keycode: number }): void {
  if (!opts) return

  if (comboMode) {
    const wasComboDown = ctrlDown && metaDown
    if (isCtrlKey(e.keycode)) ctrlDown = false
    else if (isMetaKey(e.keycode)) metaDown = false
    else return
    // Releasing EITHER key ends the combo hold.
    if (wasComboDown && !(ctrlDown && metaDown)) hotkeyUp()
    return
  }

  if (e.keycode !== targetKeycode) return
  if (!physHeld) return
  physHeld = false
  hotkeyUp()
}

function resetState(): void {
  clearGapTimer()
  physHeld = false
  ctrlDown = false
  metaDown = false
  toggled = false
  tapState = 'idle'
  cancelledWhileHeld = false
}

/** Register the global hook and start listening. Idempotent. */
export function startHotkey(options: HotkeyOptions): void {
  opts = options
  targetKeycode = resolveHotkeyKeycode(options.hotkey)
  comboMode = isComboHotkey(options.hotkey)
  mode = options.mode
  resetState()

  if (!running) {
    uIOhook.on('keydown', onKeydown)
    uIOhook.on('keyup', onKeyup)
    uIOhook.start()
    running = true
  }
}

/** Re-apply hotkey/mode from settings without restarting the native hook. */
export function reconfigureHotkey(hotkey: string, newMode: DictationMode): void {
  // Active = any state where a dictation owned by the hotkey is in flight.
  const wasActive = mode === 'hold' ? tapState !== 'idle' : toggled
  targetKeycode = resolveHotkeyKeycode(hotkey)
  comboMode = isComboHotkey(hotkey)
  mode = newMode
  resetState()
  // If a dictation was mid-flight, end it cleanly so state can't wedge.
  if (wasActive) opts?.onStop()
}

/** Stop the native hook. MUST run on app quit or the process never exits. */
export function stopHotkey(): void {
  clearGapTimer()
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
