/**
 * Scratchpad module — floating always-on-top dictation notepad.
 *
 * Owns:
 *  - Window lifecycle ref (via injected deps — keeps this module testable without Electron)
 *  - Capture flag: true whenever the window is open (default); the renderer toggle can
 *    turn it off; always false when the window is closed.
 *  - Content persistence: reads scratchpad.txt synchronously on init (called once at
 *    startup), saves debounced 500ms on every renderer edit or incoming dictation append.
 *  - `routeToScratchpad(text)` — called by the pipeline (Wave E task 5) to push
 *    dictated text into the scratchpad when it is open + capturing.
 *  - `registerScratchpadIpc()` — wires the six IPC channels; called from index.ts.
 */

import { ipcMain } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/types'

// ─── Dep injection interface ──────────────────────────────────────────────────

export interface ScratchpadDeps {
  /** Returns the live scratchpad BrowserWindow, or null when closed. */
  getWindow: () => BrowserWindow | null
  /**
   * Creates (and shows) a new scratchpad BrowserWindow. The resolved window is
   * the source of truth — `getWindow()` must return it after this resolves.
   */
  createWindow: () => Promise<BrowserWindow>
  /** Directory that owns scratchpad.txt (pass app.getPath('userData') in production). */
  storePath: string
  /**
   * Called whenever the scratchpad window opens or closes, so callers can
   * refresh the tray menu (or any other open/close subscriber).
   * Optional — safe to omit in tests that don't need tray refresh.
   */
  onStateChange?: () => void
}

// ─── Module state ─────────────────────────────────────────────────────────────

let deps: ScratchpadDeps | null = null
/** In-memory notepad content — the single source of truth between saves. */
let content = ''
/** True while the window is open AND the user hasn't disabled it via the toggle. */
let captureOn = false
/** Debounce timer handle for disk writes. */
let saveTimer: NodeJS.Timeout | null = null
/** Guard against concurrent toggleScratchpad calls creating multiple windows. */
let creating = false

// ─── Internal helpers ─────────────────────────────────────────────────────────

function storagePath(): string {
  return join(deps!.storePath, 'scratchpad.txt')
}

/** Schedule a disk write 500ms from now, cancelling any pending one. */
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    writeFile(storagePath(), content, 'utf8').catch(() => {
      /* swallow write errors — best-effort persistence */
    })
  }, 500)
}

/** Push the current capture flag to the renderer (e.g. after a set-capture IPC). */
function pushState(): void {
  const win = deps?.getWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.scratchpadState, { capturing: captureOn })
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the scratchpad module.  Must be called before any other export.
 * Re-init is safe — clears any pending save timer, resets in-memory state, and
 * loads persisted content synchronously from disk.
 */
export function initScratchpad(d: ScratchpadDeps): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  deps = d
  content = ''
  captureOn = false
  creating = false
  // Load persisted content synchronously — called once during app startup, not on a hot path.
  try {
    const path = join(d.storePath, 'scratchpad.txt')
    if (existsSync(path)) content = readFileSync(path, 'utf8')
  } catch {
    /* missing or unreadable — start empty */
  }
}

/** True when the scratchpad window is open (not destroyed). */
export function isScratchpadOpen(): boolean {
  const win = deps?.getWindow()
  return !!win && !win.isDestroyed()
}

/** True when the window is open AND capture is enabled. */
export function isCapturing(): boolean {
  return isScratchpadOpen() && captureOn
}

/** Current in-memory content (also used by the scratchpadGetContent IPC handler). */
export function getContent(): string {
  return content
}

/**
 * Create+show the scratchpad window if it is closed; close it if open.
 * Sets captureOn to true on open and false on close.
 * Guards against concurrent calls creating multiple windows.
 */
export async function toggleScratchpad(): Promise<void> {
  if (!deps) return
  if (isScratchpadOpen()) {
    deps.getWindow()!.close()
    // captureOn is reset to false via the 'closed' handler registered below
  } else {
    if (creating) return
    creating = true
    try {
      const win = await deps.createWindow()
      captureOn = true
      // Notify the caller (e.g. tray) that the window is now open.
      deps.onStateChange?.()
      // Reset captureOn when the window is closed by any means (user close, close button, etc.)
      win.once('closed', () => {
        captureOn = false
        // Notify the caller that the window has closed so the tray checkbox
        // can be updated even when the user hits the window's own close button.
        deps!.onStateChange?.()
      })
      pushState()
    } finally {
      creating = false
    }
  }
}

/**
 * Route dictated text into the scratchpad if it is open and capturing.
 *
 * Appends `text` to the in-memory content (with a `'\n'` separator when the
 * pad is non-empty), pushes the chunk to the renderer via `scratchpad:append`,
 * and schedules a debounced save.  Returns true on success, false if the pad is
 * closed or capture is disabled.  NEVER throws.
 */
export function routeToScratchpad(text: string): boolean {
  try {
    if (!isScratchpadOpen() || !captureOn) return false
    const win = deps!.getWindow()!
    if (win.isDestroyed()) return false
    content = content.length > 0 ? content + '\n' + text : text
    win.webContents.send(IPC.scratchpadAppend, text)
    scheduleSave()
    return true
  } catch {
    return false
  }
}

/**
 * Register the six scratchpad IPC channels.  Call once from index.ts after
 * `initScratchpad()`.
 */
export function registerScratchpadIpc(): void {
  // Renderer on load: fetch existing content to pre-populate the textarea.
  ipcMain.handle(IPC.scratchpadGetContent, (): string => content)

  // Renderer textarea `input` event: keep main content in sync + schedule save.
  ipcMain.on(IPC.scratchpadSetContent, (_event, text: unknown): void => {
    content = typeof text === 'string' ? text : ''
    scheduleSave()
  })

  // Renderer capture toggle: update the flag and push the new state back.
  ipcMain.on(IPC.scratchpadSetCapture, (_event, on: unknown): void => {
    captureOn = typeof on === 'boolean' ? on : false
    pushState()
  })

  // Renderer close button: close the window from main so the lifecycle is tidy.
  ipcMain.on(IPC.scratchpadClose, (): void => {
    const win = deps?.getWindow()
    if (win && !win.isDestroyed()) win.close()
  })
}

/**
 * Synchronously flush any pending debounced save to disk.
 *
 * Called from the `will-quit` handler so content typed moments before quit is
 * not lost when the debounce timer hasn't fired yet.  Cancels the pending timer
 * (so the async path never double-writes) and writes synchronously with
 * writeFileSync (safe to call from a synchronous quit handler).  Errors are
 * swallowed — this is best-effort at shutdown.
 */
export function flushScratchpadSync(): void {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  if (!deps) return
  try {
    writeFileSync(storagePath(), content, 'utf8')
  } catch {
    /* swallow — best-effort flush at quit time */
  }
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Immediately flush any pending debounced save to disk.
 * Only for use in unit tests — production code should rely on the debounce.
 */
export function _flushForTest(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (!deps) return Promise.resolve()
  return writeFile(storagePath(), content, 'utf8').catch(() => {})
}
