import { describe, expect, it } from 'vitest'
import { isSelfApp, parseConsentStore } from '../src/main/meeting-detect'

const REG = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Users#owen#AppData#Local#Programs#OwenFlow#OwenFlow.exe',
  '    LastUsedTimeStart    REG_QWORD    0x1dc4f2a8e33f2a0',
  '    LastUsedTimeStop     REG_QWORD    0x0',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Users#owen#AppData#Local#Zoom#bin#Zoom.exe',
  '    LastUsedTimeStart    REG_QWORD    0x1dc4f2a8e4411b0',
  '    LastUsedTimeStop     REG_QWORD    0x0',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Program Files#Slack#slack.exe',
  '    LastUsedTimeStart    REG_QWORD    0x1dc4f00000000000',
  '    LastUsedTimeStop     REG_QWORD    0x1dc4f11111111111'
].join('\r\n')

describe('parseConsentStore', () => {
  it('returns only apps with Start set and Stop == 0 (live on the mic)', () => {
    expect(parseConsentStore(REG)).toEqual([
      'C:\\Users\\owen\\AppData\\Local\\Programs\\OwenFlow\\OwenFlow.exe',
      'C:\\Users\\owen\\AppData\\Local\\Zoom\\bin\\Zoom.exe'
    ])
  })

  it('returns [] on empty/garbage input', () => {
    expect(parseConsentStore('')).toEqual([])
    expect(parseConsentStore('ERROR: The system was unable to find the specified registry key')).toEqual([])
  })

  it('ignores an entry whose Start is 0 even when Stop is 0 (never used)', () => {
    const never = REG.replace('0x1dc4f2a8e4411b0', '0x0')
    expect(parseConsentStore(never)).toEqual([
      'C:\\Users\\owen\\AppData\\Local\\Programs\\OwenFlow\\OwenFlow.exe'
    ])
  })
})

describe('isSelfApp', () => {
  it('flags OwenFlow and dev-mode electron binaries', () => {
    expect(isSelfApp('C:\\Users\\owen\\AppData\\Local\\Programs\\OwenFlow\\OwenFlow.exe')).toBe(true)
    expect(isSelfApp('C:\\repo\\node_modules\\electron\\dist\\electron.exe')).toBe(true)
    expect(isSelfApp('C:\\Users\\owen\\AppData\\Local\\Zoom\\bin\\Zoom.exe')).toBe(false)
  })
})
