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
  nextMode,
  reconfigureModeHotkey,
  startModeHotkey,
  stopModeHotkey
} from '../src/main/mode-hotkey'
import type { FlowMode, OwenFlowSettings } from '../src/shared/types'

const keydown = (keycode: number): void => handlers.keydown.forEach((h) => h({ keycode }))
const keyup = (keycode: number): void => handlers.keyup.forEach((h) => h({ keycode }))

const RIGHT_CTRL = 0x0e1d
const F4 = 0x003e
const F9 = 0x0043

describe('nextMode (pure cycle step)', () => {
  it('cycles normal → vibe → formal → normal', () => {
    expect(nextMode('normal')).toBe('vibe')
    expect(nextMode('vibe')).toBe('formal')
    expect(nextMode('formal')).toBe('normal')
  })

  it('translate is not on the cycle — the first tap exits to normal', () => {
    expect(nextMode('translate')).toBe('normal')
  })

  it('never yields translate (a full lap from every mode stays in the trio)', () => {
    for (const start of ['normal', 'vibe', 'formal', 'translate'] as FlowMode[]) {
      let mode = start
      for (let i = 0; i < 4; i++) {
        mode = nextMode(mode)
        expect(mode).not.toBe('translate')
      }
    }
  })
})

interface Harness {
  setSettings: ReturnType<typeof vi.fn>
  showNotice: ReturnType<typeof vi.fn>
  setEnabled: (v: boolean) => void
  setBusy: (v: boolean) => void
  /** The harness settings store — flowMode is updated by setSettings like config.ts. */
  flowMode: () => FlowMode
  start: (hotkey?: string) => void
}

function makeHarness(initialMode: FlowMode = 'normal'): Harness {
  let enabled = true
  let busy = false
  // Only flowMode matters to the module; a partial snapshot keeps the test honest.
  const settings = { flowMode: initialMode } as OwenFlowSettings
  const setSettings = vi.fn((patch: Partial<OwenFlowSettings>) => {
    Object.assign(settings, patch)
  })
  const showNotice = vi.fn()
  return {
    setSettings,
    showNotice,
    setEnabled: (v) => (enabled = v),
    setBusy: (v) => (busy = v),
    flowMode: () => settings.flowMode,
    start: (hotkey = 'F9') =>
      startModeHotkey({
        hotkey,
        isEnabled: () => enabled,
        getSettings: () => settings,
        setSettings,
        isBusy: () => busy,
        showNotice
      })
  }
}

function resetHook(): void {
  stopModeHotkey()
  handlers.keydown.length = 0
  handlers.keyup.length = 0
}

describe('mode hotkey: tap → cycle → persist', () => {
  let h: Harness

  beforeEach(() => {
    resetHook()
    h = makeHarness()
  })

  it('one tap persists the next mode AND flashes the notice', () => {
    h.start()
    keydown(F9)
    keyup(F9)
    expect(h.setSettings).toHaveBeenCalledTimes(1)
    expect(h.setSettings).toHaveBeenCalledWith({ flowMode: 'vibe' })
    expect(h.showNotice).toHaveBeenCalledTimes(1)
    expect(h.showNotice).toHaveBeenCalledWith('vibe')
  })

  it('successive taps walk the full cycle back to normal', () => {
    h.start()
    for (const expected of ['vibe', 'formal', 'normal'] as FlowMode[]) {
      keydown(F9)
      keyup(F9)
      expect(h.flowMode()).toBe(expected)
      expect(h.showNotice).toHaveBeenLastCalledWith(expected)
    }
    expect(h.setSettings).toHaveBeenCalledTimes(3)
  })

  it('a tap while in translate exits to normal', () => {
    resetHook()
    h = makeHarness('translate')
    h.start()
    keydown(F9)
    keyup(F9)
    expect(h.setSettings).toHaveBeenCalledWith({ flowMode: 'normal' })
  })

  it('OS key-repeat while held cycles only once', () => {
    h.start()
    keydown(F9)
    keydown(F9) // repeat
    keydown(F9)
    expect(h.setSettings).toHaveBeenCalledTimes(1)
    keyup(F9)
    keydown(F9) // genuine second tap
    expect(h.setSettings).toHaveBeenCalledTimes(2)
  })

  it('other keys are ignored', () => {
    h.start()
    keydown(RIGHT_CTRL)
    keyup(RIGHT_CTRL)
    expect(h.setSettings).not.toHaveBeenCalled()
    expect(h.showNotice).not.toHaveBeenCalled()
  })

  it('gates on isEnabled (tray flag)', () => {
    h.start()
    h.setEnabled(false)
    keydown(F9)
    keyup(F9)
    expect(h.setSettings).not.toHaveBeenCalled()
    expect(h.showNotice).not.toHaveBeenCalled()
  })

  it('switching while a dictation/command is active still persists but SKIPS the notice', () => {
    h.start()
    h.setBusy(true)
    keydown(F9)
    keyup(F9)
    expect(h.setSettings).toHaveBeenCalledWith({ flowMode: 'vibe' })
    expect(h.showNotice).not.toHaveBeenCalled()
    // back to idle: the notice returns
    h.setBusy(false)
    keydown(F9)
    keyup(F9)
    expect(h.showNotice).toHaveBeenCalledTimes(1)
    expect(h.showNotice).toHaveBeenCalledWith('formal')
  })
})

describe('mode hotkey: disabled + reconfigure', () => {
  let h: Harness

  beforeEach(() => {
    resetHook()
    h = makeHarness()
  })

  it('empty hotkey disables the feature (no RightCtrl fallback hijack)', () => {
    h.start('')
    keydown(F9)
    keyup(F9)
    // Crucial: an empty name must NOT fall back to the dictation key.
    keydown(RIGHT_CTRL)
    keyup(RIGHT_CTRL)
    expect(h.setSettings).not.toHaveBeenCalled()
    expect(h.showNotice).not.toHaveBeenCalled()
  })

  it('reconfigure switches the active key', () => {
    h.start('F9')
    reconfigureModeHotkey('F4')
    keydown(F9)
    keyup(F9)
    expect(h.setSettings).not.toHaveBeenCalled()
    keydown(F4)
    keyup(F4)
    expect(h.setSettings).toHaveBeenCalledTimes(1)
  })

  it('reconfigure to empty disables live; back to a key re-enables', () => {
    h.start('F9')
    reconfigureModeHotkey('')
    keydown(F9)
    keyup(F9)
    expect(h.setSettings).not.toHaveBeenCalled()
    reconfigureModeHotkey('F9')
    keydown(F9)
    keyup(F9)
    expect(h.setSettings).toHaveBeenCalledTimes(1)
  })
})
