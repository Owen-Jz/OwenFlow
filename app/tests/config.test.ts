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

import { DEFAULT_SETTINGS, getSettings } from '../src/main/config'

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

  it('declares cleanupProvider schema as groq | minimax with groq default', () => {
    const schema = captured.options?.schema as Record<
      string,
      { enum?: string[]; default?: string }
    >
    expect(schema.cleanupProvider.enum).toEqual(['groq', 'minimax'])
    expect(schema.cleanupProvider.default).toBe('groq')
    expect(schema.groqModel.default).toBe('llama-3.3-70b-versatile')
  })
})
