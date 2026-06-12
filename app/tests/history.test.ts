import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// history.ts resolves its JSONL path through electron's app.getPath —
// point it at a throwaway temp dir so the tests run in plain node.
const tempDir = mkdtempSync(join(tmpdir(), 'owenflow-history-'))
vi.mock('electron', () => ({
  app: { getPath: () => tempDir }
}))

import { append, clear, list, listTags, normalizeTags, updateTags } from '../src/main/history'
import type { HistoryEntry } from '../src/shared/types'

const historyFile = join(tempDir, 'history.jsonl')

const entry = (ts: number, patch: Partial<HistoryEntry> = {}): HistoryEntry => ({
  ts,
  raw: `raw ${ts}`,
  final: `final ${ts}`,
  durationMs: 1000,
  tags: [],
  mode: 'normal',
  ...patch
})

describe('history tags', () => {
  beforeEach(() => clear())
  afterAll(() => rmSync(tempDir, { recursive: true, force: true }))

  it('round-trips: append → updateTags → list shows the tags', () => {
    append(entry(100))
    append(entry(200))

    expect(updateTags(100, ['fluxboard', 'client-email'])).toBe(true)

    const entries = list()
    expect(entries).toHaveLength(2)
    expect(entries.find((e) => e.ts === 100)?.tags).toEqual(['fluxboard', 'client-email'])
    expect(entries.find((e) => e.ts === 200)?.tags).toEqual([])
    // the untouched entry keeps its other fields intact
    expect(entries.find((e) => e.ts === 100)?.final).toBe('final 100')
    expect(entries.find((e) => e.ts === 100)?.mode).toBe('normal')
  })

  it('parses legacy JSONL lines without tags as []', () => {
    // Pre-tags line written by an older version (no tags, no mode).
    writeFileSync(
      historyFile,
      JSON.stringify({ ts: 42, raw: 'old', final: 'old', durationMs: 5 }) + '\n',
      'utf8'
    )
    const [legacy] = list()
    expect(legacy.ts).toBe(42)
    expect(legacy.tags).toEqual([])
    expect(legacy.mode).toBeUndefined()

    // and legacy lines are updatable too
    expect(updateTags(42, ['archive'])).toBe(true)
    expect(list()[0].tags).toEqual(['archive'])
  })

  it('updateTags rewrites only the matching line and preserves corrupt lines', () => {
    append(entry(1))
    writeFileSync(historyFile, readFileSync(historyFile, 'utf8') + 'not json{{{\n', 'utf8')
    append(entry(2))

    expect(updateTags(2, ['Keep ', 'keep', 'OTHER'])).toBe(true)

    const raw = readFileSync(historyFile, 'utf8')
    expect(raw).toContain('not json{{{')
    const entries = list()
    expect(entries.find((e) => e.ts === 2)?.tags).toEqual(['keep', 'other']) // normalized + deduped
    expect(entries.find((e) => e.ts === 1)?.tags).toEqual([])
  })

  it('updateTags persists removal down to an empty tag set (chip ✕ path)', () => {
    append(entry(300, { tags: ['work', 'fluxboard'] }))

    expect(updateTags(300, ['work'])).toBe(true)
    expect(list()[0].tags).toEqual(['work'])

    expect(updateTags(300, [])).toBe(true)
    expect(list()[0].tags).toEqual([])
    expect(listTags()).toEqual([])
  })

  it('updateTags returns false when no entry matches', () => {
    append(entry(7))
    expect(updateTags(999, ['nope'])).toBe(false)
  })

  it('listTags returns distinct tags with counts, most-used first', () => {
    append(entry(1, { tags: ['work', 'fluxboard'] }))
    append(entry(2, { tags: ['work'] }))
    append(entry(3, { tags: ['client-email'] }))

    expect(listTags()).toEqual([
      { tag: 'work', count: 2 },
      { tag: 'client-email', count: 1 },
      { tag: 'fluxboard', count: 1 }
    ])
  })

  it('normalizeTags lowercases, trims, dedupes and drops junk', () => {
    expect(normalizeTags([' Foo ', 'foo', '', 'BAR', 3 as unknown as string])).toEqual([
      'foo',
      'bar'
    ])
    expect(normalizeTags('not-an-array')).toEqual([])
  })
})
