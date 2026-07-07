import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfo,
  FolderCount,
  HistoryEntry,
  LevelFrame,
  MeetingEntry,
  MeetingMeta,
  MeetingStateInfo,
  MeetingStream,
  OwenFlowApi,
  OwenFlowSettings,
  PillState,
  ProviderTiming,
  SidecarStatusInfo,
  TagCount
} from '../shared/types'
import { IPC } from '../shared/types'

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => {
    cb(...(args as T))
  }
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: OwenFlowApi = {
  settings: {
    get: (): Promise<OwenFlowSettings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<OwenFlowSettings>): Promise<OwenFlowSettings> =>
      ipcRenderer.invoke(IPC.settingsSet, patch),
    export: (): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke(IPC.settingsExport),
    import: (): Promise<{ ok: boolean; applied?: number; error?: string }> =>
      ipcRenderer.invoke(IPC.settingsImport)
  },
  history: {
    list: (limit?: number): Promise<HistoryEntry[]> => ipcRenderer.invoke(IPC.historyList, limit),
    clear: (): Promise<void> => ipcRenderer.invoke(IPC.historyClear),
    updateTags: (ts: number, tags: string[]): Promise<boolean> =>
      ipcRenderer.invoke(IPC.historyUpdateTags, ts, tags),
    tags: (): Promise<TagCount[]> => ipcRenderer.invoke(IPC.historyTags),
    setFolder: (ts: number, folder: string | null): Promise<boolean> =>
      ipcRenderer.invoke(IPC.historySetFolder, ts, folder),
    folders: (): Promise<FolderCount[]> => ipcRenderer.invoke(IPC.historyFolders),
    renameFolder: (from: string, to: string): Promise<number> =>
      ipcRenderer.invoke(IPC.historyRenameFolder, from, to),
    deleteFolder: (name: string): Promise<number> =>
      ipcRenderer.invoke(IPC.historyDeleteFolder, name)
  },
  pill: {
    onState: (cb: (state: PillState) => void) => subscribe<[PillState]>(IPC.pillState, cb),
    onLevel: (cb: (frame: LevelFrame) => void) => subscribe<[LevelFrame]>(IPC.recorderLevel, cb)
  },
  recorder: {
    onStart: (cb: (continuous: boolean) => void) => subscribe<[boolean]>(IPC.recorderStart, cb),
    onStop: (cb: () => void) => subscribe<[]>(IPC.recorderStop, cb),
    sendData: (wav: ArrayBuffer): void => {
      ipcRenderer.send(IPC.recorderData, wav)
    },
    sendSegment: (wav: ArrayBuffer): void => {
      ipcRenderer.send(IPC.recorderSegment, wav)
    },
    sendDone: (): void => {
      ipcRenderer.send(IPC.recorderDone)
    },
    sendError: (message: string): void => {
      ipcRenderer.send(IPC.recorderError, message)
    },
    sendLevel: (frame: LevelFrame): void => {
      ipcRenderer.send(IPC.recorderLevel, frame)
    }
  },
  ui: {
    onShowTab: (cb: (tab: 'settings' | 'history') => void) =>
      subscribe<['settings' | 'history']>(IPC.uiShowTab, cb)
  },
  clipboard: {
    write: (text: string): Promise<boolean> => ipcRenderer.invoke(IPC.clipboardWrite, text)
  },
  cleanup: {
    benchmark: (): Promise<ProviderTiming[]> => ipcRenderer.invoke(IPC.cleanupBenchmark)
  },
  debug: {
    simulateDictation: (): Promise<void> => ipcRenderer.invoke(IPC.debugSimulate)
  },
  appinfo: {
    get: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo)
  },
  sidecar: {
    get: (): Promise<SidecarStatusInfo> => ipcRenderer.invoke(IPC.sidecarStatusGet),
    onStatus: (cb: (info: SidecarStatusInfo) => void) =>
      subscribe<[SidecarStatusInfo]>(IPC.sidecarStatus, cb)
  },
  apps: {
    detect: (): Promise<string | null> => ipcRenderer.invoke(IPC.appsDetect)
  },
  learn: {
    propose: (raw: string, corrected: string): Promise<string[]> =>
      ipcRenderer.invoke(IPC.learnPropose, raw, corrected)
  },
  tts: {
    onSpeak: (cb: (text: string) => void) => subscribe<[string]>(IPC.ttsSpeak, cb)
  },
  win: {
    minimize: (): void => {
      ipcRenderer.send(IPC.winMinimize)
    },
    maximize: (): void => {
      ipcRenderer.send(IPC.winMaximize)
    },
    close: (): void => {
      ipcRenderer.send(IPC.winClose)
    }
  },
  dictation: {
    start: (): Promise<void> => ipcRenderer.invoke(IPC.dictationStart)
  },
  meetings: {
    start: (): Promise<boolean> => ipcRenderer.invoke(IPC.meetingStart),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.meetingStop),
    state: (): Promise<MeetingStateInfo> => ipcRenderer.invoke(IPC.meetingState),
    onState: (cb: (s: MeetingStateInfo) => void) =>
      subscribe<[MeetingStateInfo]>(IPC.meetingState, cb),
    list: (): Promise<MeetingMeta[]> => ipcRenderer.invoke(IPC.meetingList),
    get: (id: string): Promise<{ meta: MeetingMeta; entries: MeetingEntry[] }> =>
      ipcRenderer.invoke(IPC.meetingGet, id),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.meetingDelete, id),
    summarize: (id: string): Promise<string> => ipcRenderer.invoke(IPC.meetingSummarize, id),
    rename: (id: string, title: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.meetingRename, id, title),
    sendActions: (id: string): Promise<{ items: string[]; sent: boolean; reply: string }> =>
      ipcRenderer.invoke(IPC.meetingActions, id)
  },
  meetingCapture: {
    onStart: (cb: () => void) => subscribe<[]>(IPC.meetingCaptureStart, cb),
    onStop: (cb: () => void) => subscribe<[]>(IPC.meetingCaptureStop, cb),
    sendSegment: (wav: ArrayBuffer, stream: MeetingStream, startedAtMs: number): void => {
      ipcRenderer.send(IPC.meetingSegment, wav, stream, startedAtMs)
    },
    sendStopped: (): void => {
      ipcRenderer.send(IPC.meetingCaptureStopped)
    },
    sendError: (message: string): void => {
      ipcRenderer.send(IPC.meetingCaptureError, message)
    }
  },
  scratchpad: {
    getContent: (): Promise<string> => ipcRenderer.invoke(IPC.scratchpadGetContent),
    setContent: (text: string): void => {
      ipcRenderer.send(IPC.scratchpadSetContent, text)
    },
    setCapture: (on: boolean): void => {
      ipcRenderer.send(IPC.scratchpadSetCapture, on)
    },
    close: (): void => {
      ipcRenderer.send(IPC.scratchpadClose)
    },
    onAppend: (cb: (text: string) => void) => subscribe<[string]>(IPC.scratchpadAppend, cb),
    onState: (cb: (state: { capturing: boolean }) => void) =>
      subscribe<[{ capturing: boolean }]>(IPC.scratchpadState, cb)
  }
}

contextBridge.exposeInMainWorld('owenflow', api)
