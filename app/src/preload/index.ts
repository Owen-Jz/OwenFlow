import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfo,
  FolderCount,
  HistoryEntry,
  LevelFrame,
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
      ipcRenderer.invoke(IPC.settingsSet, patch)
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
    onStart: (cb: () => void) => subscribe<[]>(IPC.recorderStart, cb),
    onStop: (cb: () => void) => subscribe<[]>(IPC.recorderStop, cb),
    sendData: (wav: ArrayBuffer): void => {
      ipcRenderer.send(IPC.recorderData, wav)
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
  }
}

contextBridge.exposeInMainWorld('owenflow', api)
