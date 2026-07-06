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
  createMeetingWindow,
  createPillWindow,
  createRecorderWindow,
  getMeetingWindow,
  getPillWindow,
  getRecorderWindow,
  getSettingsWindow,
  openSettingsWindow,
  setPillPositionProvider,
  setPillState
} from './windows'
import {
  cancelDictation,
  initPipeline,
  isDictating,
  isDictationActive,
  onRecorderSegment,
  simulateDictation,
  startDictation,
  stopDictation
} from './pipeline'
import { reconfigureHotkey, startHotkey, stopHotkey } from './hotkey'
import {
  cancelCommand,
  initCommandChannel,
  isCommandActive,
  startCommand,
  stopCommand
} from './command-channel'
import {
  initContinuousChannel,
  startContinuous,
  stopContinuous,
  cancelContinuous,
  isContinuousActive,
  onSegment,
  onDone
} from './continuous-channel'
import {
  reconfigureCommandHotkey,
  startCommandHotkey,
  stopCommandHotkey
} from './command-hotkey'
import { reconfigureModeHotkey, startModeHotkey, stopModeHotkey } from './mode-hotkey'
import { reconfigureMeetingHotkey, startMeetingHotkey, stopMeetingHotkey } from './meeting-hotkey'
import { notePromptShown, startMeetingDetect, stopMeetingDetect } from './meeting-detect'
import {
  activeMeetingId,
  endMeetingOnQuit,
  formatMeetingElapsed,
  getMeetingState,
  initMeetingChannel,
  isMeetingActive,
  onCaptureError,
  onCaptureStopped,
  onMeetingSegment,
  onMeetingStateChange,
  startMeeting,
  stopMeeting,
  wrapPillState
} from './meeting-channel'
import * as meetingStore from './meeting-store'
import { summarizeMeeting, extractActionItems, buildZealTaskMessage } from './meeting-summary'
import {
  getSidecarStatus,
  onSidecarStatus,
  restartSidecar,
  startSidecar,
  stopSidecar,
  transcribe
} from './sidecar'
import {
  copySelection,
  getForegroundApp,
  inject,
  killInjector,
  pressEnter,
  warmupInjector
} from './injector'
import { parseSessionTones } from './sessions'
import { benchmarkProviders, cleanup, runCommand, summarize } from './cleanup'
import { sendZealCommand } from './zeal'
import { proposeReplacements } from './learn'
import { initTranscribeQueue, enqueue } from './transcribe-queue'
import { initDigestScheduler, rescheduleDigest, digestNow } from './digest-scheduler'
import { applyReplacements, buildBiasPrompt } from './dictionary'
import type { FlowMode, MeetingStream, OwenFlowSettings } from '../shared/types'
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

// ─── Pill routing ───────────────────────────────────────────────────────────

/**
 * The pill pusher every DICTATION channel gets: dictation states pass
 * through untouched (they take priority over the meeting display), but an
 * 'idle' push while a meeting runs re-asserts the calm 'meeting' state
 * instead of hiding the pill — so a mid-meeting dictation renders its normal
 * recording→transcribing→done flow and then hands the pill back to the
 * meeting. The meeting channel itself gets the RAW setPillState.
 */
const pushPillState = wrapPillState(setPillState)

// ─── Recorder bridge ────────────────────────────────────────────────────────

const RECORDER_STOP_TIMEOUT_MS = 5000

function recorderStart(continuous = false): void {
  getRecorderWindow()?.webContents.send(IPC.recorderStart, continuous)
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

  // Segment WAVs from the recorder window. Continuous and normal dictation
  // are mutually exclusive (hotkey wiring below), so route by which channel
  // is active: continuous pastes per segment, normal PRE-transcribes in the
  // background (pipeline drops the segment if no dictation is in flight —
  // e.g. a flush racing a cancel).
  ipcMain.on(IPC.recorderSegment, (_e, wav: ArrayBuffer) => {
    if (isContinuousActive()) onSegment(wav)
    else onRecorderSegment(wav)
  })
  // recorder:done is only emitted in continuous mode (normal mode's final
  // reply is recorder:data).
  ipcMain.on(IPC.recorderDone, () => {
    void onDone()
  })

  // recorder:data / recorder:error are consumed via ipcMain.once in recorderStop().
  // A stray data event (e.g. stop after timeout) is dropped harmlessly:
  ipcMain.on(IPC.recorderData, () => {})
  ipcMain.on(IPC.recorderError, () => {})

  // Frameless settings window: custom titlebar buttons drive the window.
  ipcMain.on(IPC.winMinimize, () => {
    const win = getSettingsWindow()
    if (win && !win.isDestroyed()) win.minimize()
  })
  ipcMain.on(IPC.winMaximize, () => {
    const win = getSettingsWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on(IPC.winClose, () => {
    const win = getSettingsWindow()
    if (win && !win.isDestroyed()) win.close()
  })

  // ── Meeting mode ──────────────────────────────────────────────────────────

  ipcMain.handle(IPC.meetingStart, () => startMeeting())
  ipcMain.handle(IPC.meetingStop, () => stopMeeting())
  ipcMain.handle(IPC.meetingState, () => getMeetingState())
  ipcMain.handle(IPC.meetingList, () => meetingStore.listMeetings())
  ipcMain.handle(IPC.meetingGet, (_event, id: string) => meetingStore.getMeeting(id))
  ipcMain.handle(IPC.meetingDelete, (_event, id: string) => {
    // Deleting the meeting that is currently being written would leave the
    // queue appending into a void — refuse; the UI should end it first.
    if (id === activeMeetingId()) return
    meetingStore.removeMeeting(id)
  })
  ipcMain.handle(IPC.meetingRename, (_event, id: string, title: string) =>
    meetingStore.renameMeeting(id, typeof title === 'string' ? title : '')
  )

  // Summary: generate lazily on first request, persist into meta.json, and
  // return it — repeat calls are a cheap meta read. '' = generation failed
  // (no provider key, network down); nothing is persisted so a later retry
  // can still succeed.
  ipcMain.handle(IPC.meetingSummarize, async (_event, id: string): Promise<string> => {
    const meta = meetingStore.readMeta(id)
    if (!meta) return ''
    if (meta.summary) return meta.summary
    const summary = await summarizeMeeting(meetingStore.readEntries(id), getSettings())
    if (summary) {
      // Re-read before writing: a meta refresh (words) may have landed while
      // the LLM was thinking — don't clobber it with the stale snapshot.
      const fresh = meetingStore.readMeta(id) ?? meta
      meetingStore.writeMeta(id, { ...fresh, summary })
    }
    return summary
  })

  ipcMain.handle(
    IPC.meetingActions,
    async (_event, id: string): Promise<{ items: string[]; sent: boolean; reply: string }> => {
      const { meta, entries } = meetingStore.getMeeting(id)
      if (!meta.startedAt) return { items: [], sent: false, reply: '' }
      const items = await extractActionItems(entries, getSettings())
      if (items.length === 0) return { items, sent: false, reply: '' }
      const title =
        meta.title?.trim() ||
        new Date(meta.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      const res = await sendZealCommand(buildZealTaskMessage(title, items), getSettings())
      if (res.ok) {
        // Re-read before writing — a words refresh may have landed meanwhile.
        const fresh = meetingStore.readMeta(id) ?? meta
        meetingStore.writeMeta(id, { ...fresh, actionsSentAt: Date.now() })
      }
      return { items, sent: res.ok, reply: res.reply }
    }
  )

  // Segment WAVs + lifecycle events from the hidden meeting window.
  ipcMain.on(
    IPC.meetingSegment,
    (_event, wav: ArrayBuffer, stream: MeetingStream, startedAtMs: number) => {
      onMeetingSegment(wav, stream, startedAtMs)
    }
  )
  ipcMain.on(IPC.meetingCaptureStopped, () => onCaptureStopped())
  ipcMain.on(IPC.meetingCaptureError, (_event, message: string) =>
    onCaptureError(typeof message === 'string' ? message : 'Meeting capture failed')
  )

  // Home "Dictate now": minimize the settings window, then start a dictation.
  // Stopping is owned by the normal hotkey state machine (hotkey.ts): in hold
  // mode the next hotkey tap fires keydown→onStart (a guarded no-op — the
  // pipeline is already dictating) and its keyup/gap-timer path calls
  // stopDictation(), so a single tap stops + transcribes; holding + releasing
  // works the same way. Escape still cancels.
  ipcMain.handle(IPC.dictationStart, () => {
    if (isDictationActive() || isContinuousActive() || isCommandActive()) return
    const win = getSettingsWindow()
    if (win && !win.isDestroyed()) win.minimize()
    void startDictation()
  })
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

  // Allow mic capture in the hidden recorder + meeting windows.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()

  // Wire BEFORE the pill window is created so its initial coordinates already
  // honor a previously-saved position (windows.ts defaults to bottom-center).
  setPillPositionProvider(() => getSettings().pillPosition)

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
      transcribe(
        wav,
        buildBiasPrompt(parseDictionary(s.dictionary).promptWords),
        s.language || undefined
      ),
    deliver: (text, item) => {
      void (async () => {
        let final = text
        try {
          const cleaned = (await cleanup(text, item.settings)) || text
          final = applyReplacements(cleaned, parseDictionary(item.settings.dictionary).replacements)
        } catch {
          /* keep raw */
        }
        history.append({
          ts: Date.now(),
          raw: text,
          final,
          durationMs: 0,
          tags: ['recovered'],
          mode: item.settings.flowMode
        })
        notify('OwenFlow — recovered dictation', final.slice(0, 140), () =>
          clipboard.writeText(final)
        )
      })()
    },
    onDrop: () =>
      notify(
        'OwenFlow — dictation lost',
        'Could not transcribe a queued dictation (sidecar unavailable).',
        () => {}
      )
  })

  // Meeting mode: capture in its own hidden window (created lazily on first
  // start), transcription serially in main, transcript appended per segment.
  // Meetings COEXIST with dictation — nothing below blocks the pipeline.
  initMeetingChannel({
    setPillState, // raw: the wrap re-asserts against THIS channel's state
    startCapture: () => {
      void createMeetingWindow()
        .then((win) => win.webContents.send(IPC.meetingCaptureStart))
        .catch((err) => {
          onCaptureError(
            err instanceof Error ? `Meeting window failed: ${err.message}` : 'Meeting window failed'
          )
        })
    },
    stopCapture: () => {
      const win = getMeetingWindow()
      if (win && !win.isDestroyed()) win.webContents.send(IPC.meetingCaptureStop)
      else onCaptureStopped() // no capture window — nothing to flush, don't wait
    },
    getSettings,
    transcribe: (wav, s) =>
      transcribe(
        wav,
        buildBiasPrompt(parseDictionary(s.dictionary).promptWords),
        s.language || undefined
      ),
    isPipelineBusy: () => isDictationActive() || isContinuousActive() || isCommandActive(),
    createMeeting: meetingStore.createMeeting,
    appendEntry: meetingStore.appendEntry,
    readMeta: meetingStore.readMeta,
    writeMeta: meetingStore.writeMeta
  })

  // Auto-detect: poll the ConsentStore every 20s; offer a click-to-record
  // notification when another app holds the mic (requires meetingAutoDetect).
  startMeetingDetect({
    getSettings,
    isMeetingActive,
    startMeeting: () => void startMeeting()
  })

  // Meeting state changes drive the tray toggle label + every open window's
  // meeting UI (the "meeting:state" push half of the preload contract).
  onMeetingStateChange((state) => {
    refreshTrayMenu()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.meetingState, state)
    }
    // Arm the auto-detect cooldown on ANY meeting start, not just the
    // notification path.  Without this the 20s poll can re-prompt while
    // Owen is already in a meeting started via F10 or the tray toggle:
    // the notification path sets lastPromptAt when showing the note, but
    // a hotkey-started meeting bypasses that entirely.  Calling
    // notePromptShown on every active→true transition is harmless for the
    // notification path (already armed) and closes the gap for all others.
    if (state.active) notePromptShown(Date.now())
  })

  initPipeline({
    setPillState: pushPillState,
    recorderStart,
    recorderStop,
    getSettings,
    appendHistory: history.append,
    // `context` (trailing words of the transcript so far, for segment
    // boundary accuracy) goes AFTER the bias prompt: whisper conditions most
    // strongly on the trailing tokens of initial_prompt, and the context is
    // what immediately precedes the audio being decoded.
    transcribe: (wav, settings, context) => {
      const { promptWords } = parseDictionary(settings.dictionary)
      const bias = buildBiasPrompt(promptWords)
      const prompt = [bias, context].filter(Boolean).join(' ') || undefined
      return transcribe(wav, prompt, settings.language || undefined)
    },
    cleanup,
    inject,
    pressEnter,
    getForegroundApp,
    enqueueTranscription: (wav, s, startedAt) => enqueue(wav, s, startedAt),
    isMeetingActive
  })

  initContinuousChannel({
    setPillState: pushPillState,
    startRecorder: () => recorderStart(true),
    stopRecorder: () => getRecorderWindow()?.webContents.send(IPC.recorderStop),
    getSettings,
    appendHistory: history.append,
    transcribe: (wav, s) =>
      transcribe(
        wav,
        buildBiasPrompt(parseDictionary(s.dictionary).promptWords),
        s.language || undefined
      ),
    cleanup,
    inject
  })

  initCommandChannel({
    setPillState: pushPillState,
    recorderStart,
    recorderStop,
    getSettings,
    appendHistory: history.append,
    transcribe: (wav, s) =>
      transcribe(
        wav,
        buildBiasPrompt(parseDictionary(s.dictionary).promptWords),
        s.language || undefined
      ),
    copySelection,
    runCommand,
    inject,
    notify: (title, body) => notify(title, body, () => {}),
    sendZeal: (instruction) => sendZealCommand(instruction, getSettings()),
    speak: (text) => getPillWindow()?.webContents.send(IPC.ttsSpeak, text)
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
    // Meeting toggle: label + routing live behind the channel's state; the
    // onMeetingStateChange hook above rebuilds this menu on every flip.
    isMeetingActive,
    getMeetingElapsed: () =>
      formatMeetingElapsed(Date.now() - (getMeetingState().startedAt ?? Date.now())),
    onToggleMeeting: () => {
      if (isMeetingActive()) void stopMeeting()
      else void startMeeting()
    },
    onOpenSettings: () => void openSettingsWindow('settings'),
    onOpenHistory: () => void openSettingsWindow('history'),
    onShowDigest: () => {
      const d = digestNow()
      if (d) {
        notify(d.title, d.body, () => void openSettingsWindow('history'))
      } else {
        notify(
          'OwenFlow — digest',
          'No dictations yet today.',
          () => void openSettingsWindow('history')
        )
      }
    },
    onQuit: () => app.quit(),
    getSessions: () => parseSessionTones(getSettings().sessionTones).map((t) => t.label),
    getActiveSession: () => getSettings().activeSession,
    onSetActiveSession: (label) => {
      setSettings({ activeSession: label })
    },
    // Pill position submenu: persist the pick; windows.ts re-reads it on
    // every pill show, so no reposition call is needed here.
    getPillPosition: () => getSettings().pillPosition,
    onSetPillPosition: (position) => {
      setSettings({ pillPosition: position })
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
    // On quit, before-quit destroys the tray before will-quit's stopSidecar()
    // emits a final 'stopped' status — guard so the late update can't throw
    // "Tray is destroyed".
    if (tray.isDestroyed()) return
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
      if (isCommandActive()) return
      if (getSettings().continuousMode) startContinuous()
      else void startDictation()
    },
    onStop: () => {
      if (isContinuousActive()) stopContinuous()
      else void stopDictation()
    },
    // Escape aborts an active dictation (recording or transcribing), including continuous.
    isDictationActive: () => isDictationActive() || isContinuousActive(),
    onCancel: () => {
      if (isContinuousActive()) cancelContinuous()
      else cancelDictation()
    }
  })

  // Second hotkey for the command channel.
  startCommandHotkey({
    hotkey: initial.commandHotkey,
    mode: initial.mode,
    isEnabled: () => dictationEnabled && getSettings().commandEnabled,
    onStart: () => {
      if (!isDictationActive() && !isContinuousActive()) void startCommand()
    },
    onStop: () => void stopCommand(),
    isActive: () => isCommandActive(),
    onCancel: () => {
      cancelCommand()
    }
  })

  // ── Mode-switch flash on the pill ─────────────────────────────────────────
  // Transient "mode switched" notice. Main owns the hide timer (same pattern
  // as pipeline.ts failPill — the pill renderer only animates in/out).
  const MODE_NOTICE_MS = 900
  const MODE_NOTICE_LABELS: Record<FlowMode, string> = {
    normal: 'Normal',
    vibe: 'Vibe Coding',
    formal: 'Formal',
    translate: 'Translate' // unreachable via the cycle — kept for totality
  }
  let modeNoticeTimer: NodeJS.Timeout | null = null
  function flashModeNotice(mode: FlowMode): void {
    // Through the wrap: the notice shows as-is, and its idle hide below
    // re-asserts the meeting display instead of hiding a running meeting.
    pushPillState({ state: 'notice', message: MODE_NOTICE_LABELS[mode] })
    if (modeNoticeTimer) clearTimeout(modeNoticeTimer)
    modeNoticeTimer = setTimeout(() => {
      modeNoticeTimer = null
      // A dictation/command started inside the notice window owns the pill
      // now — hiding it here would kill the live recording display.
      if (isDictationActive() || isCommandActive() || isContinuousActive()) return
      pushPillState({ state: 'idle' })
    }, MODE_NOTICE_MS)
  }

  // Third hotkey: tap to cycle flow modes (normal → vibe → formal). Persists
  // through setSettings — the same path as the tray Mode submenu — so the
  // onSettingsChange listener below rebuilds the tray radios automatically.
  startModeHotkey({
    hotkey: initial.modeHotkey,
    isEnabled: () => dictationEnabled,
    getSettings,
    setSettings: (patch) => {
      setSettings(patch)
    },
    // Mid-take switches still persist, but skip the flash (see mode-hotkey.ts).
    isBusy: () => isDictationActive() || isCommandActive() || isContinuousActive(),
    showNotice: flashModeNotice
  })

  // Fourth hotkey: tap to toggle the meeting recorder (default F10). Start vs
  // stop is decided here off the channel state — the hotkey module is a pure
  // key→callback bridge like mode-hotkey.
  startMeetingHotkey({
    hotkey: initial.meetingHotkey,
    isEnabled: () => dictationEnabled,
    onToggle: () => {
      if (isMeetingActive()) void stopMeeting()
      else void startMeeting()
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
    if (
      next.commandHotkey !== prev.commandHotkey ||
      next.commandEnabled !== prev.commandEnabled ||
      next.mode !== prev.mode
    ) {
      reconfigureCommandHotkey(next.commandHotkey, next.mode)
    }
    if (next.modeHotkey !== prev.modeHotkey) {
      // Live-rebind the mode-cycle key (empty string disables it entirely).
      reconfigureModeHotkey(next.modeHotkey)
    }
    if (next.meetingHotkey !== prev.meetingHotkey) {
      // Live-rebind the meeting toggle key (empty string disables it entirely).
      reconfigureMeetingHotkey(next.meetingHotkey)
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
    if (next.pillPosition !== prev.pillPosition) {
      // Keep the tray radio in sync if the setting changes outside the tray
      // (there's no settings-UI control yet, but IPC settings:set can do it).
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
  stopCommandHotkey()
  stopModeHotkey()
  stopMeetingHotkey()
  stopMeetingDetect()
  // Quit mid-meeting: stamp endedAt synchronously so the meeting lists as
  // ended, not crashed. Segments already on disk are safe (append-per-segment);
  // whatever was still queued is lost — same contract as quitting mid-dictation.
  endMeetingOnQuit()
  stopSidecar()
  killInjector()
})
