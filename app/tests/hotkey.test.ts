import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    Meta: 0x0e5b,
    MetaRight: 0x0e5c,
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
  DOUBLE_TAP_GAP_MS,
  TAP_MAX_MS,
  isComboHotkey,
  isKnownHotkeyName,
  reconfigureHotkey,
  resolveHotkeyKeycode,
  startHotkey,
  stopHotkey
} from '../src/main/hotkey'

const keydown = (keycode: number): void => handlers.keydown.forEach((h) => h({ keycode }))
const keyup = (keycode: number): void => handlers.keyup.forEach((h) => h({ keycode }))

const LEFT_CTRL = 0x001d
const RIGHT_CTRL = 0x0e1d
const LEFT_WIN = 0x0e5b
const RIGHT_WIN = 0x0e5c
const ESCAPE = 0x0001
const F1 = 0x003b
const F4 = 0x003e

// Timing helpers (fake timers drive both setTimeout and Date.now).
const HOLD_MS = TAP_MAX_MS + 50 // long enough to classify as a hold
const GAP_EXPIRE_MS = DOUBLE_TAP_GAP_MS + 10

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

  it('recognizes the CtrlWin combo aliases', () => {
    expect(isComboHotkey('CtrlWin')).toBe(true)
    expect(isComboHotkey('Ctrl+Win')).toBe(true)
    expect(isComboHotkey('ctrl+win')).toBe(true)
    expect(isComboHotkey('ctrlwin')).toBe(true)
    expect(isComboHotkey('RightCtrl')).toBe(false)
    expect(isKnownHotkeyName('CtrlWin')).toBe(true)
    expect(isKnownHotkeyName('Ctrl+Win')).toBe(true)
  })
})

interface Harness {
  onStart: ReturnType<typeof vi.fn>
  onStop: ReturnType<typeof vi.fn>
  onCancel: ReturnType<typeof vi.fn>
  setEnabled: (v: boolean) => void
  start: (mode: 'hold' | 'toggle', hotkey?: string) => void
}

function makeHarness(): Harness {
  let enabled = true
  let dictationActive = false
  const onStart = vi.fn(() => (dictationActive = true))
  const onStop = vi.fn(() => (dictationActive = false))
  const onCancel = vi.fn(() => (dictationActive = false))
  return {
    onStart,
    onStop,
    onCancel,
    setEnabled: (v) => (enabled = v),
    start: (mode, hotkey = 'RightCtrl') =>
      startHotkey({
        hotkey,
        mode,
        isEnabled: () => enabled,
        onStart,
        onStop,
        isDictationActive: () => dictationActive,
        onCancel
      })
  }
}

function resetHook(): void {
  stopHotkey()
  handlers.keydown.length = 0
  handlers.keyup.length = 0
}

describe('hold mode (Wispr): push-to-talk', () => {
  let h: Harness

  beforeEach(() => {
    vi.useFakeTimers()
    resetHook()
    h = makeHarness()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keydown starts immediately; long hold then keyup stops (classic PTT)', () => {
    h.start('hold')
    keydown(RIGHT_CTRL)
    expect(h.onStart).toHaveBeenCalledTimes(1) // no 300ms wait before recording
    vi.advanceTimersByTime(HOLD_MS)
    keyup(RIGHT_CTRL)
    expect(h.onStop).toHaveBeenCalledTimes(1)
    // no stray timer fires later
    vi.advanceTimersByTime(GAP_EXPIRE_MS)
    expect(h.onStop).toHaveBeenCalledTimes(1)
  })

  it('key-repeat keydowns while held are ignored', () => {
    h.start('hold')
    keydown(RIGHT_CTRL)
    keydown(RIGHT_CTRL) // OS key-repeat
    keydown(RIGHT_CTRL)
    expect(h.onStart).toHaveBeenCalledTimes(1)
    expect(h.onStop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(HOLD_MS)
    keyup(RIGHT_CTRL)
    expect(h.onStop).toHaveBeenCalledTimes(1)
  })

  it('other keys are ignored', () => {
    h.start('hold')
    keydown(F1)
    keyup(F1)
    expect(h.onStart).not.toHaveBeenCalled()
    expect(h.onStop).not.toHaveBeenCalled()
  })

  it('gates on isEnabled (tray flag)', () => {
    h.start('hold')
    h.setEnabled(false)
    keydown(RIGHT_CTRL)
    expect(h.onStart).not.toHaveBeenCalled()
    keyup(RIGHT_CTRL)
    expect(h.onStop).not.toHaveBeenCalled()
  })
})

describe('hold mode (Wispr): quick tap + double-tap lock', () => {
  let h: Harness

  beforeEach(() => {
    vi.useFakeTimers()
    resetHook()
    h = makeHarness()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const quickTap = (key = RIGHT_CTRL): void => {
    keydown(key)
    vi.advanceTimersByTime(50) // released well under TAP_MAX_MS
    keyup(key)
  }

  it('single quick tap: recording survives the gap window, then stops normally', () => {
    h.start('hold')
    quickTap()
    expect(h.onStart).toHaveBeenCalledTimes(1)
    expect(h.onStop).not.toHaveBeenCalled() // waiting for a possible 2nd tap
    vi.advanceTimersByTime(GAP_EXPIRE_MS)
    expect(h.onStop).toHaveBeenCalledTimes(1) // too-short dictation, normal stop
  })

  it('double-tap locks hands-free: recording continues after release, next tap stops', () => {
    h.start('hold')
    quickTap()
    vi.advanceTimersByTime(100) // gap < DOUBLE_TAP_GAP_MS
    quickTap() // second tap → lock
    expect(h.onStart).toHaveBeenCalledTimes(1) // same recording, no restart
    expect(h.onStop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5000) // hands-free: survives indefinitely
    expect(h.onStop).not.toHaveBeenCalled()
    // single tap while locked stops + transcribes (on keydown)
    keydown(RIGHT_CTRL)
    expect(h.onStop).toHaveBeenCalledTimes(1)
    keyup(RIGHT_CTRL)
    expect(h.onStop).toHaveBeenCalledTimes(1) // keyup of the stop-tap is inert
    expect(h.onStart).toHaveBeenCalledTimes(1)
  })

  it('after a locked dictation stops, the next press starts a fresh one', () => {
    h.start('hold')
    quickTap()
    quickTap() // lock
    keydown(RIGHT_CTRL) // stop tap
    keyup(RIGHT_CTRL)
    expect(h.onStop).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    keydown(RIGHT_CTRL)
    expect(h.onStart).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(HOLD_MS)
    keyup(RIGHT_CTRL)
    expect(h.onStop).toHaveBeenCalledTimes(2)
  })

  it('second tap arriving after the gap window does NOT lock — it starts a new dictation', () => {
    h.start('hold')
    quickTap()
    vi.advanceTimersByTime(GAP_EXPIRE_MS) // gap expired → first dictation stopped
    expect(h.onStop).toHaveBeenCalledTimes(1)
    keydown(RIGHT_CTRL)
    expect(h.onStart).toHaveBeenCalledTimes(2) // fresh dictation, not a lock
  })

  it('key-repeat while the locking (second) tap is held does not stop the recording', () => {
    h.start('hold')
    quickTap()
    keydown(RIGHT_CTRL) // second tap down → locked
    keydown(RIGHT_CTRL) // OS key-repeat while held
    keydown(RIGHT_CTRL)
    expect(h.onStop).not.toHaveBeenCalled()
    keyup(RIGHT_CTRL)
    expect(h.onStop).not.toHaveBeenCalled() // still locked
    keydown(RIGHT_CTRL) // genuine next tap → stop
    expect(h.onStop).toHaveBeenCalledTimes(1)
  })
})

describe('hold mode (Wispr): escape cancel in every state', () => {
  let h: Harness

  beforeEach(() => {
    vi.useFakeTimers()
    resetHook()
    h = makeHarness()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('escape while HELD cancels; keyup fires onStop (downstream no-op) and key-repeat cannot restart', () => {
    h.start('hold')
    keydown(RIGHT_CTRL)
    keydown(ESCAPE)
    expect(h.onCancel).toHaveBeenCalledTimes(1)
    // hotkey still physically held — OS key-repeat must NOT restart a recording
    keydown(RIGHT_CTRL)
    keydown(RIGHT_CTRL)
    expect(h.onStart).toHaveBeenCalledTimes(1)
    // release: onStop fires (downstream stopDictation is a no-op once cancelled)
    keyup(RIGHT_CTRL)
    expect(h.onStop).toHaveBeenCalledTimes(1)
    // and the state machine is fully reset: next press starts fresh
    keydown(RIGHT_CTRL)
    expect(h.onStart).toHaveBeenCalledTimes(2)
  })

  it('escape while WAITING-FOR-SECOND-TAP cancels and kills the gap timer', () => {
    h.start('hold')
    keydown(RIGHT_CTRL)
    vi.advanceTimersByTime(50)
    keyup(RIGHT_CTRL) // quick tap → waiting for 2nd tap, recording continues
    keydown(ESCAPE)
    expect(h.onCancel).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(GAP_EXPIRE_MS)
    expect(h.onStop).not.toHaveBeenCalled() // gap timer was cleared, no late stop
    // a tap after cancel starts a NEW dictation (does not lock)
    keydown(RIGHT_CTRL)
    expect(h.onStart).toHaveBeenCalledTimes(2)
  })

  it('escape while LOCKED cancels and resets the lock', () => {
    h.start('hold')
    keydown(RIGHT_CTRL)
    vi.advanceTimersByTime(50)
    keyup(RIGHT_CTRL)
    vi.advanceTimersByTime(100)
    keydown(RIGHT_CTRL)
    vi.advanceTimersByTime(50)
    keyup(RIGHT_CTRL) // double-tap → locked
    keydown(ESCAPE)
    expect(h.onCancel).toHaveBeenCalledTimes(1)
    // next press starts fresh — it is NOT treated as the "stop tap" of a lock
    keydown(RIGHT_CTRL)
    expect(h.onStart).toHaveBeenCalledTimes(2)
    expect(h.onStop).not.toHaveBeenCalled()
  })

  it('escape is ignored when no dictation is active (normal Escape usage)', () => {
    h.start('hold')
    keydown(ESCAPE)
    expect(h.onCancel).not.toHaveBeenCalled()
    expect(h.onStart).not.toHaveBeenCalled()
    expect(h.onStop).not.toHaveBeenCalled()
  })

  it('escape also covers the transcribing phase (active after hotkey released)', () => {
    // External pipeline keeps dictation "active" after stop (transcribing).
    let enabled = true
    let dictationActive = false
    const onStart = vi.fn(() => (dictationActive = true))
    const onStop = vi.fn() // does NOT clear active — still transcribing
    const onCancel = vi.fn(() => (dictationActive = false))
    startHotkey({
      hotkey: 'RightCtrl',
      mode: 'hold',
      isEnabled: () => enabled,
      onStart,
      onStop,
      isDictationActive: () => dictationActive,
      onCancel
    })
    keydown(RIGHT_CTRL)
    vi.advanceTimersByTime(HOLD_MS)
    keyup(RIGHT_CTRL) // long hold → stop → transcribing; pipeline still active
    expect(onStop).toHaveBeenCalledTimes(1)
    keydown(ESCAPE)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('CtrlWin combo hotkey', () => {
  let h: Harness

  beforeEach(() => {
    vi.useFakeTimers()
    resetHook()
    h = makeHarness()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ctrl→win order: combo-down starts; releasing win ends the hold', () => {
    h.start('hold', 'CtrlWin')
    keydown(LEFT_CTRL)
    expect(h.onStart).not.toHaveBeenCalled() // half a combo does nothing
    keydown(LEFT_WIN)
    expect(h.onStart).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(HOLD_MS)
    keyup(LEFT_WIN)
    expect(h.onStop).toHaveBeenCalledTimes(1)
    keyup(LEFT_CTRL) // releasing the remaining key is inert
    expect(h.onStop).toHaveBeenCalledTimes(1)
  })

  it('win→ctrl order: combo-down starts; releasing ctrl ends the hold', () => {
    h.start('hold', 'Ctrl+Win') // alias form
    keydown(RIGHT_WIN)
    expect(h.onStart).not.toHaveBeenCalled()
    keydown(RIGHT_CTRL)
    expect(h.onStart).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(HOLD_MS)
    keyup(RIGHT_CTRL)
    expect(h.onStop).toHaveBeenCalledTimes(1)
    keyup(RIGHT_WIN)
    expect(h.onStop).toHaveBeenCalledTimes(1)
  })

  it('either ctrl and either win key work (left/right mixed)', () => {
    h.start('hold', 'ctrl+win')
    keydown(RIGHT_CTRL)
    keydown(LEFT_WIN)
    expect(h.onStart).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(HOLD_MS)
    keyup(RIGHT_CTRL)
    expect(h.onStop).toHaveBeenCalledTimes(1)
  })

  it('key-repeat of either combo key while both held is guarded', () => {
    h.start('hold', 'CtrlWin')
    keydown(LEFT_CTRL)
    keydown(LEFT_WIN)
    keydown(LEFT_CTRL) // repeats
    keydown(LEFT_WIN)
    keydown(LEFT_CTRL)
    expect(h.onStart).toHaveBeenCalledTimes(1)
    expect(h.onStop).not.toHaveBeenCalled()
  })

  it('combo double-tap locks hands-free; next combo tap stops', () => {
    h.start('hold', 'CtrlWin')
    // quick combo tap 1
    keydown(LEFT_CTRL)
    keydown(LEFT_WIN)
    vi.advanceTimersByTime(50)
    keyup(LEFT_WIN)
    keyup(LEFT_CTRL)
    expect(h.onStart).toHaveBeenCalledTimes(1)
    // quick combo tap 2 within the gap → lock
    vi.advanceTimersByTime(100)
    keydown(LEFT_CTRL)
    keydown(LEFT_WIN)
    vi.advanceTimersByTime(50)
    keyup(LEFT_WIN)
    keyup(LEFT_CTRL)
    expect(h.onStop).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5000)
    expect(h.onStop).not.toHaveBeenCalled() // locked, hands-free
    // next combo tap stops
    keydown(LEFT_CTRL)
    keydown(LEFT_WIN)
    expect(h.onStop).toHaveBeenCalledTimes(1)
    expect(h.onStart).toHaveBeenCalledTimes(1)
  })

  it('escape cancels a locked combo dictation and resets state', () => {
    h.start('hold', 'CtrlWin')
    keydown(LEFT_CTRL)
    keydown(LEFT_WIN)
    vi.advanceTimersByTime(50)
    keyup(LEFT_WIN)
    keyup(LEFT_CTRL)
    keydown(LEFT_CTRL)
    keydown(LEFT_WIN)
    keyup(LEFT_WIN)
    keyup(LEFT_CTRL) // locked
    keydown(ESCAPE)
    expect(h.onCancel).toHaveBeenCalledTimes(1)
    // fresh start afterwards
    keydown(LEFT_CTRL)
    keydown(LEFT_WIN)
    expect(h.onStart).toHaveBeenCalledTimes(2)
    expect(h.onStop).not.toHaveBeenCalled()
  })

  it('plain Ctrl usage (e.g. Ctrl+C) never triggers the combo', () => {
    h.start('hold', 'CtrlWin')
    keydown(LEFT_CTRL)
    keydown(0x002e) // some letter key
    keyup(0x002e)
    keyup(LEFT_CTRL)
    expect(h.onStart).not.toHaveBeenCalled()
    expect(h.onStop).not.toHaveBeenCalled()
  })

  it('combo works in legacy toggle mode too', () => {
    h.start('toggle', 'CtrlWin')
    keydown(LEFT_CTRL)
    keydown(LEFT_WIN)
    keyup(LEFT_WIN)
    keyup(LEFT_CTRL)
    expect(h.onStart).toHaveBeenCalledTimes(1)
    expect(h.onStop).not.toHaveBeenCalled() // toggle: release ignored
    keydown(LEFT_CTRL)
    keydown(LEFT_WIN)
    expect(h.onStop).toHaveBeenCalledTimes(1)
  })
})

describe('legacy toggle mode (unchanged)', () => {
  let h: Harness

  beforeEach(() => {
    resetHook()
    h = makeHarness()
  })

  it('keydown toggles start/stop, keyup ignored', () => {
    h.start('toggle')
    keydown(RIGHT_CTRL)
    keyup(RIGHT_CTRL)
    expect(h.onStart).toHaveBeenCalledTimes(1)
    expect(h.onStop).not.toHaveBeenCalled()
    keydown(RIGHT_CTRL)
    keyup(RIGHT_CTRL)
    expect(h.onStop).toHaveBeenCalledTimes(1)
    expect(h.onStart).toHaveBeenCalledTimes(1)
  })

  it('held key repeat does not flip state repeatedly', () => {
    h.start('toggle')
    keydown(RIGHT_CTRL)
    keydown(RIGHT_CTRL) // repeat while held
    keydown(RIGHT_CTRL)
    expect(h.onStart).toHaveBeenCalledTimes(1)
    expect(h.onStop).not.toHaveBeenCalled()
  })

  it('escape resets toggle state so the next press starts fresh', () => {
    h.start('toggle')
    keydown(RIGHT_CTRL)
    keyup(RIGHT_CTRL)
    expect(h.onStart).toHaveBeenCalledTimes(1)
    keydown(ESCAPE)
    expect(h.onCancel).toHaveBeenCalledTimes(1)
    // next hotkey press must START a new dictation, not act as a "stop"
    keydown(RIGHT_CTRL)
    keyup(RIGHT_CTRL)
    expect(h.onStart).toHaveBeenCalledTimes(2)
    expect(h.onStop).not.toHaveBeenCalled()
  })
})

describe('reconfigure', () => {
  let h: Harness

  beforeEach(() => {
    vi.useFakeTimers()
    resetHook()
    h = makeHarness()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('switches the active key and mode', () => {
    h.start('hold')
    reconfigureHotkey('F4', 'toggle')
    keydown(RIGHT_CTRL)
    expect(h.onStart).not.toHaveBeenCalled()
    keydown(F4)
    expect(h.onStart).toHaveBeenCalledTimes(1)
    keyup(F4)
    expect(h.onStop).not.toHaveBeenCalled() // toggle: keyup ignored
    keydown(F4)
    expect(h.onStop).toHaveBeenCalledTimes(1)
  })

  it('mid-hold ends the dictation cleanly', () => {
    h.start('hold')
    keydown(RIGHT_CTRL)
    expect(h.onStart).toHaveBeenCalledTimes(1)
    reconfigureHotkey('F4', 'hold')
    expect(h.onStop).toHaveBeenCalledTimes(1)
  })

  it('mid-LOCK ends the dictation cleanly and clears the lock', () => {
    h.start('hold')
    keydown(RIGHT_CTRL)
    vi.advanceTimersByTime(50)
    keyup(RIGHT_CTRL)
    keydown(RIGHT_CTRL)
    keyup(RIGHT_CTRL) // locked
    reconfigureHotkey('F4', 'hold')
    expect(h.onStop).toHaveBeenCalledTimes(1)
    keydown(F4) // fresh start on the new key, not a "stop tap"
    expect(h.onStart).toHaveBeenCalledTimes(2)
  })

  it('mid-gap-window ends the dictation cleanly and kills the pending timer', () => {
    h.start('hold')
    keydown(RIGHT_CTRL)
    vi.advanceTimersByTime(50)
    keyup(RIGHT_CTRL) // waiting for 2nd tap
    reconfigureHotkey('F4', 'hold')
    expect(h.onStop).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(GAP_EXPIRE_MS)
    expect(h.onStop).toHaveBeenCalledTimes(1) // no double-stop from a stale timer
  })

  it('switches from single key to the CtrlWin combo', () => {
    h.start('hold')
    reconfigureHotkey('CtrlWin', 'hold')
    keydown(RIGHT_CTRL)
    expect(h.onStart).not.toHaveBeenCalled() // half a combo
    keydown(LEFT_WIN)
    expect(h.onStart).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(HOLD_MS)
    keyup(LEFT_WIN)
    expect(h.onStop).toHaveBeenCalledTimes(1)
  })
})
