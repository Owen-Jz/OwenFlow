/**
 * Call detection via Windows' microphone ConsentStore: the OS records, per
 * exe, when it last started/stopped using the mic (this powers the tray
 * "microphone in use" indicator). An app with LastUsedTimeStart != 0 and
 * LastUsedTimeStop == 0 is holding the mic RIGHT NOW — Zoom, Teams, Chrome
 * running Meet, WhatsApp calls all show up here with zero per-app logic.
 */

import { spawnSync } from 'node:child_process'
import { Notification } from 'electron'
import type { OwenFlowSettings } from '../shared/types'

const KEY_MARKER = '\\ConsentStore\\microphone\\NonPackaged\\'

/** Exe paths currently holding the mic, from `reg query <key> /s` output. */
export function parseConsentStore(regOutput: string): string[] {
  const live: string[] = []
  let app: string | null = null
  let start = 0n
  let stop = 0n
  const flush = (): void => {
    if (app && start !== 0n && stop === 0n) live.push(app)
  }
  for (const line of regOutput.split(/\r?\n/)) {
    const marker = line.indexOf(KEY_MARKER)
    if (line.startsWith('HKEY_') && marker >= 0) {
      flush()
      // exe paths are stored with '#' standing in for '\'
      app = line.slice(marker + KEY_MARKER.length).replace(/#/g, '\\')
      start = 0n
      stop = 0n
      continue
    }
    const value = /^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+(0x[0-9a-fA-F]+)/.exec(line)
    if (value) {
      if (value[1] === 'LastUsedTimeStart') start = BigInt(value[2])
      else stop = BigInt(value[2])
    }
  }
  flush()
  return live
}

/** OwenFlow's own capture (warm mic, dictation, meetings) must never self-trigger. */
export function isSelfApp(path: string): boolean {
  return /owenflow|[\\/]electron\.exe$/i.test(path)
}

// ─── Detection decision + poller ─────────────────────────────────────────────

const POLL_MS = 20_000
/** One nag per call, roughly — re-prompting mid-meeting is worse than missing one. */
const PROMPT_COOLDOWN_MS = 10 * 60_000
const CONSENT_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged'

/** Pure gate: a foreign app on the mic + outside the cooldown window. */
export function shouldPrompt(
  liveApps: string[],
  state: { lastPromptAt: number; now: number }
): boolean {
  if (state.now - state.lastPromptAt < PROMPT_COOLDOWN_MS) return false
  return liveApps.some((app) => !isSelfApp(app))
}

function queryConsentStoreReal(): string {
  const res = spawnSync('reg', ['query', CONSENT_KEY, '/s'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000
  })
  return res.stdout ?? ''
}

export interface MeetingDetectDeps {
  getSettings: () => OwenFlowSettings
  isMeetingActive: () => boolean
  startMeeting: () => void
  /** DI seam for tests: defaults to the real `reg query` runner. */
  queryConsentStore?: () => string
}

let timer: NodeJS.Timeout | null = null
let lastPromptAt = 0

/** Test seam + used on meeting start so an accepted prompt re-arms cleanly. */
export function notePromptShown(now: number): void {
  lastPromptAt = now
}

export function startMeetingDetect(deps: MeetingDetectDeps): void {
  stopMeetingDetect()
  const query = deps.queryConsentStore ?? queryConsentStoreReal
  timer = setInterval(() => {
    try {
      if (!deps.getSettings().meetingAutoDetect) return
      if (deps.isMeetingActive()) return
      const live = parseConsentStore(query())
      if (!shouldPrompt(live, { lastPromptAt, now: Date.now() })) return
      lastPromptAt = Date.now()
      const note = new Notification({
        title: 'Call detected',
        body: 'Another app is using your microphone. Record and transcribe this meeting?'
      })
      note.on('click', () => deps.startMeeting())
      note.show()
    } catch {
      // detection is best-effort; a registry hiccup must never surface
    }
  }, POLL_MS)
}

export function stopMeetingDetect(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
