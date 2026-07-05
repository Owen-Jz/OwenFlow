import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// meeting-store.ts resolves its folder through electron's app.getPath —
// point it at a throwaway temp dir so the tests run in plain node.
const tempDir = mkdtempSync(join(tmpdir(), 'owenflow-meetings-'))
vi.mock('electron', () => ({
  app: { getPath: () => tempDir }
}))

import {
  appendEntry,
  createMeeting,
  getMeeting,
  isValidMeetingId,
  listMeetings,
  meetingIdFor,
  readEntries,
  readMeta,
  removeMeeting,
  renameMeeting,
  writeMeta
} from '../src/main/meeting-store'
import type { MeetingEntry } from '../src/shared/types'

const meetingsDir = join(tempDir, 'meetings')

const entry = (t: number, patch: Partial<MeetingEntry> = {}): MeetingEntry => ({
  t,
  speaker: 'you',
  text: `text ${t}`,
  ...patch
})

beforeEach(() => rmSync(meetingsDir, { recursive: true, force: true }))
afterAll(() => rmSync(tempDir, { recursive: true, force: true }))

describe('meeting ids', () => {
  it('meetingIdFor formats local time as YYYY-MM-DD-HHmmss', () => {
    expect(meetingIdFor(new Date(2026, 6, 5, 14, 3, 9))).toBe('2026-07-05-140309')
  })

  it('isValidMeetingId accepts the shape and rejects traversal attempts', () => {
    expect(isValidMeetingId('2026-07-05-140309')).toBe(true)
    expect(isValidMeetingId('..')).toBe(false)
    expect(isValidMeetingId('../2026-07-05-140309')).toBe(false)
    expect(isValidMeetingId('2026-07-05')).toBe(false)
    expect(isValidMeetingId(42)).toBe(false)
  })
})

describe('createMeeting', () => {
  it('creates the folder and writes the initial meta (listable even pre-segment)', () => {
    const startedAt = new Date(2026, 6, 5, 10, 0, 0).getTime()
    const id = createMeeting(startedAt)
    expect(isValidMeetingId(id)).toBe(true)
    expect(existsSync(join(meetingsDir, id))).toBe(true)
    // every meta write is stamped with updatedAt (the Meetings UI's "Updated")
    expect(readMeta(id)).toMatchObject({ id, startedAt })
    expect(typeof readMeta(id)?.updatedAt).toBe('number')
  })

  it('bumps the id on a same-second collision (stop→start cycling)', () => {
    const startedAt = new Date(2026, 6, 5, 10, 0, 0).getTime()
    const a = createMeeting(startedAt)
    const b = createMeeting(startedAt)
    expect(a).not.toBe(b)
    // both keep the TRUE start epoch — the id is just a key
    expect(readMeta(a)?.startedAt).toBe(startedAt)
    expect(readMeta(b)?.startedAt).toBe(startedAt)
  })
})

describe('transcript append/read', () => {
  it('round-trips entries in append order', () => {
    const id = createMeeting(Date.now())
    appendEntry(id, entry(100))
    appendEntry(id, entry(200, { speaker: 'them', text: 'they said' }))
    expect(readEntries(id)).toEqual([
      { t: 100, speaker: 'you', text: 'text 100' },
      { t: 200, speaker: 'them', text: 'they said' }
    ])
  })

  it('skips corrupt lines (crash mid-append) instead of failing the meeting', () => {
    const id = createMeeting(Date.now())
    appendEntry(id, entry(1))
    const file = join(meetingsDir, id, 'transcript.jsonl')
    writeFileSync(file, readFileSync(file, 'utf8') + '{"t":2,"speaker"\n', 'utf8')
    appendEntry(id, entry(3))
    expect(readEntries(id).map((e) => e.t)).toEqual([1, 3])
  })

  it('rejects lines with a bad speaker or missing fields', () => {
    const id = createMeeting(Date.now())
    const file = join(meetingsDir, id, 'transcript.jsonl')
    writeFileSync(
      file,
      [
        JSON.stringify({ t: 1, speaker: 'narrator', text: 'x' }),
        JSON.stringify({ t: 2, speaker: 'you' }),
        JSON.stringify({ t: 3, speaker: 'them', text: 'ok' })
      ].join('\n') + '\n',
      'utf8'
    )
    expect(readEntries(id)).toEqual([{ t: 3, speaker: 'them', text: 'ok' }])
  })

  it('ignores invalid ids entirely (no throw, no file)', () => {
    expect(() => appendEntry('../evil', entry(1))).not.toThrow()
    expect(readEntries('../evil')).toEqual([])
  })
})

describe('meta', () => {
  it('writeMeta/readMeta round-trip; the folder name is authoritative for id', () => {
    const id = createMeeting(1000)
    writeMeta(id, { id: 'spoofed-id-ignored', startedAt: 1000, endedAt: 5000, words: 42 })
    expect(readMeta(id)).toMatchObject({ id, startedAt: 1000, endedAt: 5000, words: 42 })
    expect(typeof readMeta(id)?.updatedAt).toBe('number')
  })

  it('renameMeeting sets, trims, and clears the custom title', () => {
    const id = createMeeting(1000)
    expect(renameMeeting(id, '  Nomba sync  ')).toBe(true)
    expect(readMeta(id)?.title).toBe('Nomba sync')
    // blank clears the field entirely (UI falls back to the friendly date)
    expect(renameMeeting(id, '   ')).toBe(true)
    expect(readMeta(id)?.title).toBeUndefined()
    // unknown/invalid ids refuse without touching disk
    expect(renameMeeting('2020-01-01-000000', 'x')).toBe(false)
    expect(renameMeeting('../evil', 'x')).toBe(false)
  })

  it('readMeta returns null for unknown ids and corrupt files', () => {
    expect(readMeta('2020-01-01-000000')).toBeNull()
    const id = createMeeting(Date.now())
    writeFileSync(join(meetingsDir, id, 'meta.json'), 'not json', 'utf8')
    expect(readMeta(id)).toBeNull()
  })

  it('writeMeta after the meeting folder is deleted is a silent no-op', () => {
    const id = createMeeting(Date.now())
    removeMeeting(id)
    expect(() => writeMeta(id, { id, startedAt: 1 })).not.toThrow()
    expect(existsSync(join(meetingsDir, id))).toBe(false)
  })
})

describe('listMeetings', () => {
  it('lists newest first by startedAt', () => {
    const a = createMeeting(new Date(2026, 0, 1, 9, 0, 0).getTime())
    const b = createMeeting(new Date(2026, 0, 2, 9, 0, 0).getTime())
    const c = createMeeting(new Date(2026, 0, 3, 9, 0, 0).getTime())
    expect(listMeetings().map((m) => m.id)).toEqual([c, b, a])
  })

  it('skips foreign folders and empty state', () => {
    expect(listMeetings()).toEqual([])
    createMeeting(Date.now())
    mkdirSync(join(meetingsDir, 'not-a-meeting'))
    expect(listMeetings()).toHaveLength(1)
  })
})

describe('getMeeting / removeMeeting', () => {
  it('returns meta + entries together', () => {
    const id = createMeeting(500)
    appendEntry(id, entry(1))
    const { meta, entries } = getMeeting(id)
    expect(meta.id).toBe(id)
    expect(meta.startedAt).toBe(500)
    expect(entries).toHaveLength(1)
  })

  it('is total: unknown id yields a stub meta and empty transcript', () => {
    const { meta, entries } = getMeeting('2020-01-01-000000')
    expect(meta).toEqual({ id: '2020-01-01-000000', startedAt: 0 })
    expect(entries).toEqual([])
  })

  it('removeMeeting deletes the whole folder; invalid ids are no-ops', () => {
    const id = createMeeting(Date.now())
    appendEntry(id, entry(1))
    removeMeeting(id)
    expect(existsSync(join(meetingsDir, id))).toBe(false)
    expect(() => removeMeeting('../..')).not.toThrow()
    expect(existsSync(tempDir)).toBe(true)
  })
})
