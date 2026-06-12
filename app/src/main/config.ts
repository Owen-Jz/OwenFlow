import Store from 'electron-store'
import type { OwenFlowSettings } from '../shared/types'

export const DEFAULT_SETTINGS: OwenFlowSettings = {
  hotkey: 'RightCtrl',
  mode: 'hold',
  model: 'small',
  language: '',
  cleanupEnabled: false,
  minimaxApiKey: '',
  minimaxGroupId: '',
  dictionary: [],
  launchOnStartup: false
}

const store = new Store<OwenFlowSettings>({
  name: 'config',
  defaults: DEFAULT_SETTINGS,
  schema: {
    hotkey: { type: 'string', default: 'RightCtrl' },
    mode: { type: 'string', enum: ['hold', 'toggle'], default: 'hold' },
    model: {
      type: 'string',
      enum: ['tiny', 'base', 'small', 'medium', 'large-v3'],
      default: 'small'
    },
    language: { type: 'string', default: '' },
    cleanupEnabled: { type: 'boolean', default: false },
    minimaxApiKey: { type: 'string', default: '' },
    minimaxGroupId: { type: 'string', default: '' },
    dictionary: { type: 'array', items: { type: 'string' }, default: [] },
    launchOnStartup: { type: 'boolean', default: false }
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
