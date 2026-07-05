import { describe, expect, it, vi } from 'vitest'

// config.ts touches electron (userData path) and electron-store at module
// load — stub both so the defaults/schema are testable in plain node.
const captured = vi.hoisted(() => ({ options: undefined as Record<string, unknown> | undefined }))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/owenflow-config-test' }
}))

vi.mock('electron-store', () => ({
  default: class MockStore {
    store: Record<string, unknown> = {}
    constructor(options: Record<string, unknown>) {
      captured.options = options
    }
    set(key: string, value: unknown): void {
      this.store[key] = value
    }
    onDidAnyChange(): () => void {
      return () => {}
    }
  }
}))

import { DEFAULT_SETTINGS, deriveCleanupIntensity, getSettings } from '../src/main/config'

describe('config theme setting', () => {
  it('defaults theme to dark', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('dark')
    expect(getSettings().theme).toBe('dark')
  })

  it('declares the theme schema as dark | light | system with dark default', () => {
    const schema = captured.options?.schema as Record<string, { enum?: string[]; default?: string }>
    expect(schema.theme.enum).toEqual(['dark', 'light', 'system'])
    expect(schema.theme.default).toBe('dark')
  })
})

describe('config cleanup provider', () => {
  it('defaults cleanupProvider to groq', () => {
    expect(DEFAULT_SETTINGS.cleanupProvider).toBe('groq')
    expect(getSettings().cleanupProvider).toBe('groq')
  })

  it('defaults groqModel to llama-3.3-70b-versatile', () => {
    expect(DEFAULT_SETTINGS.groqModel).toBe('llama-3.3-70b-versatile')
    expect(DEFAULT_SETTINGS.groqApiKey).toBe('')
  })

  // Fast tier for normal-mode cleanup + digest (2026-07-04 benchmark: equal
  // quality to the 70b at ~330ms vs ~780ms). Configs missing the field get
  // the default via electron-store defaults + the getSettings() spread.
  it('defaults groqModelFast to llama-3.1-8b-instant', () => {
    expect(DEFAULT_SETTINGS.groqModelFast).toBe('llama-3.1-8b-instant')
    expect(getSettings().groqModelFast).toBe('llama-3.1-8b-instant')
  })

  it('declares cleanupProvider schema as groq | minimax with groq default', () => {
    const schema = captured.options?.schema as Record<
      string,
      { enum?: string[]; default?: string; type?: string }
    >
    expect(schema.cleanupProvider.enum).toEqual(['groq', 'minimax'])
    expect(schema.cleanupProvider.default).toBe('groq')
    expect(schema.groqModel.default).toBe('llama-3.3-70b-versatile')
    expect(schema.groqModelFast.type).toBe('string')
    expect(schema.groqModelFast.default).toBe('llama-3.1-8b-instant')
  })
})

describe('config auto cleanup intensity', () => {
  it('fresh installs default cleanupIntensity to medium (and the legacy toggle to on)', () => {
    expect(DEFAULT_SETTINGS.cleanupIntensity).toBe('medium')
    expect(DEFAULT_SETTINGS.cleanupEnabled).toBe(true)
    expect(getSettings().cleanupIntensity).toBe('medium')
  })

  it('declares the cleanupIntensity schema as none | light | medium | high with medium default', () => {
    const schema = captured.options?.schema as Record<string, { enum?: string[]; default?: string }>
    expect(schema.cleanupIntensity.enum).toEqual(['none', 'light', 'medium', 'high'])
    expect(schema.cleanupIntensity.default).toBe('medium')
  })

  describe('migration (deriveCleanupIntensity on the raw pre-store file)', () => {
    it('config without the field and cleanupEnabled true derives medium', () => {
      expect(deriveCleanupIntensity({ cleanupEnabled: true })).toBe('medium')
    })

    it('config without the field and cleanupEnabled false derives none', () => {
      expect(deriveCleanupIntensity({ cleanupEnabled: false })).toBe('none')
    })

    it('config without either field derives none (old default was cleanup off)', () => {
      expect(deriveCleanupIntensity({})).toBe('none')
    })

    it('config that already has cleanupIntensity is not migrated', () => {
      expect(deriveCleanupIntensity({ cleanupIntensity: 'light', cleanupEnabled: false })).toBe(
        undefined
      )
      expect(deriveCleanupIntensity({ cleanupIntensity: 'none' })).toBe(undefined)
    })
  })
})

describe('config batch-A settings', () => {
  it('declares new defaults', () => {
    expect(DEFAULT_SETTINGS.snippets).toEqual([])
    expect(DEFAULT_SETTINGS.translateTarget).toBe('English')
    expect(DEFAULT_SETTINGS.sessionTones).toEqual([])
    expect(DEFAULT_SETTINGS.activeSession).toBe('')
  })

  it('flowMode schema includes translate', () => {
    const schema = captured.options?.schema as Record<string, { enum?: string[] }>
    expect(schema.flowMode.enum).toEqual(['normal', 'vibe', 'formal', 'translate'])
  })
})

describe('config app profiles', () => {
  it('defaults appProfilesEnabled false and seeds preset profiles', () => {
    expect(DEFAULT_SETTINGS.appProfilesEnabled).toBe(false)
    expect(Array.isArray(DEFAULT_SETTINGS.profiles)).toBe(true)
    expect(DEFAULT_SETTINGS.profiles.length).toBeGreaterThan(0)
    expect(DEFAULT_SETTINGS.profiles[0].match).toContain('Code')
  })
})

describe('config digest', () => {
  it('declares digest defaults', () => {
    expect(DEFAULT_SETTINGS.digestEnabled).toBe(true)
    expect(DEFAULT_SETTINGS.digestHour).toBe(18)
    expect(DEFAULT_SETTINGS.digestThemes).toBe(false)
  })
})

describe('config command channel', () => {
  it('defaults commandEnabled false and commandHotkey RightAlt', () => {
    expect(DEFAULT_SETTINGS.commandEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.commandHotkey).toBe('RightAlt')
  })
})

describe('config mode-switch hotkey', () => {
  it('defaults modeHotkey to F9 (empty string = disabled)', () => {
    expect(DEFAULT_SETTINGS.modeHotkey).toBe('F9')
    expect(getSettings().modeHotkey).toBe('F9')
  })

  it('declares the modeHotkey schema as a string with F9 default', () => {
    const schema = captured.options?.schema as Record<string, { type?: string; default?: string }>
    expect(schema.modeHotkey.type).toBe('string')
    expect(schema.modeHotkey.default).toBe('F9')
  })
})

describe('config meeting hotkey', () => {
  it('defaults meetingHotkey to F10 (empty string = disabled)', () => {
    expect(DEFAULT_SETTINGS.meetingHotkey).toBe('F10')
    expect(getSettings().meetingHotkey).toBe('F10')
  })

  it('declares the meetingHotkey schema as a string with F10 default', () => {
    const schema = captured.options?.schema as Record<string, { type?: string; default?: string }>
    expect(schema.meetingHotkey.type).toBe('string')
    expect(schema.meetingHotkey.default).toBe('F10')
  })
})

describe('config continuous mode', () => {
  it('defaults continuousMode to false', () => {
    expect(DEFAULT_SETTINGS.continuousMode).toBe(false)
  })
})

describe('config pill position', () => {
  it('defaults pillPosition to bottom-center (Wispr-compatible default)', () => {
    expect(DEFAULT_SETTINGS.pillPosition).toBe('bottom-center')
    expect(getSettings().pillPosition).toBe('bottom-center')
  })

  it('declares the pillPosition schema with all four placements and bottom-center default', () => {
    const schema = captured.options?.schema as Record<string, { enum?: string[]; default?: string }>
    expect(schema.pillPosition.enum).toEqual([
      'bottom-center',
      'top-center',
      'bottom-left',
      'bottom-right'
    ])
    expect(schema.pillPosition.default).toBe('bottom-center')
  })
})

describe('config ZEAL voice client', () => {
  it('defaults zealEndpoint to the VPS /api/voice URL, zealApiKey empty, zealSpeakReplies true', () => {
    expect(DEFAULT_SETTINGS.zealEndpoint).toContain('/api/voice')
    expect(DEFAULT_SETTINGS.zealApiKey).toBe('')
    expect(DEFAULT_SETTINGS.zealSpeakReplies).toBe(true)
  })

  it('declares schema entries for all three ZEAL voice settings', () => {
    const schema = captured.options?.schema as Record<string, { type?: string; default?: unknown }>
    expect(schema.zealEndpoint.type).toBe('string')
    expect(schema.zealEndpoint.default).toContain('/api/voice')
    expect(schema.zealApiKey.type).toBe('string')
    expect(schema.zealApiKey.default).toBe('')
    expect(schema.zealSpeakReplies.type).toBe('boolean')
    expect(schema.zealSpeakReplies.default).toBe(true)
  })
})
