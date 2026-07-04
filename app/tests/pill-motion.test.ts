import { describe, expect, it } from 'vitest'
import { formatElapsed } from '../src/renderer/src/pill-motion'

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
