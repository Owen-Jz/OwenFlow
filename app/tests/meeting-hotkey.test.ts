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
  reconfigureMeetingHotkey,
  startMeetingHotkey,
  stopMeetingHotkey
} from '../src/main/meeting-hotkey'

const keydown = (keycode: number): void => handlers.keydown.forEach((h) => h({ keycode }))
const keyup = (keycode: number): void => handlers.keyup.forEach((h) => h({ keycode }))

const RIGHT_CTRL = 0x0e1d
const F4 = 0x003e
const F10 = 0x0044

interface Harness {
  onToggle: ReturnType<typeof vi.fn>
  setEnabled: (v: boolean) => void
  start: (hotkey?: string) => void
}

function makeHarness(): Harness {
  let enabled = true
  const onToggle = vi.fn()
  return {
    onToggle,
    setEnabled: (v) => (enabled = v),
    start: (hotkey = 'F10') =>
      startMeetingHotkey({
        hotkey,
        isEnabled: () => enabled,
        onToggle
      })
  }
}

function resetHook(): void {
  stopMeetingHotkey()
  handlers.keydown.length = 0
  handlers.keyup.length = 0
}

describe('meeting hotkey: tap toggles', () => {
  let h: Harness

  beforeEach(() => {
    resetHook()
    h = makeHarness()
  })

  it('one tap fires onToggle once', () => {
    h.start()
    keydown(F10)
    keyup(F10)
    expect(h.onToggle).toHaveBeenCalledTimes(1)
  })

  it('two taps fire twice (start… then stop — routing lives in index.ts)', () => {
    h.start()
    keydown(F10)
    keyup(F10)
    keydown(F10)
    keyup(F10)
    expect(h.onToggle).toHaveBeenCalledTimes(2)
  })

  it('OS key-repeat while held toggles only once', () => {
    h.start()
    keydown(F10)
    keydown(F10) // repeat
    keydown(F10)
    expect(h.onToggle).toHaveBeenCalledTimes(1)
    keyup(F10)
    keydown(F10) // genuine second tap
    expect(h.onToggle).toHaveBeenCalledTimes(2)
  })

  it('other keys are ignored', () => {
    h.start()
    keydown(RIGHT_CTRL)
    keyup(RIGHT_CTRL)
    expect(h.onToggle).not.toHaveBeenCalled()
  })

  it('gates on isEnabled (tray flag)', () => {
    h.start()
    h.setEnabled(false)
    keydown(F10)
    keyup(F10)
    expect(h.onToggle).not.toHaveBeenCalled()
  })
})

describe('meeting hotkey: disabled + reconfigure', () => {
  let h: Harness

  beforeEach(() => {
    resetHook()
    h = makeHarness()
  })

  it('empty hotkey disables the feature (no RightCtrl fallback hijack)', () => {
    h.start('')
    keydown(F10)
    keyup(F10)
    // Crucial: an empty name must NOT fall back to the dictation key.
    keydown(RIGHT_CTRL)
    keyup(RIGHT_CTRL)
    expect(h.onToggle).not.toHaveBeenCalled()
  })

  it('reconfigure switches the active key', () => {
    h.start('F10')
    reconfigureMeetingHotkey('F4')
    keydown(F10)
    keyup(F10)
    expect(h.onToggle).not.toHaveBeenCalled()
    keydown(F4)
    keyup(F4)
    expect(h.onToggle).toHaveBeenCalledTimes(1)
  })

  it('reconfigure to empty disables live; back to a key re-enables', () => {
    h.start('F10')
    reconfigureMeetingHotkey('')
    keydown(F10)
    keyup(F10)
    expect(h.onToggle).not.toHaveBeenCalled()
    reconfigureMeetingHotkey('F10')
    keydown(F10)
    keyup(F10)
    expect(h.onToggle).toHaveBeenCalledTimes(1)
  })
})
