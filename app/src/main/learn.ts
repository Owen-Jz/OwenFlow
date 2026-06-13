/**
 * Auto-learning dictionary: diff a corrected transcript against the original
 * to propose "wrong=>right" replacement entries. Pure module (no electron).
 *
 * Word-level diff: trim the common leading/trailing words, then the differing
 * middle spans become one proposal. Returns [] when identical, when there is
 * no original span to replace, or when the change is too large to be a useful
 * targeted fix (treat that as a full rewrite, not a vocabulary correction).
 */

/** Fraction of corrected words that may differ before we treat it as a rewrite. */
const MAX_CHANGE_RATIO = 0.6

function words(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean)
}

export function proposeReplacements(raw: string, corrected: string): string[] {
  const a = words(raw)
  const b = words(corrected)
  if (b.length === 0) return []
  if (a.join(' ') === b.join(' ')) return []

  // Trim common prefix (exact match so changed casing is not swallowed).
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++
  }
  // Trim common suffix (exact match so changed casing is not swallowed).
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const fromSpan = a.slice(start, endA).join(' ').trim()
  const toSpan = b.slice(start, endB).join(' ').trim()

  // Need an original span to match on, and an actual change.
  if (!fromSpan || fromSpan === toSpan) return []

  // Too divergent → treat as a rewrite, not a vocabulary fix.
  const changed = Math.max(endA - start, endB - start)
  if (changed > Math.ceil(b.length * MAX_CHANGE_RATIO)) return []

  return [`${fromSpan.toLowerCase()}=>${toSpan}`]
}
