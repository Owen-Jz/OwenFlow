import { describe, expect, it } from 'vitest'
import {
  PILL_EDGE_MARGIN_H,
  PILL_EDGE_MARGIN_V,
  PILL_HEIGHT,
  PILL_WIDTH,
  computePillPosition,
  type WorkArea
} from '../src/main/pill-position'
import type { PillPosition } from '../src/shared/types'

// Typical 1080p primary display with a 40px taskbar at the bottom.
const workArea: WorkArea = { x: 0, y: 0, width: 1920, height: 1040 }

describe('computePillPosition', () => {
  it('bottom-center: horizontally centered, 64px above the work-area bottom', () => {
    expect(computePillPosition(workArea, 'bottom-center')).toEqual({
      x: (1920 - PILL_WIDTH) / 2,
      y: 1040 - PILL_HEIGHT - PILL_EDGE_MARGIN_V
    })
  })

  it('top-center mirrors bottom-center: same x, 64px below the work-area top', () => {
    const bottom = computePillPosition(workArea, 'bottom-center')
    const top = computePillPosition(workArea, 'top-center')
    expect(top.x).toBe(bottom.x)
    expect(top.y).toBe(PILL_EDGE_MARGIN_V)
  })

  it('bottom-left: 24px from the left edge, 64px above the bottom', () => {
    expect(computePillPosition(workArea, 'bottom-left')).toEqual({
      x: PILL_EDGE_MARGIN_H,
      y: 1040 - PILL_HEIGHT - PILL_EDGE_MARGIN_V
    })
  })

  it('bottom-right: 24px from the right edge, 64px above the bottom', () => {
    expect(computePillPosition(workArea, 'bottom-right')).toEqual({
      x: 1920 - PILL_WIDTH - PILL_EDGE_MARGIN_H,
      y: 1040 - PILL_HEIGHT - PILL_EDGE_MARGIN_V
    })
  })

  it('honors a work-area origin offset (secondary-as-primary / left taskbar)', () => {
    const offset: WorkArea = { x: 100, y: 50, width: 1000, height: 800 }
    expect(computePillPosition(offset, 'bottom-left')).toEqual({
      x: 100 + PILL_EDGE_MARGIN_H,
      y: 50 + 800 - PILL_HEIGHT - PILL_EDGE_MARGIN_V
    })
    expect(computePillPosition(offset, 'top-center')).toEqual({
      x: Math.round(100 + 1000 / 2 - PILL_WIDTH / 2),
      y: 50 + PILL_EDGE_MARGIN_V
    })
    expect(computePillPosition(offset, 'bottom-right')).toEqual({
      x: 100 + 1000 - PILL_WIDTH - PILL_EDGE_MARGIN_H,
      y: 50 + 800 - PILL_HEIGHT - PILL_EDGE_MARGIN_V
    })
  })

  it('rounds fractional centering (odd work-area width) to whole pixels', () => {
    const odd: WorkArea = { x: 0, y: 0, width: 1001, height: 800 }
    const { x } = computePillPosition(odd, 'bottom-center')
    expect(Number.isInteger(x)).toBe(true)
    expect(x).toBe(Math.round((1001 - PILL_WIDTH) / 2))
  })

  it('falls back to bottom-center for an unknown stored value', () => {
    const pos = computePillPosition(workArea, 'somewhere-else' as PillPosition)
    expect(pos).toEqual(computePillPosition(workArea, 'bottom-center'))
  })

  it('every position keeps the pill fully inside the work area', () => {
    const positions: PillPosition[] = ['bottom-center', 'top-center', 'bottom-left', 'bottom-right']
    for (const position of positions) {
      const { x, y } = computePillPosition(workArea, position)
      expect(x).toBeGreaterThanOrEqual(workArea.x)
      expect(y).toBeGreaterThanOrEqual(workArea.y)
      expect(x + PILL_WIDTH).toBeLessThanOrEqual(workArea.x + workArea.width)
      expect(y + PILL_HEIGHT).toBeLessThanOrEqual(workArea.y + workArea.height)
    }
  })
})
