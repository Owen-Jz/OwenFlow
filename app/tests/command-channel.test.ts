/**
 * Command-channel tests.
 * Mirrors the pipeline.test.ts harness: mock all deps, drive the
 * start → stop cycle, flush microtasks with `await Promise.resolve()` loops.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelCommand,
  initCommandChannel,
  isCommandActive,
  startCommand,
  stopCommand,
  type CommandDeps
} from '../src/main/command-channel'
import type { OwenFlowSettings, PillState } from '../src/shared/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const baseSettings = (patch: Partial<OwenFlowSettings> = {}): OwenFlowSettings => ({
  hotkey: 'RightCtrl',
  mode: 'hold',
  flowMode: 'normal',
  model: 'small',
  language: 'en',
  cleanupEnabled: false,
  cleanupProvider: 'groq',
  minimaxApiKey: '',
  minimaxGroupId: '',
  groqApiKey: 'key',
  groqModel: 'llama-3.3-70b-versatile',
  dictionary: [],
  snippets: [],
  translateTarget: 'English',
  sessionTones: [],
  activeSession: '',
  appProfilesEnabled: false,
  profiles: [],
  launchOnStartup: false,
  theme: 'dark',
  digestEnabled: false,
  digestHour: 8,
  digestThemes: false,
  commandEnabled: true,
  commandHotkey: 'F13',
  ...patch
})

function makeDeps(overrides: Partial<CommandDeps> = {}): CommandDeps & Record<string, ReturnType<typeof vi.fn>> {
  const wav = new ArrayBuffer(32)
  const base: CommandDeps = {
    setPillState: vi.fn(),
    recorderStart: vi.fn(),
    recorderStop: vi.fn(async () => wav),
    getSettings: () => baseSettings(),
    appendHistory: vi.fn(),
    transcribe: vi.fn(async () => ({ text: 'make a bullet list', durationMs: 300 })),
    copySelection: vi.fn(async () => 'one two'),
    runCommand: vi.fn(async () => '- one\n- two'),
    inject: vi.fn(async () => {}),
    notify: vi.fn()
  }
  return { ...base, ...overrides } as CommandDeps & Record<string, ReturnType<typeof vi.fn>>
}

const pillStates = (deps: ReturnType<typeof makeDeps>): PillState[] =>
  (deps.setPillState as ReturnType<typeof vi.fn>).mock.calls.map(([s]: [PillState]) => s)

/**
 * Drive a full start → stop cycle and flush all pending microtasks.
 * Mirrors how pipeline.test.ts calls `await runDictation(deps)`.
 */
async function runCommand(deps: ReturnType<typeof makeDeps>): Promise<void> {
  initCommandChannel(deps)
  await startCommand()   // async: awaits copySelection, then calls recorderStart
  await stopCommand()    // async: awaits recorderStop → transcribe → runCommand → inject
}

/** Flush microtasks until `cond()` holds (bounded — mirrors pipeline escape-cancel tests). */
async function flushUntil(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !cond(); i++) await Promise.resolve()
  expect(cond()).toBe(true)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('command-channel — local path', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('copySelection → record → transcribe → runCommand → inject → appendHistory', async () => {
    const deps = makeDeps()
    await runCommand(deps)

    expect(deps.copySelection).toHaveBeenCalledTimes(1)
    expect(deps.recorderStart).toHaveBeenCalledTimes(1)
    expect(deps.transcribe).toHaveBeenCalledTimes(1)
    expect(deps.runCommand).toHaveBeenCalledWith('make a bullet list', 'one two', expect.any(Object))
    expect(deps.inject).toHaveBeenCalledWith('- one\n- two')
    expect(deps.appendHistory).toHaveBeenCalledOnce()
    const entry = (deps.appendHistory as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(entry.raw).toBe('make a bullet list')
    expect(entry.final).toBe('- one\n- two')
    expect(entry.mode).toBe('command')
    expect(entry.tags).toEqual([])
  })

  it('pill states: recording → transcribing → done', async () => {
    const deps = makeDeps()
    await runCommand(deps)
    const states = pillStates(deps).map((s) => s.state)
    expect(states).toEqual(['recording', 'transcribing', 'done'])
  })

  it('isCommandActive is false once the pipeline completes', async () => {
    const deps = makeDeps()
    await runCommand(deps)
    expect(isCommandActive()).toBe(false)
  })
})

describe('command-channel — zeal path', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('routes zeal prefix to notify, does NOT inject or runCommand', async () => {
    const deps = makeDeps({
      transcribe: vi.fn(async () => ({ text: 'zeal launch a mission', durationMs: 200 }))
    })
    await runCommand(deps)

    expect(deps.notify).toHaveBeenCalledOnce()
    expect(deps.notify).toHaveBeenCalledWith('Command channel', expect.stringContaining('not set up'))
    expect(deps.inject).not.toHaveBeenCalled()
    expect(deps.runCommand).not.toHaveBeenCalled()
    expect(deps.appendHistory).not.toHaveBeenCalled()
  })

  it('routes vault prefix to notify, does NOT inject or runCommand', async () => {
    const deps = makeDeps({
      transcribe: vi.fn(async () => ({ text: 'vault remember this thing', durationMs: 200 }))
    })
    await runCommand(deps)

    expect(deps.notify).toHaveBeenCalledOnce()
    expect(deps.inject).not.toHaveBeenCalled()
    expect(deps.runCommand).not.toHaveBeenCalled()
  })
})

describe('command-channel — empty transcript', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('empty / whitespace transcript: no inject, no notify, no runCommand, pill error "—"', async () => {
    const deps = makeDeps({
      transcribe: vi.fn(async () => ({ text: '   ', durationMs: 50 }))
    })
    await runCommand(deps)

    expect(deps.inject).not.toHaveBeenCalled()
    expect(deps.notify).not.toHaveBeenCalled()
    expect(deps.runCommand).not.toHaveBeenCalled()
    expect(deps.appendHistory).not.toHaveBeenCalled()
    const last = pillStates(deps).at(-1)
    expect(last).toEqual({ state: 'error', message: '—' })
  })
})

describe('command-channel — runCommand empty result', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('runCommand returns empty string: no inject, pill shows "No result"', async () => {
    const deps = makeDeps({
      runCommand: vi.fn(async () => '')
    })
    await runCommand(deps)

    expect(deps.inject).not.toHaveBeenCalled()
    expect(deps.appendHistory).not.toHaveBeenCalled()
    const last = pillStates(deps).at(-1)
    expect(last).toEqual({ state: 'error', message: 'No result' })
  })
})

describe('command-channel — error paths', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('recorder failure: pill error, transcribe never called', async () => {
    const deps = makeDeps({
      recorderStop: vi.fn(async () => { throw new Error('Recorder timed out') })
    })
    await runCommand(deps)

    expect(deps.transcribe).not.toHaveBeenCalled()
    expect(deps.inject).not.toHaveBeenCalled()
    const last = pillStates(deps).at(-1)
    expect(last).toEqual({ state: 'error', message: 'Recorder timed out' })
  })

  it('transcribe failure: pill error, runCommand never called', async () => {
    const deps = makeDeps({
      transcribe: vi.fn(async () => { throw new Error('Sidecar unavailable') })
    })
    await runCommand(deps)

    expect(deps.runCommand).not.toHaveBeenCalled()
    expect(deps.inject).not.toHaveBeenCalled()
    const last = pillStates(deps).at(-1)
    expect(last?.state).toBe('error')
    expect(last?.message).toContain('Sidecar unavailable')
  })

  it('inject failure: history still recorded, pill shows paste error', async () => {
    const deps = makeDeps({
      inject: vi.fn(async () => { throw new Error('Copied — paste manually') })
    })
    await runCommand(deps)

    expect(deps.appendHistory).toHaveBeenCalledOnce()
    const entry = (deps.appendHistory as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(entry.mode).toBe('command')
    const last = pillStates(deps).at(-1)
    expect(last).toEqual({ state: 'error', message: 'Copied — paste manually' })
  })
})

describe('command-channel — cancellation', () => {
  it('cancelCommand while recording: mic released, nothing processed', async () => {
    const deps = makeDeps()
    initCommandChannel(deps)

    await startCommand()
    expect(isCommandActive()).toBe(true)

    expect(cancelCommand()).toBe(true)
    expect(isCommandActive()).toBe(false)

    // mic must be released (recorderStop fired and discarded)
    await Promise.resolve()
    expect(deps.recorderStop).toHaveBeenCalledTimes(1)
    // pill set to idle
    expect(pillStates(deps).at(-1)).toEqual({ state: 'idle' })

    // stopCommand after cancel is a no-op
    await stopCommand()
    expect(deps.transcribe).not.toHaveBeenCalled()
    expect(deps.inject).not.toHaveBeenCalled()
    expect(deps.appendHistory).not.toHaveBeenCalled()
  })

  it('cancelCommand while transcribing: late result is discarded', async () => {
    let resolveTranscribe!: (r: { text: string; durationMs: number }) => void
    const deps = makeDeps({
      transcribe: vi.fn(
        () => new Promise<{ text: string; durationMs: number }>((resolve) => (resolveTranscribe = resolve))
      )
    })
    initCommandChannel(deps)

    await startCommand()
    const stopPromise = stopCommand()
    await flushUntil(() => (deps.transcribe as ReturnType<typeof vi.fn>).mock.calls.length === 1)
    expect(isCommandActive()).toBe(true)

    expect(cancelCommand()).toBe(true)
    expect(isCommandActive()).toBe(false)

    // late sidecar response — must be ignored
    resolveTranscribe({ text: 'late text that must not paste', durationMs: 999 })
    await stopPromise

    expect(deps.runCommand).not.toHaveBeenCalled()
    expect(deps.inject).not.toHaveBeenCalled()
    expect(deps.appendHistory).not.toHaveBeenCalled()
    expect(pillStates(deps).at(-1)).toEqual({ state: 'idle' })
  })

  it('cancelCommand with nothing active returns false and does not touch pill', () => {
    const deps = makeDeps()
    initCommandChannel(deps)
    expect(cancelCommand()).toBe(false)
    expect(deps.setPillState).not.toHaveBeenCalled()
  })

  it('fresh command after cancel runs end-to-end normally', async () => {
    const deps = makeDeps()
    initCommandChannel(deps)

    await startCommand()
    cancelCommand()

    // second run should complete normally
    await startCommand()
    await stopCommand()

    expect(deps.inject).toHaveBeenCalledTimes(1)
    expect(deps.inject).toHaveBeenCalledWith('- one\n- two')
    expect(deps.appendHistory).toHaveBeenCalledTimes(1)
    expect(pillStates(deps).at(-1)).toEqual({ state: 'done' })
  })

  it('startCommand is no-op while already active', async () => {
    const deps = makeDeps()
    initCommandChannel(deps)

    await startCommand()
    await startCommand() // second call ignored
    expect(deps.recorderStart).toHaveBeenCalledTimes(1)

    await stopCommand()
    await stopCommand() // second stop is a no-op
    expect(deps.transcribe).toHaveBeenCalledTimes(1)
  })
})
