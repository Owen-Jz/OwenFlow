import { describe, expect, it } from 'vitest'
import {
  PEAK_DEFAULTS,
  formatElapsed,
  stepPeak,
  type PeakState
} from '../src/renderer/src/pill-motion'

const fresh = (): PeakState => ({ value: 0, holdLeftMs: 0 })

describe('stepPeak', () => {
  it('snaps the cap up to a louder level and arms the hold timer', () => {
    const p = fresh()
    stepPeak(p, 0.7, 16)
    expect(p.value).toBe(0.7)
    expect(p.holdLeftMs).toBe(PEAK_DEFAULTS.holdMs)
  })

  it('holds the cap steady while the hold timer drains', () => {
    const p = fresh()
    stepPeak(p, 0.7, 16) // pin at 0.7
    stepPeak(p, 0.1, 100) // quieter — still holding
    expect(p.value).toBe(0.7)
    expect(p.holdLeftMs).toBe(PEAK_DEFAULTS.holdMs - 100)
  })

  it('decays after the hold expires, at decayPerSec', () => {
    const p = fresh()
    stepPeak(p, 0.7, 16)
    stepPeak(p, 0.1, PEAK_DEFAULTS.holdMs) // drain hold exactly
    expect(p.holdLeftMs).toBe(0)
    stepPeak(p, 0.1, 100) // 100ms of decay
    expect(p.value).toBeCloseTo(0.7 - PEAK_DEFAULTS.decayPerSec * 0.1, 5)
  })

  it('never decays below the live level', () => {
    const p = fresh()
    stepPeak(p, 0.5, 16)
    stepPeak(p, 0.45, PEAK_DEFAULTS.holdMs) // drain hold
    stepPeak(p, 0.45, 10_000) // huge dt — would decay way past the level
    expect(p.value).toBe(0.45)
  })

  it('re-arms the hold whenever the level reaches the cap again', () => {
    const p = fresh()
    stepPeak(p, 0.6, 16)
    stepPeak(p, 0.2, PEAK_DEFAULTS.holdMs) // drain
    stepPeak(p, 0.2, 200) // decay a bit
    const decayed = p.value
    expect(decayed).toBeLessThan(0.6)
    stepPeak(p, 0.9, 16) // loud again
    expect(p.value).toBe(0.9)
    expect(p.holdLeftMs).toBe(PEAK_DEFAULTS.holdMs)
  })

  it('respects a custom config', () => {
    const cfg = { holdMs: 50, decayPerSec: 2 }
    const p = fresh()
    stepPeak(p, 1, 16, cfg)
    expect(p.holdLeftMs).toBe(50)
    stepPeak(p, 0, 50, cfg)
    stepPeak(p, 0, 250, cfg) // 0.25s * 2/s = 0.5 drop
    expect(p.value).toBeCloseTo(0.5, 5)
  })
})

describe('formatElapsed', () => {
  it('formats sub-minute times as 0:0S', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(999)).toBe('0:00')
    expect(formatElapsed(4_000)).toBe('0:04')
    expect(formatElapsed(59_999)).toBe('0:59')
  })

  it('rolls over into minutes with zero-padded seconds', () => {
    expect(formatElapsed(60_000)).toBe('1:00')
    expect(formatElapsed(83_500)).toBe('1:23')
    expect(formatElapsed(600_000)).toBe('10:00')
  })

  it('clamps negative input to 0:00', () => {
    expect(formatElapsed(-500)).toBe('0:00')
  })
})
