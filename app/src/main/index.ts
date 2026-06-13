import { app, BrowserWindow, clipboard, ipcMain, Notification, session } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'

// The pill overlay is click-through, so it can never produce a "user gesture" —
// without this switch Chromium keeps its AudioContext suspended and the
// recording start/stop cues are permanently silent.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
import { getSettings, isFirstRun, onSettingsChange, parseDictionary, setSettings } from './config'
import * as history from './history'
import { clipboardWrite } from './clipboard'
import { createTray, refreshTrayMenu } from './tray'
import {
  createPillWindow,
  createRecorderWindow,
  getPillWindow,
  getRecorderWindow,
  openSettingsWindow,
  setPillState
} from './windows'
import {
  cancelDictation,
  initPipeline,
  isDictating,
  isDictationActive,
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
import { getForegroundApp, inject, killInjector, warmupInjector } from './injector'
import { parseSessionTones } from './sessions'
import { benchmarkProviders, cleanup, summarize } from './cleanup'
import { proposeReplacements } from './learn'
import { initTranscribeQueue, enqueue } from './transcribe-queue'
import { initDigestScheduler, rescheduleDigest, digestNow } from './digest-scheduler'
import { applyReplacements } from './dictionary'
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

  ipcMain.handle(IPC.historyUpdateTags, (_event, ts: number, tags: string[]) =>
    history.updateTags(ts, tags)
  )

  ipcMain.handle(IPC.historyTags, () => history.listTags())

  ipcMain.handle(IPC.historySetFolder, (_event, ts: number, folder: string | null) =>
    history.setFolder(ts, folder)
  )

  ipcMain.handle(IPC.historyFolders, () => history.listFolders())

  ipcMain.handle(IPC.historyRenameFolder, (_event, from: string, to: string) =>
    history.renameFolder(from, to)
  )

  ipcMain.handle(IPC.historyDeleteFolder, (_event, name: string) => history.deleteFolder(name))

  // History "Copy" button: navigator.clipboard is unavailable in the packaged
  // file:// renderer (not a secure context), so copy goes through main.
  ipcMain.handle(IPC.clipboardWrite, (_event, text: unknown) => clipboardWrite(text))

  // Settings "Test & compare": time both refinement providers with saved keys.
  ipcMain.handle(IPC.cleanupBenchmark, () => benchmarkProviders(getSettings()))

  ipcMain.handle(IPC.debugSimulate, async () => {
    await simulateDictation()
  })

  // About section: version + data location.
  ipcMain.handle(IPC.appInfo, () => ({
    version: app.getVersion(),
    dataDir: app.getPath('userData')
  }))

  // Sidecar status pill in the settings sidebar (current snapshot on demand).
  ipcMain.handle(IPC.sidecarStatusGet, () => getSidecarStatus())

  // Foreground app detection for app-aware formatting profiles.
  ipcMain.handle(IPC.appsDetect, () => getForegroundApp())

  // Auto-learning dictionary: propose "wrong=>right" entries from a transcript correction.
  ipcMain.handle(IPC.learnPropose, (_event, raw: string, corrected: string) =>
    proposeReplacements(raw, corrected)
  )

  // Live waveform: forward recorder level frames straight to the pill overlay.
  // Hot path (~20 frames/s while recording) — keep it allocation-free, no logging.
  ipcMain.on(IPC.recorderLevel, (_event, frame: number[]) => {
    const pill = getPillWindow()
    if (pill && !pill.isDestroyed()) pill.webContents.send(IPC.recorderLevel, frame)
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
  electronApp.setAppUserModelId('com.owen.owenflow')

  // Allow mic capture in the hidden recorder window.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()

  await Promise.all([createRecorderWindow(), createPillWindow()])

  function notify(title: string, body: string, onClick: () => void): void {
    try {
      const n = new Notification({ title, body })
      n.on('click', onClick)
      n.show()
    } catch (err) {
      console.warn('[notify] failed:', err instanceof Error ? err.message : err)
    }
  }

  initTranscribeQueue({
    transcribe: (wav, s) =>
      transcribe(wav, parseDictionary(s.dictionary).promptWords.join(', ') || undefined, s.language || undefined),
    deliver: (text, item) => {
      void (async () => {
        let final = text
        try {
          const cleaned = (await cleanup(text, item.settings)) || text
          final = applyReplacements(cleaned, parseDictionary(item.settings.dictionary).replacements)
        } catch { /* keep raw */ }
        history.append({ ts: Date.now(), raw: text, final, durationMs: 0, tags: ['recovered'], mode: item.settings.flowMode })
        notify('OwenFlow — recovered dictation', final.slice(0, 140), () => clipboard.writeText(final))
      })()
    },
    onDrop: () => notify('OwenFlow — dictation lost', 'Could not transcribe a queued dictation (sidecar unavailable).', () => {})
  })

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
    inject,
    getForegroundApp,
    enqueueTranscription: (wav, s, startedAt) => enqueue(wav, s, startedAt)
  })

  const tray = createTray({
    isEnabled: () => dictationEnabled,
    onToggleEnabled: (enabled) => {
      dictationEnabled = enabled
      if (!enabled && isDictating()) void stopDictation()
    },
    getFlowMode: () => getSettings().flowMode,
    onSetFlowMode: (mode) => {
      setSettings({ flowMode: mode })
    },
    onOpenSettings: () => void openSettingsWindow('settings'),
    onOpenHistory: () => void openSettingsWindow('history'),
    onShowDigest: () => {
      const d = digestNow()
      if (d) {
        notify(d.title, d.body, () => void openSettingsWindow('history'))
      } else {
        notify('OwenFlow — digest', 'No dictations yet today.', () => void openSettingsWindow('history'))
      }
    },
    onQuit: () => app.quit(),
    getSessions: () => parseSessionTones(getSettings().sessionTones).map((t) => t.label),
    getActiveSession: () => getSettings().activeSession,
    onSetActiveSession: (label) => {
      setSettings({ activeSession: label })
    }
  })

  initDigestScheduler({
    getSettings,
    listHistory: () => history.list(Number.MAX_SAFE_INTEGER),
    summarize,
    notify,
    openHistory: () => void openSettingsWindow('history')
  })

  // Sidecar status → tray tooltip.
  const updateTooltip = (): void => {
    const { status, detail } = getSidecarStatus()
    const suffix = detail ? ` (${detail})` : ''
    tray.setToolTip(`OwenFlow — sidecar ${status}${suffix}`)
  }
  onSidecarStatus(updateTooltip)
  updateTooltip()

  // Sidecar status → settings-window sidebar pill (push on every change).
  onSidecarStatus((status, detail) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.sidecarStatus, { status, detail })
    }
  })

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
    },
    // Escape aborts an active dictation (recording or transcribing).
    isDictationActive,
    onCancel: () => {
      cancelDictation()
    }
  })

  applyLaunchOnStartup(initial.launchOnStartup)

  // First launch (no settings file yet): show Settings so the config is visible.
  if (isFirstRun()) {
    void openSettingsWindow('settings')
  }

  onSettingsChange((next, prev) => {
    if (next.launchOnStartup !== prev.launchOnStartup) {
      applyLaunchOnStartup(next.launchOnStartup)
    }
    if (next.hotkey !== prev.hotkey || next.mode !== prev.mode) {
      reconfigureHotkey(next.hotkey, next.mode)
    }
    if (next.flowMode !== prev.flowMode) {
      // Reflect Settings-UI mode changes back into the tray radio items.
      refreshTrayMenu()
    }
    if (
      next.activeSession !== prev.activeSession ||
      next.sessionTones.join('\n') !== prev.sessionTones.join('\n')
    ) {
      refreshTrayMenu()
    }
    if (next.model !== prev.model) {
      void restartSidecar(next.model).catch((err) => {
        console.error('[main] sidecar restart failed:', err instanceof Error ? err.message : err)
      })
    }
    if (
      next.digestEnabled !== prev.digestEnabled ||
      next.digestHour !== prev.digestHour ||
      next.digestThemes !== prev.digestThemes
    ) {
      rescheduleDigest()
    }
  })
})

// ─── Shutdown ───────────────────────────────────────────────────────────────

app.on('will-quit', () => {
  stopHotkey() // the native hook keeps the process alive if left running
  stopSidecar()
  killInjector()
})
