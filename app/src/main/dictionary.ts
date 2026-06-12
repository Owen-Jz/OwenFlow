/**
 * Dictionary parsing + post-transcription replacement logic.
 * Pure (no electron imports) so the pipeline and tests can use it directly.
 * config.ts re-exports parseDictionary — it still owns the settings format.
 */

export interface Replacement {
  from: string
  to: string
}

/**
 * Parse dictionary entries into the two consumption forms:
 * - promptWords: plain entries fed to whisper as initial_prompt bias
 * - replacements: "wrong=>right" pairs applied post-transcription
 */
export function parseDictionary(dictionary: string[]): {
  promptWords: string[]
  replacements: Replacement[]
} {
  const promptWords: string[] = []
  const replacements: Replacement[] = []
  for (const raw of dictionary) {
    const entry = raw.trim()
    if (!entry) continue
    const idx = entry.indexOf('=>')
    if (idx > 0) {
      const from = entry.slice(0, idx).trim()
      const to = entry.slice(idx + 2).trim()
      if (from) replacements.push({ from, to })
    } else {
      promptWords.push(entry)
    }
  }
  return { promptWords, replacements }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Apply "wrong=>right" replacements: case-insensitive, whole-word
 * (bounded by start/end or non-word chars so "cat" never rewrites "concatenate").
 */
export function applyReplacements(text: string, replacements: Replacement[]): string {
  let out = text
  for (const { from, to } of replacements) {
    if (!from) continue
    const re = new RegExp(`(?<=^|[^\\p{L}\\p{N}_])${escapeRegExp(from)}(?=$|[^\\p{L}\\p{N}_])`, 'giu')
    out = out.replace(re, to)
  }
  return out
}
