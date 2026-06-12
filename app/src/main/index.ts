import { app, ipcMain, session } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { getSettings, onSettingsChange, parseDictionary, setSettings } from './config'
import * as history from './history'
import { createTray } from './tray'
import {
  createPillWindow,
  createRecorderWindow,
  getRecorderWindow,
  openSettingsWindow,
  setPillState
} from './windows'
import {
  initPipeline,
  isDictating,
  simulateDictation,
  startDictation,
  stopDictation
} from './pipeline'
import { reconfigureHotkey, startHotkey, stopHotkey } from './hotkey'
import {
  getSidecarStatus,
  onSidecarStatus,
  restartSidecar,
  startSidecar,
  stopSidecar,
  transcribe
} from './sidecar'
import { inject, killInjector, warmupInjector } from './injector'
import { cleanup } from './cleanup'
import type { OwenFlowSettings } from '../shared/types'
import { IPC } from '../shared/types'

// ─── Single instance ────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    void openSettingsWindow('settings')
  })
}

// Keep running with no visible windows (tray app).
app.on('window-all-closed', () => {
  /* tray app — only Quit from the tray exits */
})

// ─── Global enabled flag (tray checkbox) ────────────────────────────────────

let dictationEnabled = true

// ─── Recorder bridge ────────────────────────────────────────────────────────

const RECORDER_STOP_TIMEOUT_MS = 5000

function recorderStart(): void {
  getRecorderWindow()?.webContents.send(IPC.recorderStart)
}

function recorderStop(): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const recorder = getRecorderWindow()
    if (!recorder) {
      reject(new Error('Recorder window unavailable'))
      return
    }
    const timer = setTimeout(() => {
      cleanupListeners()
      reject(new Error('Recorder timed out'))
    }, RECORDER_STOP_TIMEOUT_MS)

    const onData = (_event: Electron.IpcMainEvent, wav: ArrayBuffer): void => {
      cleanupListeners()
      resolve(wav)
    }
    const onError = (_event: Electron.IpcMainEvent, message: string): void => {
      cleanupListeners()
      reject(new Error(message || 'Recorder error'))
    }
    const cleanupListeners = (): void => {
      clearTimeout(timer)
      ipcMain.removeListener(IPC.recorderData, onData)
      ipcMain.removeListener(IPC.recorderError, onError)
    }

    ipcMain.once(IPC.recorderData, onData)
    ipcMain.once(IPC.recorderError, onError)
    recorder.webContents.send(IPC.recorderStop)
  })
}

// ─── IPC handlers ───────────────────────────────────────────────────────────

function registerIpc(): void {
  ipcMain.handle(IPC.settingsGet, (): OwenFlowSettings => getSettings())

  ipcMain.handle(
    IPC.settingsSet,
    (_event, patch: Partial<OwenFlowSettings>): OwenFlowSettings => setSettings(patch)
  )

  ipcMain.handle(IPC.historyList, (_event, limit?: number) => history.list(limit ?? 200))

  ipcMain.handle(IPC.historyClear, () => history.clear())

  ipcMain.handle(IPC.debugSimulate, async () => {
    await simulateDictation()
  })

  // recorder:data / recorder:error are consumed via ipcMain.once in recorderStop().
  // A stray data event (e.g. stop after timeout) is dropped harmlessly:
  ipcMain.on(IPC.recorderData, () => {})
  ipcMain.on(IPC.recorderError, () => {})
}

// ─── Settings side effects ──────────────────────────────────────────────────

function applyLaunchOnStartup(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: ['--hidden']
  })
}

// ─── Boot ───────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('dev.owen.owenflow')

  // Allow mic capture in the hidden recorder window.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()

  await Promise.all([createRecorderWindow(), createPillWindow()])

  initPipeline({
    setPillState,
    recorderStart,
    recorderStop,
    getSettings,
    appendHistory: history.append,
    transcribe: (wav, settings) => {
      const { promptWords } = parseDictionary(settings.dictionary)
      return transcribe(wav, promptWords.join(', ') || undefined, settings.language || undefined)
    },
    cleanup,
    inject
  })

  const tray = createTray({
    isEnabled: () => dictationEnabled,
    onToggleEnabled: (enabled) => {
      dictationEnabled = enabled
      if (!enabled && isDictating()) void stopDictation()
    },
    onOpenSettings: () => void openSettingsWindow('settings'),
    onOpenHistory: () => void openSettingsWindow('history'),
    onQuit: () => app.quit()
  })

  // Sidecar status → tray tooltip.
  const updateTooltip = (): void => {
    const { status, detail } = getSidecarStatus()
    const suffix = detail ? ` (${detail})` : ''
    tray.setToolTip(`OwenFlow — sidecar ${status}${suffix}`)
  }
  onSidecarStatus(updateTooltip)
  updateTooltip()

  // Spawn the Python STT sidecar (model load can take a while — don't block boot).
  void startSidecar(getSettings().model).catch((err) => {
    console.error('[main] sidecar failed to start:', err instanceof Error ? err.message : err)
  })

  // Pre-warm the PowerShell paste helper so the first dictation isn't slow.
  warmupInjector()

  // Global push-to-talk hotkey, gated on the tray enabled flag.
  const initial = getSettings()
  startHotkey({
    hotkey: initial.hotkey,
    mode: initial.mode,
    isEnabled: () => dictationEnabled,
    onStart: () => {
      if (dictationEnabled) void startDictation()
    },
    onStop: () => {
      if (isDictating()) void stopDictation()
    }
  })

  applyLaunchOnStartup(initial.launchOnStartup)
  onSettingsChange((next, prev) => {
    if (next.launchOnStartup !== prev.launchOnStartup) {
      applyLaunchOnStartup(next.launchOnStartup)
    }
    if (next.hotkey !== prev.hotkey || next.mode !== prev.mode) {
      reconfigureHotkey(next.hotkey, next.mode)
    }
    if (next.model !== prev.model) {
      void restartSidecar(next.model).catch((err) => {
        console.error('[main] sidecar restart failed:', err instanceof Error ? err.message : err)
      })
    }
  })
})

// ─── Shutdown ───────────────────────────────────────────────────────────────

app.on('will-quit', () => {
  stopHotkey() // the native hook keeps the process alive if left running
  stopSidecar()
  killInjector()
})
