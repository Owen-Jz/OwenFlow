import { app } from 'electron'
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { HistoryEntry, TagCount } from '../shared/types'

function historyPath(): string {
  return join(app.getPath('userData'), 'history.jsonl')
}

/** Lowercase, trim, dedupe, drop empties — the canonical tag form. */
export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const out: string[] = []
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const clean = tag.trim().toLowerCase()
    if (clean && !out.includes(clean)) out.push(clean)
  }
  return out
}

function parseLine(line: string): HistoryEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as HistoryEntry
    if (typeof parsed.ts !== 'number') return null
    // Legacy lines have no tags field — treat as [].
    parsed.tags = normalizeTags(parsed.tags)
    return parsed
  } catch {
    return null // skip corrupt lines rather than failing the whole list
  }
}

/** Append one dictation to the JSONL history log. */
export function append(entry: HistoryEntry): void {
  appendFileSync(historyPath(), JSON.stringify(entry) + '\n', 'utf8')
}

/** List history entries, newest first. */
export function list(limit = 200): HistoryEntry[] {
  const file = historyPath()
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n')
  const entries: HistoryEntry[] = []
  for (const line of lines) {
    const parsed = parseLine(line)
    if (parsed) entries.push(parsed)
  }
  entries.sort((a, b) => b.ts - a.ts)
  return entries.slice(0, limit)
}

/**
 * Replace the tag set of the entry with timestamp `ts`.
 * Read-modify-write of the JSONL: only the matching line is rewritten,
 * unknown/corrupt lines are preserved verbatim, and the result lands via a
 * temp-file rename so a crash can't truncate the log. Returns true if found.
 */
export function updateTags(ts: number, tags: string[]): boolean {
  const file = historyPath()
  if (!existsSync(file)) return false
  const clean = normalizeTags(tags)
  let found = false
  const lines = readFileSync(file, 'utf8').split('\n')
  const next = lines.map((line) => {
    if (found) return line
    const parsed = parseLine(line)
    if (!parsed || parsed.ts !== ts) return line
    found = true
    return JSON.stringify({ ...parsed, tags: clean })
  })
  if (!found) return false
  const tmp = `${file}.tmp`
  writeFileSync(tmp, next.join('\n'), 'utf8')
  renameSync(tmp, file)
  return true
}

/** Distinct tags with usage counts, most-used first (ties alphabetical). */
export function listTags(): TagCount[] {
  const counts = new Map<string, number>()
  for (const entry of list(Number.MAX_SAFE_INTEGER)) {
    for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

/** Delete all history. */
export function clear(): void {
  const file = historyPath()
  if (existsSync(file)) writeFileSync(file, '', 'utf8')
}
