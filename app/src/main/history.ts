import { app } from 'electron'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { HistoryEntry } from '../shared/types'

function historyPath(): string {
  return join(app.getPath('userData'), 'history.jsonl')
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
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as HistoryEntry
      if (typeof parsed.ts === 'number') entries.push(parsed)
    } catch {
      // skip corrupt lines rather than failing the whole list
    }
  }
  entries.sort((a, b) => b.ts - a.ts)
  return entries.slice(0, limit)
}

/** Delete all history. */
export function clear(): void {
  const file = historyPath()
  if (existsSync(file)) writeFileSync(file, '', 'utf8')
}
