/**
 * App-aware formatting profiles: match the focused process name to a profile,
 * then reshape the output (deterministic transforms + an optional prompt rule
 * fed to cleanup). Pure module (no electron) — pipeline + tests use directly.
 */

import type { AppProfile, FlowMode } from '../shared/types'
import { applyReplacements, parseDictionary } from './dictionary'

/** Editable presets, seeded into settings on first run. */
export const DEFAULT_PROFILES: AppProfile[] = [
  {
    match: ['Code', 'Cursor'],
    flowMode: 'vibe',
    stripTrailingPeriod: true,
    noAutoCapitalize: true,
    promptRule: 'Target is a code editor; keep code identifiers and casing exact.'
  },
  {
    match: ['WindowsTerminal', 'powershell', 'cmd', 'wezterm', 'alacritty'],
    stripTrailingPeriod: true,
    noAutoCapitalize: true,
    singleLine: true,
    promptRule: 'Target is a terminal; if this is a shell command, output only the command.'
  },
  { match: ['slack', 'Discord'], flowMode: 'normal' },
  { match: ['OUTLOOK', 'Mail', 'Thunderbird'], flowMode: 'formal' }
]

/** First profile whose match list contains the app (case-insensitive), or null. */
export function matchProfile(app: string | null, profiles: AppProfile[]): AppProfile | null {
  if (!app) return null
  const key = app.toLowerCase()
  for (const p of profiles) {
    if (p.match.some((m) => m.toLowerCase() === key)) return p
  }
  return null
}

/** Per-app replacements first, then boolean transforms (period/case/single-line). */
export function applyProfileTransforms(text: string, profile: AppProfile): string {
  let out = text
  if (profile.replacements?.length) {
    const { replacements } = parseDictionary(profile.replacements)
    out = applyReplacements(out, replacements)
  }
  if (profile.singleLine) out = out.replace(/\s*\n+\s*/g, ' ')
  if (profile.stripTrailingPeriod) out = out.replace(/\.\s*$/, '')
  if (profile.noAutoCapitalize && out) out = out.charAt(0).toLowerCase() + out.slice(1)
  return out
}

/** The system-prompt rule for this profile (or ''). */
export function profilePromptRule(profile: AppProfile): string {
  return profile.promptRule?.trim() || ''
}

/** Effective flow mode pinned by the profile, if any. */
export function profileMode(profile: AppProfile | null): FlowMode | null {
  return profile?.flowMode ?? null
}
