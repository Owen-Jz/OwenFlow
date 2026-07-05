/**
 * Meeting transcript storage — one folder per meeting under
 * <userData>/meetings/<id>/ holding:
 *
 *   transcript.jsonl  — one line per transcribed segment
 *                       {"t":<epochMs>,"speaker":"you"|"them","text":"..."}
 *   meta.json         — {id, startedAt, endedAt?, durationMs?, words?, summary?}
 *
 * Crash-safety is the whole design: appendEntry is a plain fs append (each
 * segment lands on disk the moment it's transcribed — a crash 2h into a
 * meeting loses at most the in-flight segment), while meta.json goes through
 * the same temp-file+rename dance as history.ts so a crash mid-write can't
 * leave a torn JSON file. The transcript is never rewritten, only appended.
 *
 * Ids are local-time "YYYY-MM-DD-HHmmss" (also the folder name). Every id
 * that arrives over IPC is validated against that shape before touching the
 * filesystem — a hostile "../../" id must never traverse out of meetings/.
 */

import { app } from 'electron'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import type { MeetingEntry, MeetingMeta } from '../shared/types'

function meetingsDir(): string {
  return join(app.getPath('userData'), 'meetings')
}

function meetingDir(id: string): string {
  return join(meetingsDir(), id)
}

const ID_RE = /^\d{4}-\d{2}-\d{2}-\d{6}$/

/** True when `id` is a well-formed meeting id (path-traversal gate for IPC input). */
export function isValidMeetingId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

/** Local-time meeting id for a moment: "YYYY-MM-DD-HHmmss". */
export function meetingIdFor(date: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/**
 * Create a meeting: folder + initial meta.json ({id, startedAt}). Writing the
 * meta UP FRONT means even a meeting that crashes before its first segment is
 * still listable. Two starts inside the same wall-clock second (stop→start
 * cycling) collide on the id — bump the second until a free slot is found
 * (the id is just a key; startedAt keeps the true epoch).
 */
export function createMeeting(startedAt: number): string {
  mkdirSync(meetingsDir(), { recursive: true })
  let date = new Date(startedAt)
  let id = meetingIdFor(date)
  while (existsSync(meetingDir(id))) {
    date = new Date(date.getTime() + 1000)
    id = meetingIdFor(date)
  }
  mkdirSync(meetingDir(id))
  writeMeta(id, { id, startedAt })
  return id
}

/**
 * Append one transcribed segment to the meeting's JSONL — the crash-safety
 * hot path (called once per segment, immediately after transcription).
 */
export function appendEntry(id: string, entry: MeetingEntry): void {
  if (!isValidMeetingId(id)) return
  appendFileSync(join(meetingDir(id), 'transcript.jsonl'), JSON.stringify(entry) + '\n', 'utf8')
}

function parseEntry(line: string): MeetingEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as MeetingEntry
    if (typeof parsed.t !== 'number') return null
    if (parsed.speaker !== 'you' && parsed.speaker !== 'them') return null
    if (typeof parsed.text !== 'string') return null
    return parsed
  } catch {
    return null // skip corrupt lines (e.g. a crash mid-append) rather than failing the meeting
  }
}

/** Full transcript of a meeting, in append (arrival) order. */
export function readEntries(id: string): MeetingEntry[] {
  if (!isValidMeetingId(id)) return []
  const file = join(meetingDir(id), 'transcript.jsonl')
  if (!existsSync(file)) return []
  const entries: MeetingEntry[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const parsed = parseEntry(line)
    if (parsed) entries.push(parsed)
  }
  return entries
}

/** The meeting's meta.json, or null when missing/corrupt/invalid id. */
export function readMeta(id: string): MeetingMeta | null {
  if (!isValidMeetingId(id)) return null
  const file = join(meetingDir(id), 'meta.json')
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as MeetingMeta
    if (typeof parsed.startedAt !== 'number') return null
    return { ...parsed, id } // the folder name is authoritative for the id
  } catch {
    return null
  }
}

/**
 * Replace the meeting's meta.json. Temp-file + rename so a crash mid-write
 * can't tear the JSON (rename is atomic on the same volume).
 */
export function writeMeta(id: string, meta: MeetingMeta): void {
  if (!isValidMeetingId(id)) return
  const dir = meetingDir(id)
  if (!existsSync(dir)) return // meeting was deleted out from under a late writer
  const file = join(dir, 'meta.json')
  const tmp = `${file}.tmp`
  // Stamp every write centrally so "Updated" in the Meetings UI is real data
  // (meeting end, word-count refresh, later summary) with no caller effort.
  writeFileSync(tmp, JSON.stringify({ ...meta, updatedAt: Date.now() }), 'utf8')
  renameSync(tmp, file)
}

/** All recorded meetings, newest first (by startedAt; id breaks ties). */
export function listMeetings(): MeetingMeta[] {
  const dir = meetingsDir()
  if (!existsSync(dir)) return []
  const metas: MeetingMeta[] = []
  for (const name of readdirSync(dir)) {
    if (!isValidMeetingId(name)) continue
    const meta = readMeta(name)
    if (meta) metas.push(meta)
  }
  return metas.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
}

/**
 * One meeting's meta + full transcript. Total function (the preload contract
 * promises {meta, entries}): an unknown/deleted id gets a synthesized stub
 * meta and an empty transcript instead of a null the UI would have to guard.
 */
export function getMeeting(id: string): { meta: MeetingMeta; entries: MeetingEntry[] } {
  const meta = readMeta(id) ?? { id: isValidMeetingId(id) ? id : '', startedAt: 0 }
  return { meta, entries: readEntries(id) }
}

/** Delete a meeting's folder (transcript + meta) entirely. */
export function removeMeeting(id: string): void {
  if (!isValidMeetingId(id)) return
  rmSync(meetingDir(id), { recursive: true, force: true })
}
