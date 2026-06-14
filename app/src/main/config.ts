import Store from 'electron-store'
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import type { OwenFlowSettings } from '../shared/types'
import { DEFAULT_PROFILES } from './profiles'

export const DEFAULT_SETTINGS: OwenFlowSettings = {
  hotkey: 'RightCtrl',
  mode: 'hold',
  flowMode: 'normal',
  model: 'small',
  language: '',
  cleanupEnabled: false,
  cleanupProvider: 'groq',
  minimaxApiKey: '',
  minimaxGroupId: '',
  groqApiKey: '',
  groqModel: 'llama-3.3-70b-versatile',
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
  continuousMode: false,
  zealEndpoint: 'https://173-212-225-7.sslip.io/api/voice',
  zealApiKey: '',
  zealSpeakReplies: true,
  launchOnStartup: false,
  theme: 'dark'
}

// Captured BEFORE the store is instantiated (electron-store may write the
// file with defaults on first construction).
const settingsFileExisted = existsSync(join(app.getPath('userData'), 'config.json'))

/** True when no settings file existed at boot (very first launch). */
export function isFirstRun(): boolean {
  return !settingsFileExisted
}

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
    cleanupEnabled: { type: 'boolean', default: false },
    cleanupProvider: { type: 'string', enum: ['groq', 'minimax'], default: 'groq' },
    minimaxApiKey: { type: 'string', default: '' },
    minimaxGroupId: { type: 'string', default: '' },
    groqApiKey: { type: 'string', default: '' },
    groqModel: { type: 'string', default: 'llama-3.3-70b-versatile' },
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
    continuousMode: { type: 'boolean', default: false },
    zealEndpoint: { type: 'string', default: 'https://173-212-225-7.sslip.io/api/voice' },
    zealApiKey: { type: 'string', default: '' },
    zealSpeakReplies: { type: 'boolean', default: true },
    launchOnStartup: { type: 'boolean', default: false },
    theme: { type: 'string', enum: ['dark', 'light', 'system'], default: 'dark' }
  }
})

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
