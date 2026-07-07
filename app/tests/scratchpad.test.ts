import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// scratchpad.ts imports ipcMain from electron at module level; stub it so the
// test runs in plain node without an Electron runtime.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

import {
  _flushForTest,
  getContent,
  initScratchpad,
  isCapturing,
  isScratchpadOpen,
  routeToScratchpad,
  toggleScratchpad
} from '../src/main/scratchpad'
import { IPC } from '../src/shared/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const tmpRoot = mkdtempSync(join(tmpdir(), 'owenflow-scratchpad-'))

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

type FakeWindow = {
  isDestroyed: ReturnType<typeof vi.fn>
  webContents: { send: ReturnType<typeof vi.fn> }
  close: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
}

function makeFakeWindow(): FakeWindow {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() },
    close: vi.fn(),
    once: vi.fn()
  }
}

/**
 * Returns a test harness: a mutable window slot that `createWindow` populates
 * (mirroring what createScratchpadWindow / getScratchpadWindow do in windows.ts).
 */
function makeHarness(storePath = tmpRoot) {
  let fakeWin: FakeWindow | null = null
  const deps = {
    getWindow: () => fakeWin as unknown as import('electron').BrowserWindow | null,
    createWindow: vi.fn(async () => {
      fakeWin = makeFakeWindow()
      return fakeWin as unknown as import('electron').BrowserWindow
    }),
    storePath
  }
  const openWindow = (w: FakeWindow | null = makeFakeWindow()) => {
    fakeWin = w
  }
  const closeWindow = () => {
    fakeWin = null
  }
  return { deps, openWindow, closeWindow, getFakeWin: () => fakeWin }
}

// Reset module-level state before each test via a fresh initScratchpad call.
beforeEach(() => {
  const { deps } = makeHarness()
  initScratchpad(deps)
})

// ─── Core routing ─────────────────────────────────────────────────────────────

describe('routeToScratchpad: returns false when window is closed', () => {
  it('returns false when getWindow() is null', () => {
    const { deps } = makeHarness()
    initScratchpad(deps) // getWindow = () => null (harness default — window not created)
    expect(routeToScratchpad('hello')).toBe(false)
  })
})

describe('routeToScratchpad: returns false when capture is off', () => {
  it('returns false when window is open but captureOn is false (never toggled)', () => {
    const { deps, openWindow } = makeHarness()
    initScratchpad(deps)
    // Open the window manually WITHOUT calling toggleScratchpad (so captureOn stays false)
    openWindow()
    expect(isScratchpadOpen()).toBe(true)
    expect(isCapturing()).toBe(false)
    expect(routeToScratchpad('hello')).toBe(false)
  })
})

describe('routeToScratchpad: returns true and sends IPC when open + capturing', () => {
  it('returns true after toggleScratchpad opens the window', async () => {
    const { deps } = makeHarness()
    initScratchpad(deps)
    await toggleScratchpad()
    expect(isScratchpadOpen()).toBe(true)
    expect(isCapturing()).toBe(true)
    expect(routeToScratchpad('dictated text')).toBe(true)
  })

  it('sends scratchpad:append with the text', async () => {
    const { deps, getFakeWin } = makeHarness()
    initScratchpad(deps)
    await toggleScratchpad()
    routeToScratchpad('hello')
    expect(getFakeWin()!.webContents.send).toHaveBeenCalledWith(IPC.scratchpadAppend, 'hello')
  })

  it('adds a leading newline separator when content is non-empty', async () => {
    const { deps, getFakeWin } = makeHarness()
    initScratchpad(deps)
    await toggleScratchpad()
    routeToScratchpad('first')
    routeToScratchpad('second')
    // Content should be 'first\nsecond'
    expect(getContent()).toBe('first\nsecond')
    // Filter for only the append calls (toggleScratchpad also sends scratchpadState first)
    const appendCalls = getFakeWin()!.webContents.send.mock.calls.filter(
      (c) => c[0] === IPC.scratchpadAppend
    )
    expect(appendCalls[0]).toEqual([IPC.scratchpadAppend, 'first'])
    expect(appendCalls[1]).toEqual([IPC.scratchpadAppend, 'second'])
  })
})

// ─── Persistence ─────────────────────────────────────────────────────────────

describe('persistence: content is saved to scratchpad.txt', () => {
  it('writes content to the store file after flush', async () => {
    const storePath = mkdtempSync(join(tmpdir(), 'owenflow-sp-persist-'))
    try {
      const { deps } = makeHarness(storePath)
      initScratchpad(deps)
      await toggleScratchpad()
      routeToScratchpad('persisted text')
      await _flushForTest()
      const filePath = join(storePath, 'scratchpad.txt')
      expect(existsSync(filePath)).toBe(true)
      expect(readFileSync(filePath, 'utf8')).toBe('persisted text')
    } finally {
      rmSync(storePath, { recursive: true, force: true })
    }
  })
})

describe('persistence: content survives re-init', () => {
  it('loads existing content from disk on initScratchpad', async () => {
    const storePath = mkdtempSync(join(tmpdir(), 'owenflow-sp-reinit-'))
    try {
      // First session: write content + flush
      const h1 = makeHarness(storePath)
      initScratchpad(h1.deps)
      await toggleScratchpad()
      routeToScratchpad('session one text')
      await _flushForTest()

      // Second session: re-init with same storePath — should reload from file
      const h2 = makeHarness(storePath)
      initScratchpad(h2.deps)
      expect(getContent()).toBe('session one text')
    } finally {
      rmSync(storePath, { recursive: true, force: true })
    }
  })
})

// ─── State helpers ────────────────────────────────────────────────────────────

describe('isScratchpadOpen / isCapturing', () => {
  it('isScratchpadOpen is false before any window is created', () => {
    const { deps } = makeHarness()
    initScratchpad(deps)
    expect(isScratchpadOpen()).toBe(false)
  })

  it('isScratchpadOpen is true after toggleScratchpad', async () => {
    const { deps } = makeHarness()
    initScratchpad(deps)
    await toggleScratchpad()
    expect(isScratchpadOpen()).toBe(true)
  })

  it('isCapturing is false when window is open but capture is off', () => {
    const { deps, openWindow } = makeHarness()
    initScratchpad(deps)
    openWindow()
    expect(isCapturing()).toBe(false)
  })

  it('isCapturing is true after toggleScratchpad', async () => {
    const { deps } = makeHarness()
    initScratchpad(deps)
    await toggleScratchpad()
    expect(isCapturing()).toBe(true)
  })

  it('isCapturing is false when window is destroyed', () => {
    const { deps, openWindow } = makeHarness()
    initScratchpad(deps)
    const w = makeFakeWindow()
    w.isDestroyed.mockReturnValue(true)
    openWindow(w)
    expect(isCapturing()).toBe(false)
  })
})
