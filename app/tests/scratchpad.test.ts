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

// ─── Race condition and lifecycle tests ────────────────────────────────────────

describe('toggleScratchpad: guards against concurrent calls (C1)', () => {
  it('only calls createWindow once when toggleScratchpad is called twice without awaiting', async () => {
    const { deps } = makeHarness()
    initScratchpad(deps)

    // Create a promise we control
    let resolveCreate: (win: import('electron').BrowserWindow) => void
    const createPromise = new Promise((resolve) => {
      resolveCreate = resolve
    })

    // Replace createWindow with one that returns our controlled promise
    deps.createWindow = vi.fn(async () => {
      const win = makeFakeWindow()
      return new Promise((resolve) => {
        createPromise.then(() => resolve(win as unknown as import('electron').BrowserWindow))
      })
    })

    // Call toggleScratchpad twice without awaiting
    const p1 = toggleScratchpad()
    const p2 = toggleScratchpad()

    // Resolve the promise
    resolveCreate!(makeFakeWindow() as unknown as import('electron').BrowserWindow)

    // Wait for both to settle
    await Promise.all([p1, p2])

    // createWindow should have been called exactly once
    expect(deps.createWindow).toHaveBeenCalledTimes(1)
  })
})

describe('toggleScratchpad: close lifecycle (I1)', () => {
  it('captures the closed callback and clears captureOn when invoked', async () => {
    const h = makeHarness()
    initScratchpad(h.deps)

    let closedCb: (() => void) | null = null

    // Create a window with a custom once that captures the callback
    const winWithCustomOnce = makeFakeWindow()
    winWithCustomOnce.once = vi.fn((event: string, callback: () => void) => {
      if (event === 'closed') closedCb = callback
    })

    // Patch createWindow to return our window
    const originalCreateWindow = h.deps.createWindow
    h.deps.createWindow = vi.fn(async () => {
      h.openWindow(winWithCustomOnce)
      return winWithCustomOnce as unknown as import('electron').BrowserWindow
    })

    // Toggle to open the window
    await toggleScratchpad()
    expect(isScratchpadOpen()).toBe(true)
    expect(isCapturing()).toBe(true)

    // Verify closed callback was registered
    expect(closedCb).not.toBeNull()

    // Invoke the closed callback
    closedCb!()

    // captureOn should be false now
    expect(isCapturing()).toBe(false)
    expect(routeToScratchpad('test')).toBe(false)
  })
})

describe('routeToScratchpad: handles dead window gracefully (I2)', () => {
  it('returns false and does not throw when webContents.send throws', async () => {
    const { deps } = makeHarness()
    initScratchpad(deps)
    await toggleScratchpad()

    // Mock send to throw an error
    const fakeWin = deps.getWindow() as any
    fakeWin.webContents.send = vi.fn(() => {
      throw new Error('dead window')
    })

    // routeToScratchpad should return false and not throw
    expect(() => {
      const result = routeToScratchpad('test')
      expect(result).toBe(false)
    }).not.toThrow()
  })
})
