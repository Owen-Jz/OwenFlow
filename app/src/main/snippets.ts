/**
 * Voice snippets/macros: a spoken trigger expands to canned text, pasted
 * verbatim (no cleanup). Pure module (no electron) so the pipeline + tests
 * use it directly. Format reuses the dictionary's "trigger => expansion".
 */

export interface Snippet {
  trigger: string
  expansion: string
}

/** Parse "trigger => expansion" lines; \n in the expansion becomes a newline. */
export function parseSnippets(lines: string[]): Snippet[] {
  const out: Snippet[] = []
  for (const raw of lines) {
    const entry = raw.trim()
    if (!entry) continue
    const idx = entry.indexOf('=>')
    if (idx <= 0) continue
    const trigger = entry.slice(0, idx).trim()
    const expansion = entry.slice(idx + 2).trim().replace(/\\n/g, '\n')
    if (trigger) out.push({ trigger, expansion })
  }
  return out
}

/** Normalize for whole-utterance comparison: trim, drop trailing . ! ?, lowercase. */
function normalize(text: string): string {
  return text.trim().replace(/[.!?]+$/, '').trim().toLowerCase()
}

/**
 * If the whole transcript equals a snippet trigger (case-insensitive, trailing
 * sentence punctuation tolerated), return its expansion; else null.
 */
export function matchSnippet(transcript: string, snippets: Snippet[]): string | null {
  const key = normalize(transcript)
  if (!key) return null
  for (const s of snippets) {
    if (normalize(s.trigger) === key) return s.expansion
  }
  return null
}
