/**
 * Pill overlay position math (pure, no electron import — unit-testable).
 *
 * Wispr Flow locks its pill to bottom-center; OwenFlow makes the position a
 * tray-driven setting. windows.ts feeds the primary display's work area in
 * and applies the result on every pill show, so a position change (or a
 * display-layout change) takes effect the next time the pill appears.
 */

import type { PillPosition } from '../shared/types'

export const PILL_WIDTH = 220 // fits the widest pill state (recording, 180px) + shadow room
export const PILL_HEIGHT = 60 // visual pill is 44px tall; extra rows for the drop shadow
/** Vertical clearance from the top/bottom work-area edge (above the taskbar). */
export const PILL_EDGE_MARGIN_V = 64
/** Horizontal clearance from the left/right edge for the corner positions. */
export const PILL_EDGE_MARGIN_H = 24

/** A display work area (electron's Display.workArea shape, decoupled from electron). */
export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Top-left window coordinates for the pill inside a work area. Center
 * positions split the width; corner positions hug the left/right edge at
 * PILL_EDGE_MARGIN_H. Top-center mirrors bottom-center vertically. Values are
 * rounded — Electron ignores fractional setPosition coordinates on Windows.
 */
export function computePillPosition(
  workArea: WorkArea,
  position: PillPosition
): { x: number; y: number } {
  const topY = workArea.y + PILL_EDGE_MARGIN_V
  const bottomY = workArea.y + workArea.height - PILL_HEIGHT - PILL_EDGE_MARGIN_V
  const centerX = workArea.x + workArea.width / 2 - PILL_WIDTH / 2

  switch (position) {
    case 'top-center':
      return { x: Math.round(centerX), y: Math.round(topY) }
    case 'bottom-left':
      return { x: Math.round(workArea.x + PILL_EDGE_MARGIN_H), y: Math.round(bottomY) }
    case 'bottom-right':
      return {
        x: Math.round(workArea.x + workArea.width - PILL_WIDTH - PILL_EDGE_MARGIN_H),
        y: Math.round(bottomY)
      }
    case 'bottom-center':
    default:
      // default arm keeps a corrupt/unknown stored value safe (schema should
      // prevent it, but the pill must never render off-screen).
      return { x: Math.round(centerX), y: Math.round(bottomY) }
  }
}
