import { app } from 'electron'
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { FolderCount, HistoryEntry, TagCount } from '../shared/types'

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

/**
 * Canonical folder form: trimmed, capped at 40 chars (display keeps case).
 * Returns undefined for empty/non-string input ("unfiled").
 */
export function normalizeFolder(folder: unknown): string | undefined {
  if (typeof folder !== 'string') return undefined
  const clean = folder.trim().slice(0, 40).trim()
  return clean || undefined
}

function parseLine(line: string): HistoryEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as HistoryEntry
    if (typeof parsed.ts !== 'number') return null
    // Legacy lines have no tags field — treat as [].
    parsed.tags = normalizeTags(parsed.tags)
    // Legacy lines have no folder field — undefined means unfiled.
    parsed.folder = normalizeFolder(parsed.folder)
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

/**
 * Move the entry with timestamp `ts` into a folder (null/empty unfiles it).
 * Same safe JSONL read-modify-write as updateTags: only the matching line is
 * rewritten, unknown/corrupt lines are preserved, temp-file rename lands the
 * result atomically. Returns true if the entry was found.
 */
export function setFolder(ts: number, folder: string | null): boolean {
  const file = historyPath()
  if (!existsSync(file)) return false
  const clean = folder === null ? undefined : normalizeFolder(folder)
  let found = false
  const lines = readFileSync(file, 'utf8').split('\n')
  const next = lines.map((line) => {
    if (found) return line
    const parsed = parseLine(line)
    if (!parsed || parsed.ts !== ts) return line
    found = true
    const { folder: _drop, ...rest } = parsed
    return JSON.stringify(clean === undefined ? rest : { ...rest, folder: clean })
  })
  if (!found) return false
  const tmp = `${file}.tmp`
  writeFileSync(tmp, next.join('\n'), 'utf8')
  renameSync(tmp, file)
  return true
}

/**
 * Distinct folder names with entry counts, alphabetical. Folders exist
 * implicitly through entries — no separate registry file.
 */
export function listFolders(): FolderCount[] {
  const counts = new Map<string, number>()
  for (const entry of list(Number.MAX_SAFE_INTEGER)) {
    if (entry.folder) counts.set(entry.folder, (counts.get(entry.folder) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([folder, count]) => ({ folder, count }))
    .sort((a, b) => a.folder.localeCompare(b.folder))
}

/**
 * Rewrite every line whose folder matches `match`, setting it to `nextFolder`
 * (undefined unfiles). Returns how many entries changed.
 */
function rewriteFolder(match: string, nextFolder: string | undefined): number {
  const file = historyPath()
  if (!existsSync(file)) return 0
  let changed = 0
  const lines = readFileSync(file, 'utf8').split('\n')
  const next = lines.map((line) => {
    const parsed = parseLine(line)
    if (!parsed || parsed.folder !== match) return line
    changed++
    const { folder: _drop, ...rest } = parsed
    return JSON.stringify(nextFolder === undefined ? rest : { ...rest, folder: nextFolder })
  })
  if (changed === 0) return 0
  const tmp = `${file}.tmp`
  writeFileSync(tmp, next.join('\n'), 'utf8')
  renameSync(tmp, file)
  return changed
}

/** Rename a folder across all its entries. Returns how many entries changed. */
export function renameFolder(from: string, to: string): number {
  const cleanFrom = normalizeFolder(from)
  const cleanTo = normalizeFolder(to)
  if (!cleanFrom || !cleanTo || cleanFrom === cleanTo) return 0
  return rewriteFolder(cleanFrom, cleanTo)
}

/** Delete a folder: unfile all its entries. Returns how many entries changed. */
export function deleteFolder(name: string): number {
  const clean = normalizeFolder(name)
  if (!clean) return 0
  return rewriteFolder(clean, undefined)
}

/** Delete all history. */
export function clear(): void {
  const file = historyPath()
  if (existsSync(file)) writeFileSync(file, '', 'utf8')
}
