/**
 * Second global hotkey for the command channel.
 *
 * Attaches its OWN listeners to the already-running uIOhook instance
 * (hotkey.ts owns the hook lifecycle — startHotkey() calls uIOhook.start();
 * this module NEVER calls uIOhook.start()/stop()).
 *
 * Single-key only (no combo, no tap/lock — simpler than the dictation hotkey):
 *   hold mode  — hold to record, release to stop.
 *   toggle mode — first press starts, next press stops.
 * Escape cancels if a command is active.
 */

import { uIOhook, UiohookKey } from 'uiohook-napi'
import { resolveHotkeyKeycode } from './hotkey'
import type { DictationMode } from '../shared/types'

export interface CommandHotkeyOptions {
  hotkey: string
  mode: DictationMode
  /** Returns true when commands are allowed (commandEnabled && tray enabled). */
  isEnabled: () => boolean
  onStart: () => void
  onStop: () => void
  /** True while a command is active (recording OR processing). */
  isActive: () => boolean
  onCancel: () => void
}

let opts: CommandHotkeyOptions | null = null
let keycode = 0
let mode: DictationMode = 'hold'
/** Single-key hold guard (blocks OS key-repeat). */
let physHeld = false
/** Toggle mode: command currently active. */
let toggled = false
let listening = false

function onKeydown(e: { keycode: number }): void {
  if (!opts) return
  // Escape cancels an active command (only when one is in flight).
  if (e.keycode === UiohookKey.Escape) {
    if (opts.isActive()) {
      toggled = false
      opts.onCancel()
    }
    return
  }
  if (e.keycode !== keycode) return
  if (mode === 'toggle') {
    if (toggled) {
      toggled = false
      opts.onStop()
    } else if (opts.isEnabled()) {
      toggled = true
      opts.onStart()
    }
    return
  }
  // hold mode
  if (physHeld) return // OS key-repeat guard
  physHeld = true
  if (opts.isEnabled()) opts.onStart()
}

function onKeyup(e: { keycode: number }): void {
  if (!opts) return
  if (e.keycode !== keycode) return
  if (mode === 'toggle') return // toggle: keyup ignored
  if (!physHeld) return
  physHeld = false
  opts.onStop()
}

/** Register the command hotkey listeners on the shared uIOhook instance. */
export function startCommandHotkey(options: CommandHotkeyOptions): void {
  opts = options
  keycode = resolveHotkeyKeycode(options.hotkey)
  mode = options.mode
  physHeld = false
  toggled = false
  if (!listening) {
    uIOhook.on('keydown', onKeydown)
    uIOhook.on('keyup', onKeyup)
    listening = true
  }
}

/**
 * Re-apply hotkey/mode from settings without touching the hook lifecycle.
 * Resets in-flight physical state so a mid-flight key can't wedge.
 */
export function reconfigureCommandHotkey(hotkey: string, newMode: DictationMode): void {
  keycode = resolveHotkeyKeycode(hotkey)
  mode = newMode
  physHeld = false
  toggled = false
}

/** Remove command hotkey listeners. Call on app quit. */
export function stopCommandHotkey(): void {
  if (!listening) return
  listening = false
  uIOhook.removeListener('keydown', onKeydown)
  uIOhook.removeListener('keyup', onKeyup)
}
