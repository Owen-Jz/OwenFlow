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
 *
 * Starred entries (prefixed with *) are prioritized: starred prompt words
 * appear first in the returned array so they always survive the bias cap,
 * and the * is stripped from the output. Bare stars or star-only entries
 * are silently ignored.
 */
export function parseDictionary(dictionary: string[]): {
  promptWords: string[]
  replacements: Replacement[]
} {
  const starredPromptWords: string[] = []
  const promptWords: string[] = []
  const replacements: Replacement[] = []
  for (const raw of dictionary) {
    const entry = raw.trim()
    if (!entry) continue

    // Check if starred
    const isStarred = entry.startsWith('*')
    const unstarredEntry = isStarred ? entry.slice(1).trim() : entry

    // Skip if empty after stripping the star
    if (!unstarredEntry) continue

    const idx = unstarredEntry.indexOf('=>')
    if (idx > 0) {
      // Has => with something before it; try to add as replacement
      const from = unstarredEntry.slice(0, idx).trim()
      const to = unstarredEntry.slice(idx + 2).trim()
      if (from) replacements.push({ from, to })
    } else if (!(idx === 0 && isStarred)) {
      // Treat as prompt word unless it's starred and starts with =>
      // (i.e., skip *=>x but keep =>nothing and regular words)
      if (isStarred) {
        starredPromptWords.push(unstarredEntry)
      } else {
        promptWords.push(unstarredEntry)
      }
    }
  }
  // Return starred words first, then unstarred
  return { promptWords: [...starredPromptWords, ...promptWords], replacements }
}

/**
 * Whisper truncates initial_prompt to its last ~224 tokens, so an over-long
 * prompt silently drops the words at the START of the string — the opposite
 * of what a user editing their dictionary top-down would expect. Cap well
 * under that (~600 chars ≈ 150-200 tokens) and drop overflow from the END
 * so the first dictionary entries always survive.
 */
const BIAS_PROMPT_MAX_CHARS = 600

/**
 * Build the whisper initial_prompt from dictionary bias words.
 *
 * initial_prompt conditions the decoder on style as well as vocabulary, so a
 * bare comma-joined word list ("zeal, cresio") nudges whisper toward
 * lowercase, punctuation-free output. Wrapping the words in a natural,
 * properly-punctuated sentence ("Vocabulary: Cresio, Fluxboard.") biases both
 * the custom terms AND normal casing/punctuation.
 *
 * Returns undefined for empty input so callers can pass it straight through
 * to transcribe() (the sidecar treats missing prompt as "no bias").
 */
export function buildBiasPrompt(promptWords: string[]): string | undefined {
  const words = promptWords.map((w) => w.trim()).filter((w) => w.length > 0)
  if (words.length === 0) return undefined

  const prefix = 'Vocabulary: '
  const kept: string[] = []
  let length = prefix.length + 1 // +1 for the trailing period
  for (const word of words) {
    // ", " separator applies to every word after the first
    const cost = kept.length === 0 ? word.length : word.length + 2
    if (length + cost > BIAS_PROMPT_MAX_CHARS && kept.length > 0) break
    kept.push(word)
    length += cost
  }
  return `${prefix}${kept.join(', ')}.`
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
