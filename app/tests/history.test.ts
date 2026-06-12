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

import {
  append,
  clear,
  deleteFolder,
  list,
  listFolders,
  listTags,
  normalizeFolder,
  normalizeTags,
  renameFolder,
  setFolder,
  updateTags
} from '../src/main/history'
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

afterAll(() => rmSync(tempDir, { recursive: true, force: true }))

describe('history tags', () => {
  beforeEach(() => clear())

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

describe('history folders', () => {
  beforeEach(() => clear())

  it('round-trips: setFolder → list shows it; setFolder(null) unfiles', () => {
    append(entry(100))
    append(entry(200))

    expect(setFolder(100, 'Client Work')).toBe(true)

    let entries = list()
    expect(entries.find((e) => e.ts === 100)?.folder).toBe('Client Work')
    expect(entries.find((e) => e.ts === 200)?.folder).toBeUndefined()
    // other fields intact
    expect(entries.find((e) => e.ts === 100)?.final).toBe('final 100')

    expect(setFolder(100, null)).toBe(true)
    entries = list()
    expect(entries.find((e) => e.ts === 100)?.folder).toBeUndefined()
    expect(listFolders()).toEqual([])
  })

  it('returns false when no entry matches', () => {
    append(entry(7))
    expect(setFolder(999, 'Nope')).toBe(false)
  })

  it('parses legacy JSONL lines without folder as undefined, and they are filable', () => {
    writeFileSync(
      historyFile,
      JSON.stringify({ ts: 42, raw: 'old', final: 'old', durationMs: 5 }) + '\n',
      'utf8'
    )
    const [legacy] = list()
    expect(legacy.ts).toBe(42)
    expect(legacy.folder).toBeUndefined()

    expect(setFolder(42, 'Archive')).toBe(true)
    expect(list()[0].folder).toBe('Archive')
  })

  it('listFolders returns distinct folders with counts, alphabetical', () => {
    append(entry(1, { folder: 'Work' }))
    append(entry(2, { folder: 'Work' }))
    append(entry(3, { folder: 'Clients' }))
    append(entry(4)) // unfiled — not a folder

    expect(listFolders()).toEqual([
      { folder: 'Clients', count: 1 },
      { folder: 'Work', count: 2 }
    ])
  })

  it('renameFolder rewrites all matching entries and only those', () => {
    append(entry(1, { folder: 'Work' }))
    append(entry(2, { folder: 'Work' }))
    append(entry(3, { folder: 'Clients' }))

    expect(renameFolder('Work', 'Owen Digitals')).toBe(2)

    expect(listFolders()).toEqual([
      { folder: 'Clients', count: 1 },
      { folder: 'Owen Digitals', count: 2 }
    ])
    expect(renameFolder('Missing', 'X')).toBe(0)
    expect(renameFolder('Clients', '   ')).toBe(0) // empty target rejected
  })

  it('deleteFolder unfiles its entries and preserves corrupt lines', () => {
    append(entry(1, { folder: 'Scratch' }))
    writeFileSync(historyFile, readFileSync(historyFile, 'utf8') + 'not json{{{\n', 'utf8')
    append(entry(2, { folder: 'Scratch' }))
    append(entry(3, { folder: 'Keep' }))

    expect(deleteFolder('Scratch')).toBe(2)

    expect(readFileSync(historyFile, 'utf8')).toContain('not json{{{')
    expect(listFolders()).toEqual([{ folder: 'Keep', count: 1 }])
    expect(list().filter((e) => e.folder === undefined)).toHaveLength(2)
  })

  it('folder ops leave tags untouched, and tag ops leave folders untouched', () => {
    append(entry(1, { tags: ['work', 'fluxboard'] }))

    expect(setFolder(1, 'Inbox')).toBe(true)
    expect(list()[0].tags).toEqual(['work', 'fluxboard'])

    expect(renameFolder('Inbox', 'Outbox')).toBe(1)
    expect(list()[0].tags).toEqual(['work', 'fluxboard'])

    expect(updateTags(1, ['work'])).toBe(true)
    expect(list()[0].folder).toBe('Outbox')

    expect(deleteFolder('Outbox')).toBe(1)
    expect(list()[0].tags).toEqual(['work'])
    expect(list()[0].folder).toBeUndefined()
  })

  it('normalizeFolder trims, caps at 40 chars and keeps case', () => {
    expect(normalizeFolder('  Client Work  ')).toBe('Client Work')
    expect(normalizeFolder('x'.repeat(60))).toBe('x'.repeat(40))
    expect(normalizeFolder('   ')).toBeUndefined()
    expect(normalizeFolder(7)).toBeUndefined()
    expect(normalizeFolder(undefined)).toBeUndefined()
  })
})
