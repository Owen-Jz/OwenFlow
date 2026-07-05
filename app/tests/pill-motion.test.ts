import { describe, expect, it } from 'vitest'
import { formatClock, formatElapsed } from '../src/renderer/src/pill-motion'

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

describe('formatClock (meeting pill timer)', () => {
  it('matches formatElapsed under an hour', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(4_000)).toBe('0:04')
    expect(formatClock(42 * 60_000 + 13_000)).toBe('42:13')
    expect(formatClock(3_599_000)).toBe('59:59')
  })

  it('rolls into h:mm:ss from one hour — a 3h meeting reads sanely', () => {
    expect(formatClock(3_600_000)).toBe('1:00:00')
    expect(formatClock(3_600_000 + 2 * 60_000 + 13_000)).toBe('1:02:13')
    expect(formatClock(3 * 3_600_000 + 5_000)).toBe('3:00:05')
  })

  it('clamps negative input to 0:00', () => {
    expect(formatClock(-500)).toBe('0:00')
  })
})
