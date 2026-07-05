/**
 * Third global hotkey: flow-mode cycling (tray-free mode switching).
 *
 * Attaches its OWN listeners to the already-running uIOhook instance
 * (hotkey.ts owns the hook lifecycle — startHotkey() calls uIOhook.start();
 * this module NEVER calls uIOhook.start()/stop()).
 *
 * Tap-only (no hold/toggle/combo — even simpler than the command hotkey):
 * each tap steps normal → vibe → formal → normal. Translate is deliberately
 * NOT in the cycle (it needs a target language, so it stays tray/settings
 * only); when the current mode is translate, the first tap exits to normal.
 *
 * The switch itself always happens; the pill notice is suppressed while a
 * dictation/command is in flight so the recording display isn't disrupted
 * (that policy lives here so it's unit-testable via the isBusy dep).
 *
 * Empty hotkey name = feature disabled (resolveHotkeyKeycode would otherwise
 * fall back to RightCtrl, hijacking the dictation key — guard before mapping).
 */

import { uIOhook } from 'uiohook-napi'
import { resolveHotkeyKeycode } from './hotkey'
import type { FlowMode, OwenFlowSettings } from '../shared/types'

/**
 * Pure cycle step: normal → vibe → formal → normal. Translate is not a stop
 * on the cycle — it maps back to normal (see module doc). Exported for tests.
 */
export function nextMode(current: FlowMode): FlowMode {
  switch (current) {
    case 'normal':
      return 'vibe'
    case 'vibe':
      return 'formal'
    case 'formal':
      return 'normal'
    case 'translate':
      return 'normal'
  }
}

export interface ModeHotkeyOptions {
  hotkey: string
  /** Returns true when switching is allowed (tray enabled flag). */
  isEnabled: () => boolean
  /** Current settings snapshot (flowMode is re-read per tap). */
  getSettings: () => OwenFlowSettings
  /**
   * Persist the switched mode. Wired to config.setSettings — the SAME path
   * the tray Mode submenu uses, so onSettingsChange rebuilds the tray radios
   * and the Home chips pick it up exactly like a tray switch.
   */
  setSettings: (patch: Partial<OwenFlowSettings>) => void
  /**
   * True while a dictation/command/continuous take is active (recording OR
   * processing). The mode still switches, but the pill notice is skipped so
   * the live recording/processing display isn't replaced mid-take.
   */
  isBusy: () => boolean
  /** Flash the new mode on the pill (index.ts owns the hide timer). */
  showNotice: (mode: FlowMode) => void
}

let opts: ModeHotkeyOptions | null = null
/** 0 = disabled (empty hotkey name); uiohook keycodes are never 0. */
let keycode = 0
/** Physical hold guard (blocks OS key-repeat from machine-gunning the cycle). */
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
  const next = nextMode(opts.getSettings().flowMode)
  opts.setSettings({ flowMode: next })
  // Switch always persists; only the visual flash is gated on busy.
  if (!opts.isBusy()) opts.showNotice(next)
}

function onKeyup(e: { keycode: number }): void {
  if (!opts) return
  if (keycode === 0 || e.keycode !== keycode) return
  physHeld = false
}

/** Register the mode hotkey listeners on the shared uIOhook instance. */
export function startModeHotkey(options: ModeHotkeyOptions): void {
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
export function reconfigureModeHotkey(hotkey: string): void {
  keycode = resolveOrDisable(hotkey)
  physHeld = false
}

/** Remove mode hotkey listeners. Call on app quit. */
export function stopModeHotkey(): void {
  if (!listening) return
  listening = false
  uIOhook.removeListener('keydown', onKeydown)
  uIOhook.removeListener('keyup', onKeyup)
}
