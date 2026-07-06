/**
 * Call detection via Windows' microphone ConsentStore: the OS records, per
 * exe, when it last started/stopped using the mic (this powers the tray
 * "microphone in use" indicator). An app with LastUsedTimeStart != 0 and
 * LastUsedTimeStop == 0 is holding the mic RIGHT NOW — Zoom, Teams, Chrome
 * running Meet, WhatsApp calls all show up here with zero per-app logic.
 */

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
