/**
 * Session tones: an active "session" label maps to a flow mode and auto-tags
 * dictations. Pure module (no electron). Format: "label => mode".
 */

import type { FlowMode } from '../shared/types'

export interface SessionTone {
  label: string
  mode: FlowMode
}

const VALID_MODES: readonly FlowMode[] = ['normal', 'vibe', 'formal', 'translate']

function isFlowMode(s: string): s is FlowMode {
  return (VALID_MODES as readonly string[]).includes(s)
}

/** Parse "label => mode" lines; entries with an unknown mode are dropped. */
export function parseSessionTones(lines: string[]): SessionTone[] {
  const out: SessionTone[] = []
  for (const raw of lines) {
    const entry = raw.trim()
    if (!entry) continue
    const idx = entry.indexOf('=>')
    if (idx <= 0) continue
    const label = entry.slice(0, idx).trim()
    const mode = entry.slice(idx + 2).trim().toLowerCase()
    if (label && isFlowMode(mode)) out.push({ label, mode })
  }
  return out
}

/** The flow mode for the active session label (case-insensitive), or null. */
export function activeSessionMode(activeLabel: string, tones: SessionTone[]): FlowMode | null {
  const key = activeLabel.trim().toLowerCase()
  if (!key) return null
  for (const t of tones) {
    if (t.label.toLowerCase() === key) return t.mode
  }
  return null
}
