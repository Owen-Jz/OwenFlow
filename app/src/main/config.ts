import Store from 'electron-store'
import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { CleanupIntensity, OwenFlowSettings } from '../shared/types'
import { DEFAULT_PROFILES } from './profiles'

export const DEFAULT_SETTINGS: OwenFlowSettings = {
  hotkey: 'RightCtrl',
  mode: 'hold',
  flowMode: 'normal',
  model: 'small',
  language: '',
  // Fresh installs default to the medium Auto Cleanup intensity; the legacy
  // cleanupEnabled toggle mirrors it (true ⇔ intensity !== 'none').
  cleanupEnabled: true,
  cleanupIntensity: 'medium',
  cleanupProvider: 'groq',
  minimaxApiKey: '',
  minimaxGroupId: '',
  groqApiKey: '',
  groqModel: 'llama-3.3-70b-versatile',
  // Fast tier for normal-mode cleanup + digest summaries (benchmarked equal
  // quality to the 70b at ~330ms vs ~780ms). Configs predating the field get
  // this default via electron-store defaults + the getSettings() spread.
  groqModelFast: 'llama-3.1-8b-instant',
  dictionary: [],
  snippets: [],
  translateTarget: 'English',
  sessionTones: [],
  activeSession: '',
  appProfilesEnabled: false,
  profiles: DEFAULT_PROFILES,
  digestEnabled: true,
  digestHour: 18,
  digestThemes: false,
  commandEnabled: false,
  commandHotkey: 'RightAlt',
  // Tap to cycle flow modes (normal → vibe → formal). Empty string disables.
  modeHotkey: 'F9',
  continuousMode: false,
  zealEndpoint: 'https://173-212-225-7.sslip.io/api/voice',
  zealApiKey: '',
  zealSpeakReplies: true,
  launchOnStartup: false,
  theme: 'dark',
  pillPosition: 'bottom-center'
}

// Captured BEFORE the store is instantiated (electron-store may write the
// file with defaults on first construction).
const settingsFilePath = join(app.getPath('userData'), 'config.json')
const settingsFileExisted = existsSync(settingsFilePath)

/** True when no settings file existed at boot (very first launch). */
export function isFirstRun(): boolean {
  return !settingsFileExisted
}

/**
 * Derive cleanupIntensity for configs written before the field existed: the
 * legacy cleanupEnabled master toggle maps on → 'medium', off/absent → 'none'
 * (absent behaved as off — the old default was false). Returns undefined when
 * no migration is needed (the field is already present).
 */
export function deriveCleanupIntensity(
  raw: Record<string, unknown>
): CleanupIntensity | undefined {
  if (raw.cleanupIntensity !== undefined) return undefined
  return raw.cleanupEnabled === true ? 'medium' : 'none'
}

// Raw pre-migration file contents, read BEFORE the store is constructed —
// electron-store merges defaults into the file at construction, which would
// make "field was missing" undetectable afterwards.
const rawLegacyConfig: Record<string, unknown> = (() => {
  if (!settingsFileExisted) return {}
  try {
    return JSON.parse(readFileSync(settingsFilePath, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
})()

const store = new Store<OwenFlowSettings>({
  name: 'config',
  defaults: DEFAULT_SETTINGS,
  schema: {
    hotkey: { type: 'string', default: 'RightCtrl' },
    mode: { type: 'string', enum: ['hold', 'toggle'], default: 'hold' },
    flowMode: { type: 'string', enum: ['normal', 'vibe', 'formal', 'translate'], default: 'normal' },
    model: {
      type: 'string',
      enum: ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo'],
      default: 'small'
    },
    language: { type: 'string', default: '' },
    cleanupEnabled: { type: 'boolean', default: true },
    cleanupIntensity: {
      type: 'string',
      enum: ['none', 'light', 'medium', 'high'],
      default: 'medium'
    },
    cleanupProvider: { type: 'string', enum: ['groq', 'minimax'], default: 'groq' },
    minimaxApiKey: { type: 'string', default: '' },
    minimaxGroupId: { type: 'string', default: '' },
    groqApiKey: { type: 'string', default: '' },
    groqModel: { type: 'string', default: 'llama-3.3-70b-versatile' },
    groqModelFast: { type: 'string', default: 'llama-3.1-8b-instant' },
    dictionary: { type: 'array', items: { type: 'string' }, default: [] },
    snippets: { type: 'array', items: { type: 'string' }, default: [] },
    translateTarget: { type: 'string', default: 'English' },
    sessionTones: { type: 'array', items: { type: 'string' }, default: [] },
    activeSession: { type: 'string', default: '' },
    appProfilesEnabled: { type: 'boolean', default: false },
    profiles: { type: 'array', default: [] },
    digestEnabled: { type: 'boolean', default: true },
    digestHour: { type: 'number', minimum: 0, maximum: 23, default: 18 },
    digestThemes: { type: 'boolean', default: false },
    commandEnabled: { type: 'boolean', default: false },
    commandHotkey: { type: 'string', default: 'RightAlt' },
    modeHotkey: { type: 'string', default: 'F9' },
    continuousMode: { type: 'boolean', default: false },
    zealEndpoint: { type: 'string', default: 'https://173-212-225-7.sslip.io/api/voice' },
    zealApiKey: { type: 'string', default: '' },
    zealSpeakReplies: { type: 'boolean', default: true },
    launchOnStartup: { type: 'boolean', default: false },
    theme: { type: 'string', enum: ['dark', 'light', 'system'], default: 'dark' },
    pillPosition: {
      type: 'string',
      enum: ['bottom-center', 'top-center', 'bottom-left', 'bottom-right'],
      default: 'bottom-center'
    }
  }
})

// Migration: configs from before cleanupIntensity existed get it derived from
// the legacy cleanupEnabled toggle (on → 'medium', off → 'none') instead of
// the fresh-install 'medium' default; the toggle is re-synced for older
// readers that still gate on it.
{
  const migrated = settingsFileExisted ? deriveCleanupIntensity(rawLegacyConfig) : undefined
  if (migrated !== undefined) {
    store.set('cleanupIntensity', migrated)
    store.set('cleanupEnabled', migrated !== 'none')
  }
}

export function getSettings(): OwenFlowSettings {
  return { ...DEFAULT_SETTINGS, ...store.store }
}

export function setSettings(patch: Partial<OwenFlowSettings>): OwenFlowSettings {
  // electron-store validates against the schema; strip undefined values first.
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      store.set(key as keyof OwenFlowSettings, value)
    }
  }
  return getSettings()
}

export type SettingsListener = (next: OwenFlowSettings, prev: OwenFlowSettings) => void

/** Subscribe to any settings change. Returns unsubscribe. */
export function onSettingsChange(listener: SettingsListener): () => void {
  return store.onDidAnyChange((next, prev) => {
    listener(
      { ...DEFAULT_SETTINGS, ...(next ?? {}) },
      { ...DEFAULT_SETTINGS, ...(prev ?? {}) }
    )
  })
}

/**
 * Dictionary parsing lives in dictionary.ts (pure module, unit-testable
 * without electron); re-exported here so config still owns the format.
 */
export { parseDictionary } from './dictionary'
