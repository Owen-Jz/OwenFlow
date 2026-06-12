/**
 * Shared types between main, preload and renderer.
 * IPC channel names follow the spec exactly:
 *   recorder:start, recorder:stop, recorder:data,
 *   pill:state, settings:get, settings:set, history:list, history:clear
 */

export type DictationMode = 'hold' | 'toggle'

export type WhisperModel = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3'

export interface OwenFlowSettings {
  /** uiohook keycode name, e.g. "RightCtrl" */
  hotkey: string
  mode: DictationMode
  model: WhisperModel
  /** empty string = auto-detect */
  language: string
  cleanupEnabled: boolean
  minimaxApiKey: string
  minimaxGroupId: string
  /**
   * Dictionary entries, one per item.
   * Plain words bias whisper recognition (initial_prompt);
   * "wrong=>right" entries are post-transcription replacements.
   */
  dictionary: string[]
  launchOnStartup: boolean
}

export interface HistoryEntry {
  /** epoch ms */
  ts: number
  /** raw whisper transcript */
  raw: string
  /** final injected text (after cleanup + dictionary) */
  final: string
  durationMs: number
  /** focused app at injection time (filled in by Wave 2) */
  app?: string
}

export type PillStateName = 'idle' | 'recording' | 'transcribing' | 'done' | 'error'

export interface PillState {
  state: PillStateName
  /** optional message, used by the error state (and future extensions) */
  message?: string
}

/** API exposed on window.owenflow by the preload script. */
export interface OwenFlowApi {
  settings: {
    get: () => Promise<OwenFlowSettings>
    set: (patch: Partial<OwenFlowSettings>) => Promise<OwenFlowSettings>
  }
  history: {
    list: (limit?: number) => Promise<HistoryEntry[]>
    clear: () => Promise<void>
  }
  pill: {
    /** Subscribe to pill state pushes ("pill:state"). Returns unsubscribe. */
    onState: (cb: (state: PillState) => void) => () => void
  }
  recorder: {
    /** Main asks the hidden recorder window to start capturing ("recorder:start"). */
    onStart: (cb: () => void) => () => void
    /** Main asks the recorder to stop ("recorder:stop"). */
    onStop: (cb: () => void) => () => void
    /** Recorder replies with a 16kHz mono WAV ("recorder:data"). */
    sendData: (wav: ArrayBuffer) => void
    /** Report a capture error to main (mic denied etc.). */
    sendError: (message: string) => void
  }
  ui: {
    /** Settings window: main asks to switch tab ("settings" | "history"). */
    onShowTab: (cb: (tab: 'settings' | 'history') => void) => () => void
  }
  debug: {
    /** Trigger the stub pipeline so the pill can be visually verified. */
    simulateDictation: () => Promise<void>
  }
}

/** All IPC channel names in one place. */
export const IPC = {
  recorderStart: 'recorder:start',
  recorderStop: 'recorder:stop',
  recorderData: 'recorder:data',
  recorderError: 'recorder:error',
  pillState: 'pill:state',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  historyList: 'history:list',
  historyClear: 'history:clear',
  uiShowTab: 'ui:show-tab',
  debugSimulate: 'debug:simulate-dictation'
} as const
