/**
 * Pure parsing for the UIA reads (see uia.ts). Kept Electron-free so the
 * identifier/site/context logic is unit-testable without a Windows host.
 */

/** Tokens worth biasing Whisper toward: they carry casing a dictation can't. */
const IDENTIFIER_RE = /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+\b|\b[A-Za-z_$][A-Za-z0-9_$]*\b/g

/** A bare lowercase word ("fetch", "message") carries no casing to preserve. */
function isPlainWord(tok: string): boolean {
  return /^[a-z]+$/.test(tok)
}

/**
 * Extract code identifiers from text to bias Whisper toward the casing a
 * voice transcription can't capture. Matches camelCase, snake_case, PascalCase,
 * dotted names (e.g., "api.postMessage"), and multi-char ALLCAPS tokens.
 *
 * Deduplicates while preserving first-seen order (within the sorted output).
 * Drops plain lowercase dictionary words ("the", "go", "fetch") and tokens < 3
 * chars — they carry no casing to guide Whisper. Caps at `max` (default 40)
 * longest-first, then original order among ties.
 */
export function extractIdentifiers(text: string, max = 40): string[] {
  if (!text) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(IDENTIFIER_RE)) {
    const tok = m[0]
    if (tok.length < 3) continue
    if (isPlainWord(tok)) continue // plain english adds noise, not casing
    if (seen.has(tok)) continue
    seen.add(tok)
    out.push(tok)
  }
  // Longest first (most distinctive), then first-seen order among ties.
  out.sort((a, b) => b.length - a.length)
  return out.slice(0, max)
}

/**
 * Extract the registrable-ish host label from a URL for tone context. E.g.,
 * "https://mail.google.com/mail/u/0/#inbox" → "mail.google.com". Strips
 * scheme, path, query, fragment, and "www." prefix; lowercases the result.
 *
 * Returns null for empty, whitespace-only, or garbage inputs (must contain
 * at least one dot to be considered a valid host).
 */
export function siteFromUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  // strip scheme, then take up to the first / ? #, then drop www.
  const host = trimmed
    .replace(/^[a-z]+:\/\//i, '')
    .split(/[/?#]/)[0]
    .replace(/^www\./i, '')
    .trim()
  // must look like a host (has a dot, no spaces)
  if (!host || /\s/.test(host) || !host.includes('.')) return null
  return host.toLowerCase()
}

/**
 * Compact a field's text to the last N characters for editor context, keeping
 * the tail (where the caret sits) rather than the head. Collapses all
 * whitespace runs to single spaces and strips leading/trailing whitespace.
 *
 * If the result exceeds `max` chars (default 500), keeps the tail and drops
 * the leading partial word so the snippet starts on a clean word boundary
 * (not mid-syllable).
 */
export function compactContext(fieldText: string, max = 500): string {
  const collapsed = fieldText.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  const tail = collapsed.slice(collapsed.length - max)
  // drop a leading partial word so the snippet starts clean
  const space = tail.indexOf(' ')
  return space >= 0 ? tail.slice(space + 1) : tail
}
