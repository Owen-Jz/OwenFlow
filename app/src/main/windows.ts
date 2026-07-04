import { BrowserWindow, screen, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'
import appIcon from '../../resources/icon.png?asset'
import type { PillPosition, PillState } from '../shared/types'
import { IPC } from '../shared/types'
import { PILL_HEIGHT, PILL_WIDTH, computePillPosition } from './pill-position'

const preloadPath = join(__dirname, '../preload/index.js')

function rendererUrl(page: 'recorder' | 'pill' | 'settings'): {
  loadInto: (win: BrowserWindow) => Promise<void>
} {
  return {
    loadInto: async (win: BrowserWindow): Promise<void> => {
      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        await win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${page}.html`)
      } else {
        await win.loadFile(join(__dirname, `../renderer/${page}.html`))
      }
    }
  }
}

// ─── Recorder (hidden, never shown) ─────────────────────────────────────────

let recorderWindow: BrowserWindow | null = null

export async function createRecorderWindow(): Promise<BrowserWindow> {
  recorderWindow = new BrowserWindow({
    show: false,
    width: 200,
    height: 120,
    skipTaskbar: true,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      // keep audio capture running while hidden
      backgroundThrottling: false
    }
  })
  await rendererUrl('recorder').loadInto(recorderWindow)
  recorderWindow.on('closed', () => (recorderWindow = null))
  return recorderWindow
}

export function getRecorderWindow(): BrowserWindow | null {
  return recorderWindow
}

// ─── Pill overlay ───────────────────────────────────────────────────────────

let pillWindow: BrowserWindow | null = null

/**
 * Where the pill should sit, injected from index.ts (which reads settings) so
 * this module stays dependency-clean — windows.ts must not import config.ts
 * (config pulls electron-store + userData at module load). Defaults to
 * bottom-center until the provider is wired, matching the settings default.
 */
let pillPositionProvider: () => PillPosition = () => 'bottom-center'

export function setPillPositionProvider(provider: () => PillPosition): void {
  pillPositionProvider = provider
}

function pillPosition(): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay()
  return computePillPosition(workArea, pillPositionProvider())
}

export async function createPillWindow(): Promise<BrowserWindow> {
  const { x, y } = pillPosition()
  pillWindow = new BrowserWindow({
    show: false,
    x,
    y,
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  pillWindow.setAlwaysOnTop(true, 'screen-saver')
  pillWindow.setIgnoreMouseEvents(true)
  pillWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  await rendererUrl('pill').loadInto(pillWindow)
  pillWindow.on('closed', () => (pillWindow = null))
  return pillWindow
}

export function getPillWindow(): BrowserWindow | null {
  return pillWindow
}

/** Push a pill state to the overlay; shows/hides the window as appropriate. */
export function setPillState(state: PillState): void {
  if (!pillWindow || pillWindow.isDestroyed()) return
  // reposition on every push — picks up display-layout changes AND a pill
  // position changed from the tray (takes effect on the next pill show)
  const { x, y } = pillPosition()
  pillWindow.setPosition(x, y)
  pillWindow.webContents.send(IPC.pillState, state)
  if (state.state === 'idle') {
    // renderer fades out first; give the transition time before hiding
    setTimeout(() => {
      if (pillWindow && !pillWindow.isDestroyed()) pillWindow.hide()
    }, 250)
  } else {
    pillWindow.showInactive()
  }
}

// ─── Settings / History window ──────────────────────────────────────────────

let settingsWindow: BrowserWindow | null = null

export async function openSettingsWindow(tab: 'settings' | 'history' = 'settings'): Promise<void> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    settingsWindow.webContents.send(IPC.uiShowTab, tab)
    return
  }
  settingsWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 640,
    minWidth: 560,
    minHeight: 480,
    title: 'OwenFlow',
    icon: appIcon,
    // Frameless: the renderer draws its own titlebar + window controls
    // (win:minimize / win:maximize / win:close IPC).
    frame: false,
    backgroundColor: '#1c1c1e',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true
    }
  })
  settingsWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  settingsWindow.on('closed', () => (settingsWindow = null))
  await rendererUrl('settings').loadInto(settingsWindow)
  settingsWindow.show()
  settingsWindow.webContents.send(IPC.uiShowTab, tab)
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow
}
