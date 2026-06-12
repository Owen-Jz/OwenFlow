/**
 * Shared types between main, preload and renderer.
 * IPC channel names follow the spec exactly:
 *   recorder:start, recorder:stop, recorder:data,
 *   pill:state, settings:get, settings:set, history:list, history:clear
 */

export type DictationMode = 'hold' | 'toggle'

/**
 * Output style mode:
 *  - normal: types exactly what you say (optional AI cleanup pass)
 *  - vibe:   restructures rambly speech into a refined AI coding prompt
 *  - formal: client-ready professional tone
 */
export type FlowMode = 'normal' | 'vibe' | 'formal'

export type WhisperModel = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'large-v3-turbo'

export interface OwenFlowSettings {
  /** uiohook keycode name, e.g. "RightCtrl" */
  hotkey: string
  mode: DictationMode
  /** Output style: normal (verbatim), vibe (AI prompt), formal (client tone). */
  flowMode: FlowMode
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
  /**
   * Topic tags (auto-tagged + manual). Old JSONL lines without tags
   * still parse — history.list() normalizes missing tags to [].
   */
  tags: string[]
  /** Flow mode the dictation ran in (normal/vibe/formal); absent on old lines. */
  mode?: string
}

/** One distinct tag with how many history entries carry it. */
export interface TagCount {
  tag: string
  count: number
}

export type PillStateName = 'idle' | 'recording' | 'transcribing' | 'done' | 'error'

/**
 * Compact live audio level frame emitted by the recorder while capturing:
 * LEVEL_BINS values, each 0..1 (averaged frequency magnitude per band).
 */
export type LevelFrame = number[]

/** Number of bins in a LevelFrame. */
export const LEVEL_BINS = 16

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
    /** Replace the tag set of the entry with timestamp ts ("history:updateTags"). */
    updateTags: (ts: number, tags: string[]) => Promise<boolean>
    /** Distinct tags with usage counts ("history:tags"). */
    tags: () => Promise<TagCount[]>
  }
  pill: {
    /** Subscribe to pill state pushes ("pill:state"). Returns unsubscribe. */
    onState: (cb: (state: PillState) => void) => () => void
    /** Subscribe to live audio level frames ("recorder:level"). Returns unsubscribe. */
    onLevel: (cb: (frame: LevelFrame) => void) => () => void
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
    /** Emit a live audio level frame while recording ("recorder:level"). */
    sendLevel: (frame: LevelFrame) => void
  }
  ui: {
    /** Settings window: main asks to switch tab ("settings" | "history"). */
    onShowTab: (cb: (tab: 'settings' | 'history') => void) => () => void
  }
  clipboard: {
    /**
     * Copy text via main-process Electron clipboard ("clipboard:write").
     * navigator.clipboard is unavailable in the packaged file:// context.
     */
    write: (text: string) => Promise<boolean>
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
  recorderLevel: 'recorder:level',
  pillState: 'pill:state',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  historyList: 'history:list',
  historyClear: 'history:clear',
  historyUpdateTags: 'history:updateTags',
  historyTags: 'history:tags',
  clipboardWrite: 'clipboard:write',
  uiShowTab: 'ui:show-tab',
  debugSimulate: 'debug:simulate-dictation'
} as const
