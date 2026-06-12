import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock uiohook-napi: never load/start the real native hook in tests.
// UiohookKey values mirror the real constants (uiohook-napi/dist/index.js).
const { handlers, fakeHook } = vi.hoisted(() => {
  type H = (e: { keycode: number }) => void
  const handlers: Record<string, H[]> = { keydown: [], keyup: [] }
  const fakeHook = {
    on: (ev: string, h: H): void => void handlers[ev]?.push(h),
    removeListener: (ev: string, h: H): void => {
      const arr = handlers[ev] ?? []
      const i = arr.indexOf(h)
      if (i >= 0) arr.splice(i, 1)
    },
    start: (): void => {},
    stop: (): void => {}
  }
  return { handlers, fakeHook }
})

vi.mock('uiohook-napi', () => ({
  uIOhook: fakeHook,
  UiohookKey: {
    Escape: 0x0001,
    Ctrl: 0x001d,
    CtrlRight: 0x0e1d,
    Alt: 0x0038,
    AltRight: 0x0e38,
    Shift: 0x002a,
    ShiftRight: 0x0036,
    ScrollLock: 0x0046,
    F1: 0x003b,
    F2: 0x003c,
    F3: 0x003d,
    F4: 0x003e,
    F5: 0x003f,
    F6: 0x0040,
    F7: 0x0041,
    F8: 0x0042,
    F9: 0x0043,
    F10: 0x0044,
    F11: 0x0057,
    F12: 0x0058
  }
}))

import {
  isKnownHotkeyName,
  reconfigureHotkey,
  resolveHotkeyKeycode,
  startHotkey,
  stopHotkey
} from '../src/main/hotkey'

const keydown = (keycode: number): void => handlers.keydown.forEach((h) => h({ keycode }))
const keyup = (keycode: number): void => handlers.keyup.forEach((h) => h({ keycode }))

const RIGHT_CTRL = 0x0e1d
const ESCAPE = 0x0001

describe('resolveHotkeyKeycode', () => {
  it('maps supported names to uiohook keycodes', () => {
    expect(resolveHotkeyKeycode('RightCtrl')).toBe(0x0e1d)
    expect(resolveHotkeyKeycode('LeftCtrl')).toBe(0x001d)
    expect(resolveHotkeyKeycode('RightAlt')).toBe(0x0e38)
    expect(resolveHotkeyKeycode('ScrollLock')).toBe(0x0046)
    expect(resolveHotkeyKeycode('Pause')).toBe(0x0e45)
    expect(resolveHotkeyKeycode('F1')).toBe(0x003b)
    expect(resolveHotkeyKeycode('F12')).toBe(0x0058)
  })

  it('falls back to RightCtrl for unknown names', () => {
    expect(resolveHotkeyKeycode('SuperHyperKey')).toBe(0x0e1d)
    expect(isKnownHotkeyName('SuperHyperKey')).toBe(false)
    expect(isKnownHotkeyName('F5')).toBe(true)
  })
})

describe('hotkey hold/toggle behavior', () => {
  let onStart: ReturnType<typeof vi.fn>
  let onStop: ReturnType<typeof vi.fn>
  let onCancel: ReturnType<typeof vi.fn>
  let enabled = true
  let dictationActive = false

  beforeEach(() => {
    stopHotkey()
    handlers.keydown.length = 0
    handlers.keyup.length = 0
    onStart = vi.fn()
    onStop = vi.fn()
    onCancel = vi.fn()
    enabled = true
    dictationActive = false
  })

  const start = (mode: 'hold' | 'toggle', hotkey = 'RightCtrl'): void =>
    startHotkey({
      hotkey,
      mode,
      isEnabled: () => enabled,
      onStart,
      onStop,
      isDictationActive: () => dictationActive,
      onCancel
    })

  it('hold mode: keydown starts, keyup stops, repeat keydowns are ignored', () => {
    start('hold')
    keydown(RIGHT_CTRL)
    keydown(RIGHT_CTRL) // OS key-repeat
    keydown(RIGHT_CTRL)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
    keyup(RIGHT_CTRL)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('hold mode: other keys are ignored', () => {
    start('hold')
    keydown(0x003b) // F1
    keyup(0x003b)
    expect(onStart).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
  })

  it('toggle mode: keydown toggles start/stop, keyup ignored', () => {
    start('toggle')
    keydown(RIGHT_CTRL)
    keyup(RIGHT_CTRL)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
    keydown(RIGHT_CTRL)
    keyup(RIGHT_CTRL)
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('toggle mode: held key repeat does not flip state repeatedly', () => {
    start('toggle')
    keydown(RIGHT_CTRL)
    keydown(RIGHT_CTRL) // repeat while held
    keydown(RIGHT_CTRL)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
  })

  it('gates on isEnabled (tray flag)', () => {
    start('hold')
    enabled = false
    keydown(RIGHT_CTRL)
    expect(onStart).not.toHaveBeenCalled()
  })

  it('reconfigure switches the active key and mode', () => {
    start('hold')
    reconfigureHotkey('F4', 'toggle')
    keydown(RIGHT_CTRL)
    expect(onStart).not.toHaveBeenCalled()
    keydown(0x003e) // F4
    expect(onStart).toHaveBeenCalledTimes(1)
    keyup(0x003e)
    expect(onStop).not.toHaveBeenCalled() // toggle: keyup ignored
    keydown(0x003e)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('reconfigure mid-hold ends the dictation cleanly', () => {
    start('hold')
    keydown(RIGHT_CTRL)
    expect(onStart).toHaveBeenCalledTimes(1)
    reconfigureHotkey('F4', 'hold')
    expect(onStop).toHaveBeenCalledTimes(1)
  })
})

describe('escape cancel', () => {
  let onStart: ReturnType<typeof vi.fn>
  let onStop: ReturnType<typeof vi.fn>
  let onCancel: ReturnType<typeof vi.fn>
  let dictationActive = false

  beforeEach(() => {
    stopHotkey()
    handlers.keydown.length = 0
    handlers.keyup.length = 0
    onStart = vi.fn(() => (dictationActive = true))
    onStop = vi.fn()
    onCancel = vi.fn(() => (dictationActive = false))
    dictationActive = false
  })

  const start = (mode: 'hold' | 'toggle'): void =>
    startHotkey({
      hotkey: 'RightCtrl',
      mode,
      isEnabled: () => true,
      onStart,
      onStop,
      isDictationActive: () => dictationActive,
      onCancel
    })

  it('escape during an active dictation calls onCancel', () => {
    start('hold')
    keydown(RIGHT_CTRL)
    expect(onStart).toHaveBeenCalledTimes(1)
    keydown(ESCAPE)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('escape is ignored when no dictation is active (normal Escape usage)', () => {
    start('hold')
    keydown(ESCAPE)
    expect(onCancel).not.toHaveBeenCalled()
    expect(onStart).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
  })

  it('escape also covers the transcribing phase (active after hotkey released)', () => {
    start('hold')
    keydown(RIGHT_CTRL)
    keyup(RIGHT_CTRL) // stop → transcribing; pipeline still active
    expect(onStop).toHaveBeenCalledTimes(1)
    keydown(ESCAPE)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('hold mode: keyup after escape fires onStop but key-repeat cannot restart', () => {
    start('hold')
    keydown(RIGHT_CTRL)
    keydown(ESCAPE)
    expect(onCancel).toHaveBeenCalledTimes(1)
    // hotkey still physically held — OS key-repeat must NOT restart a recording
    keydown(RIGHT_CTRL)
    keydown(RIGHT_CTRL)
    expect(onStart).toHaveBeenCalledTimes(1)
    // release: onStop fires (downstream stopDictation is a no-op once cancelled)
    keyup(RIGHT_CTRL)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('toggle mode: escape resets toggle state so the next press starts fresh', () => {
    start('toggle')
    keydown(RIGHT_CTRL)
    keyup(RIGHT_CTRL)
    expect(onStart).toHaveBeenCalledTimes(1)
    keydown(ESCAPE)
    expect(onCancel).toHaveBeenCalledTimes(1)
    // next hotkey press must START a new dictation, not act as a "stop"
    keydown(RIGHT_CTRL)
    keyup(RIGHT_CTRL)
    expect(onStart).toHaveBeenCalledTimes(2)
    expect(onStop).not.toHaveBeenCalled()
  })
})
