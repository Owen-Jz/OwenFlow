/**
 * Shared types between main, preload and renderer.
 * IPC channel names follow the spec exactly:
 *   recorder:start, recorder:stop, recorder:data,
 *   pill:state, settings:get, settings:set, history:list, history:clear
 */

export type DictationMode = 'hold' | 'toggle'

/**
 * Output style mode:
 *  - normal:    types exactly what you say (optional AI cleanup pass)
 *  - vibe:      restructures rambly speech into a refined AI coding prompt
 *  - formal:    client-ready professional tone
 *  - translate: transcribes, then translates to a target language
 */
export type FlowMode = 'normal' | 'vibe' | 'formal' | 'translate'

export type WhisperModel = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'large-v3-turbo'

/** Which LLM backend runs the refinement/cleanup pass. */
export type CleanupProvider = 'groq' | 'minimax'

/**
 * Auto Cleanup intensity for Normal mode (Wispr-Flow-style control against
 * over-editing). Vibe/formal/translate are modes, not cleanup — they ignore it.
 *  - none:   no LLM pass at all; the raw transcript is pasted verbatim.
 *  - light:  ONLY remove filler words and add basic punctuation/casing —
 *            every word stays as spoken (no self-correction resolution,
 *            no number/email reformatting).
 *  - medium: full Wispr-style auto-edit — fillers, false starts, spoken
 *            self-corrections resolved, dictated punctuation, number/email/URL
 *            formatting — while preserving the speaker's voice (the default).
 *  - high:   medium plus restructuring — breaks up run-on sentences, formats
 *            spoken enumerations ("first… second…") as lists, fixes grammar —
 *            still preserving voice and never adding content.
 */
export type CleanupIntensity = 'none' | 'light' | 'medium' | 'high'

/** Result of timing one provider's refinement round-trip ("cleanup:benchmark"). */
export interface ProviderTiming {
  provider: CleanupProvider
  ok: boolean
  /** Round-trip milliseconds (0 when skipped for a missing key). */
  ms: number
  /** Present when ok is false: 'no API key', 'HTTP 429', an abort/network message, etc. */
  error?: string
}

/**
 * Settings-window theme. 'system' follows the OS prefers-color-scheme,
 * including live changes. The pill overlay is always dark glass.
 */
export type ThemeMode = 'dark' | 'light' | 'system'

/**
 * Where the pill overlay sits on the primary display (Wispr Flow locks it to
 * bottom-center — being movable is our win). Tray-driven, no settings UI:
 * the position is re-read on every pill show, so a change takes effect the
 * next time the pill appears.
 */
export type PillPosition = 'bottom-center' | 'top-center' | 'bottom-left' | 'bottom-right'

/** A per-app formatting profile, matched on focused process name. */
export interface AppProfile {
  /** Process names (no .exe), case-insensitive, e.g. ["Code","Cursor"]. */
  match: string[]
  /** Pin a flow mode while this app is focused; omitted = inherit. */
  flowMode?: FlowMode
  /** Strip a trailing sentence period from the output. */
  stripTrailingPeriod?: boolean
  /** Lowercase the first letter (don't auto-capitalize). */
  noAutoCapitalize?: boolean
  /** Collapse internal newlines to single spaces. */
  singleLine?: boolean
  /** Per-app "wrong=>right" replacement lines. */
  replacements?: string[]
  /** Extra instruction appended to the cleanup system prompt. */
  promptRule?: string
}

export interface OwenFlowSettings {
  /** uiohook keycode name, e.g. "RightCtrl" */
  hotkey: string
  mode: DictationMode
  /** Output style: normal (verbatim), vibe (AI prompt), formal (client tone). */
  flowMode: FlowMode
  model: WhisperModel
  /** empty string = auto-detect */
  language: string
  /**
   * Legacy master toggle for the Normal-mode cleanup pass. Superseded by
   * cleanupIntensity (off maps to 'none', on to 'medium' during migration)
   * but still honored as a hard off-switch when false, and kept in sync by
   * the settings UI so older readers (e.g. continuous mode) stay correct.
   */
  cleanupEnabled: boolean
  /** How aggressively Normal mode is auto-edited (see CleanupIntensity). */
  cleanupIntensity: CleanupIntensity
  /** Which LLM provider runs the cleanup/refinement pass. */
  cleanupProvider: CleanupProvider
  minimaxApiKey: string
  minimaxGroupId: string
  /** Groq API key (used when cleanupProvider === 'groq'). Stored locally only. */
  groqApiKey: string
  /** Groq model id for vibe/formal/translate (reasoning-heavy rewrites). */
  groqModel: string
  /**
   * Groq model id for normal-mode cleanup + digest summaries. Benchmarked
   * 2026-07-04: llama-3.1-8b-instant matches 70b quality on cleanup at ~330ms
   * vs ~780ms — cleanup is mechanical, the structural modes keep the big model.
   */
  groqModelFast: string
  /**
   * Dictionary entries, one per item.
   * Plain words bias whisper recognition (initial_prompt);
   * "wrong=>right" entries are post-transcription replacements.
   */
  dictionary: string[]
  /** Voice snippets: "trigger => expansion" per line; matched whole-utterance, pasted verbatim. */
  snippets: string[]
  /** Target language for the Translate flow mode (e.g. "English", "Spanish"). */
  translateTarget: string
  /** Session tones: "label => mode" per line (mode in normal|vibe|formal|translate). */
  sessionTones: string[]
  /** Active session label ('' = none); maps to a tone via sessionTones and auto-tags history. */
  activeSession: string
  /** Master switch for app-aware formatting profiles. */
  appProfilesEnabled: boolean
  /** Per-app formatting profiles (matched on focused process name). */
  profiles: AppProfile[]
  /** Show a daily dictation digest notification. */
  digestEnabled: boolean
  /** Hour of day (0-23) to fire the digest. */
  digestHour: number
  /** Include an LLM theme summary in the digest (opt-in; uses your provider). */
  digestThemes: boolean
  /** Enable the speak-to-act command channel (second hotkey). */
  commandEnabled: boolean
  /** uiohook keycode name for the command hotkey. */
  commandHotkey: string
  /**
   * uiohook keycode name for the flow-mode cycling hotkey: each tap steps
   * normal → vibe → formal → normal (translate stays tray/settings-only).
   * Empty string = disabled.
   */
  modeHotkey: string
  /**
   * uiohook keycode name for the meeting-mode hotkey: each tap toggles the
   * meeting recorder on/off. Empty string = disabled.
   */
  meetingHotkey: string
  /**
   * Watch for other apps using the microphone and offer to record the call.
   * Default on.
   */
  meetingAutoDetect: boolean
  /**
   * Read the focused app's text (and browser URL) via UI Automation to improve
   * name spelling and code-identifier recognition. Windows-only; best-effort.
   * Sends a short focused-field snippet to the cleanup LLM, so it ships OFF by
   * default (opt-in).
   */
  contextAwareness: boolean
  /** Long-form draft mode: stream segments on pauses. */
  continuousMode: boolean
  /** ZEAL voice-command endpoint (POST /api/voice). */
  zealEndpoint: string
  /** Bearer key for the ZEAL voice endpoint (x-voice-key). */
  zealApiKey: string
  /** Speak ZEAL replies aloud (TTS). */
  zealSpeakReplies: boolean
  launchOnStartup: boolean
  /** Settings-window theme (dark | light | system). */
  theme: ThemeMode
  /** Where the pill overlay sits on screen (tray-driven; default bottom-center). */
  pillPosition: PillPosition
}

/** Static app facts for the About section ("app:info"). */
export interface AppInfo {
  version: string
  /** userData directory where config + history live. */
  dataDir: string
}

/** Sidecar status snapshot pushed to the settings window ("sidecar:status"). */
export interface SidecarStatusInfo {
  status: 'stopped' | 'starting' | 'ready' | 'error'
  detail: string
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
  /**
   * Folder the entry lives in (at most one; separate axis from tags).
   * Absent/undefined = unfiled. Old JSONL lines without it still parse.
   */
  folder?: string
}

/** One distinct tag with how many history entries carry it. */
export interface TagCount {
  tag: string
  count: number
}

/** One distinct folder with how many history entries live in it. */
export interface FolderCount {
  folder: string
  count: number
}

// ─── Meeting mode ────────────────────────────────────────────────────────────

/**
 * Which capture stream a meeting segment came from:
 *  - you:  the microphone (Owen's voice)
 *  - them: Windows loopback / system audio (everyone else in the call —
 *          whatever plays on the output device)
 */
export type MeetingStream = 'you' | 'them'

/**
 * One transcribed meeting segment — a single line of
 * <userData>/meetings/<id>/transcript.jsonl. Appended to disk the moment its
 * transcription lands (crash-safety: a crash loses at most the in-flight
 * segment, never the transcript so far).
 */
export interface MeetingEntry {
  /** Segment start, epoch ms (segments interleave chronologically by this). */
  t: number
  speaker: MeetingStream
  /** Transcript text; '[inaudible]' marks a segment that failed twice. */
  text: string
}

/**
 * <userData>/meetings/<id>/meta.json. Written at meeting start ({id,
 * startedAt} only) so even a crash mid-meeting leaves a listable meeting;
 * endedAt/durationMs land on stop, words on a throttle while running, and
 * summary lazily on the first meetings.summarize(id) call.
 */
export interface MeetingMeta {
  /** Local-time meeting id, "YYYY-MM-DD-HHmmss" — also the folder name. */
  id: string
  /** epoch ms */
  startedAt: number
  /** epoch ms; absent = still running (or the app crashed mid-meeting). */
  endedAt?: number
  durationMs?: number
  /** Total transcript words so far (excludes '[inaudible]' markers). */
  words?: number
  /** LLM meeting summary; generated + persisted on demand (meetings.summarize). */
  summary?: string
  /** Custom title (meetings.rename); absent = UI shows the friendly recorded date. */
  title?: string
  /** epoch ms when action items were last sent to ZEAL. */
  actionsSentAt?: number
  /**
   * epoch ms of the last meta write (stamped centrally by writeMeta) — end of
   * meeting, word-count refresh, or a later summary. The Meetings UI shows it
   * as "Updated" next to the recorded date.
   */
  updatedAt?: number
}

/** Live meeting snapshot ("meeting:state" invoke AND push payload). */
export interface MeetingStateInfo {
  active: boolean
  /** epoch ms of the running meeting, or null when none is active. */
  startedAt: number | null
}

export type PillStateName =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'done'
  | 'error'
  | 'notice'
  | 'meeting'

/**
 * Compact live audio level frame emitted by the recorder while capturing:
 * LEVEL_BINS values, each 0..1 (averaged frequency magnitude per band).
 */
export type LevelFrame = number[]

/** Number of bins in a LevelFrame. */
export const LEVEL_BINS = 16

export interface PillState {
  state: PillStateName
  /**
   * optional message: the error text for 'error', or the flow-mode label
   * ("Normal" / "Vibe Coding" / "Formal") for the transient 'notice' flash
   */
  message?: string
  /**
   * 'meeting' only: meeting start (epoch ms) so the pill's elapsed timer
   * survives re-assertion — after a mid-meeting dictation finishes, main
   * re-pushes 'meeting' and the timer must resume from the true start, not 0.
   */
  startedAt?: number
}

/** API exposed on window.owenflow by the preload script. */
export interface OwenFlowApi {
  settings: {
    get: () => Promise<OwenFlowSettings>
    set: (patch: Partial<OwenFlowSettings>) => Promise<OwenFlowSettings>
    /** Write current settings to a user-chosen JSON file ("settings:export"). */
    export: () => Promise<{ ok: boolean; path?: string; error?: string }>
    /** Read and merge a previously exported settings file ("settings:import"). */
    import: () => Promise<{ ok: boolean; applied?: number; error?: string }>
  }
  history: {
    list: (limit?: number) => Promise<HistoryEntry[]>
    clear: () => Promise<void>
    /** Replace the tag set of the entry with timestamp ts ("history:updateTags"). */
    updateTags: (ts: number, tags: string[]) => Promise<boolean>
    /** Distinct tags with usage counts ("history:tags"). */
    tags: () => Promise<TagCount[]>
    /** Move the entry with timestamp ts into a folder; null unfiles it ("history:setFolder"). */
    setFolder: (ts: number, folder: string | null) => Promise<boolean>
    /** Distinct folders with entry counts, alphabetical ("history:folders"). */
    folders: () => Promise<FolderCount[]>
    /** Rename a folder across all its entries; resolves to entries changed ("history:renameFolder"). */
    renameFolder: (from: string, to: string) => Promise<number>
    /** Delete a folder: unfile all its entries; resolves to entries changed ("history:deleteFolder"). */
    deleteFolder: (name: string) => Promise<number>
  }
  pill: {
    /** Subscribe to pill state pushes ("pill:state"). Returns unsubscribe. */
    onState: (cb: (state: PillState) => void) => () => void
    /** Subscribe to live audio level frames ("recorder:level"). Returns unsubscribe. */
    onLevel: (cb: (frame: LevelFrame) => void) => () => void
  }
  recorder: {
    /**
     * Main asks the hidden recorder window to start capturing
     * ("recorder:start"). `continuous` picks the finalize contract: true →
     * per-segment paste flow ending in recorder:done; false (normal one-shot)
     * → segments are only PRE-transcribed and recorder:data carries the final
     * remainder.
     */
    onStart: (cb: (continuous: boolean) => void) => () => void
    /** Main asks the recorder to stop ("recorder:stop"). */
    onStop: (cb: () => void) => () => void
    /**
     * Normal mode's stop reply: the 16kHz mono WAV since the last
     * pause-flushed segment — the whole take when nothing was flushed
     * ("recorder:data").
     */
    sendData: (wav: ArrayBuffer) => void
    /**
     * Send a pause-flushed mid-session audio segment ("recorder:segment").
     * Both modes: continuous pastes it per segment, normal pre-transcribes it
     * in the background. Always delivered BEFORE recorder:data (ordered IPC).
     */
    sendSegment: (wav: ArrayBuffer) => void
    /** Continuous mode only: all segments have been flushed ("recorder:done"). */
    sendDone: () => void
    /** Report a capture error to main (mic denied etc.). */
    sendError: (message: string) => void
    /** Emit a live audio level frame while recording ("recorder:level"). */
    sendLevel: (frame: LevelFrame) => void
  }
  ui: {
    /** Settings window: main asks to switch tab ("settings" | "history"). */
    onShowTab: (cb: (tab: 'settings' | 'history') => void) => () => void
    /**
     * Open the scratchpad window (or focus it when already open).
     * Never closes from this path — open-or-focus semantics only ("ui:open-scratchpad").
     */
    openScratchpad: () => Promise<void>
  }
  clipboard: {
    /**
     * Copy text via main-process Electron clipboard ("clipboard:write").
     * navigator.clipboard is unavailable in the packaged file:// context.
     */
    write: (text: string) => Promise<boolean>
  }
  cleanup: {
    /** Time both providers against a sample sentence ("cleanup:benchmark"). */
    benchmark: () => Promise<ProviderTiming[]>
  }
  debug: {
    /** Trigger the stub pipeline so the pill can be visually verified. */
    simulateDictation: () => Promise<void>
  }
  appinfo: {
    /** Version + data dir for the About section ("app:info"). */
    get: () => Promise<AppInfo>
  }
  sidecar: {
    /** Current sidecar status snapshot ("sidecar:status:get"). */
    get: () => Promise<SidecarStatusInfo>
    /** Subscribe to sidecar status pushes ("sidecar:status"). Returns unsubscribe. */
    onStatus: (cb: (info: SidecarStatusInfo) => void) => () => void
  }
  apps: {
    /** Process name of the current foreground window (no .exe), or null on failure ("apps:detect"). */
    detect: () => Promise<string | null>
  }
  learn: {
    /** Diff raw vs corrected transcript and return "wrong=>right" proposal strings ("learn:propose"). */
    propose: (raw: string, corrected: string) => Promise<string[]>
  }
  tts: {
    /** Subscribe to TTS speak events pushed from main ("tts:speak"). Returns unsubscribe. */
    onSpeak: (cb: (text: string) => void) => () => void
  }
  win: {
    /** Minimize the settings window ("win:minimize"). */
    minimize: () => void
    /** Toggle maximize/restore on the settings window ("win:maximize"). */
    maximize: () => void
    /** Close the settings window ("win:close"). */
    close: () => void
  }
  dictation: {
    /**
     * Home "Dictate now" button: minimize the settings window and start a
     * dictation ("dictation:start"). No-op if a dictation is already active.
     */
    start: () => Promise<void>
  }
  meetings: {
    /**
     * Start a meeting recording ("meeting:start"). Resolves false when a
     * meeting is already active (or the store couldn't be created).
     */
    start: () => Promise<boolean>
    /** Stop the active meeting ("meeting:stop"); resolves once meta is finalized. */
    stop: () => Promise<void>
    /** Current meeting snapshot ("meeting:state" invoke). */
    state: () => Promise<MeetingStateInfo>
    /** Subscribe to meeting state pushes ("meeting:state"). Returns unsubscribe. */
    onState: (cb: (s: MeetingStateInfo) => void) => () => void
    /** All recorded meetings, newest first ("meeting:list"). */
    list: () => Promise<MeetingMeta[]>
    /** One meeting's meta + full transcript ("meeting:get"). */
    get: (id: string) => Promise<{ meta: MeetingMeta; entries: MeetingEntry[] }>
    /** Delete a meeting's folder ("meeting:delete"); active meeting is refused. */
    remove: (id: string) => Promise<void>
    /**
     * The meeting's LLM summary ("meeting:summarize"): generates it if absent,
     * persists it into meta.json, returns it ('' when generation failed).
     */
    summarize: (id: string) => Promise<string>
    /**
     * Set/clear the meeting's custom title ("meeting:rename"). Empty/blank
     * title reverts the UI to the friendly recorded-date title. Resolves
     * false for unknown ids.
     */
    rename: (id: string, title: string) => Promise<boolean>
    /**
     * Extract action items and send them to ZEAL as tasks ("meeting:actions").
     * items=[] means none were found; sent=false with items present means the
     * ZEAL call failed (endpoint/key missing or network) — nothing persisted.
     */
    sendActions: (id: string) => Promise<{ items: string[]; sent: boolean; reply: string }>
  }
  meetingCapture: {
    /** Hidden meeting window: main asks capture to start ("meeting:capture:start"). */
    onStart: (cb: () => void) => () => void
    /** Main asks capture to stop — flush remainders, then sendStopped ("meeting:capture:stop"). */
    onStop: (cb: () => void) => () => void
    /**
     * Ship one pause-flushed segment WAV with its stream + start time
     * ("meeting:segment"). Ordered IPC: every segment lands in main BEFORE
     * the sendStopped() that follows the stop-flush.
     */
    sendSegment: (wav: ArrayBuffer, stream: MeetingStream, startedAtMs: number) => void
    /** All remainders flushed and tracks released ("meeting:capture:stopped"). */
    sendStopped: () => void
    /** Report a capture failure (mic/loopback denied etc.) ("meeting:capture:error"). */
    sendError: (message: string) => void
  }
  scratchpad: {
    /** Pull the current notepad content from main ("scratchpad:get-content"). */
    getContent: () => Promise<string>
    /** Push full textarea content to main on every edit ("scratchpad:set-content"). */
    setContent: (text: string) => void
    /** Toggle the capture flag (renderer checkbox → main) ("scratchpad:set-capture"). */
    setCapture: (on: boolean) => void
    /** Ask main to close the scratchpad window ("scratchpad:close"). */
    close: () => void
    /** Subscribe to dictation text appended by main ("scratchpad:append"). Returns unsubscribe. */
    onAppend: (cb: (text: string) => void) => () => void
    /** Subscribe to capture-state pushes ("scratchpad:state"). Returns unsubscribe. */
    onState: (cb: (state: { capturing: boolean }) => void) => () => void
  }
}

/** All IPC channel names in one place. */
export const IPC = {
  recorderStart: 'recorder:start',
  recorderStop: 'recorder:stop',
  recorderData: 'recorder:data',
  recorderSegment: 'recorder:segment',
  recorderDone: 'recorder:done',
  recorderError: 'recorder:error',
  recorderLevel: 'recorder:level',
  pillState: 'pill:state',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  historyList: 'history:list',
  historyClear: 'history:clear',
  historyUpdateTags: 'history:updateTags',
  historyTags: 'history:tags',
  historySetFolder: 'history:setFolder',
  historyFolders: 'history:folders',
  historyRenameFolder: 'history:renameFolder',
  historyDeleteFolder: 'history:deleteFolder',
  clipboardWrite: 'clipboard:write',
  cleanupBenchmark: 'cleanup:benchmark',
  uiShowTab: 'ui:show-tab',
  uiOpenScratchpad: 'ui:open-scratchpad',
  debugSimulate: 'debug:simulate-dictation',
  appInfo: 'app:info',
  sidecarStatusGet: 'sidecar:status:get',
  sidecarStatus: 'sidecar:status',
  appsDetect: 'apps:detect',
  learnPropose: 'learn:propose',
  ttsSpeak: 'tts:speak',
  winMinimize: 'win:minimize',
  winMaximize: 'win:maximize',
  winClose: 'win:close',
  dictationStart: 'dictation:start',
  // Meeting mode. meetingState doubles as the invoke channel (snapshot) and
  // the push channel (main → windows on every change) — handle() and send()
  // live in separate registries, so one name serves both.
  meetingStart: 'meeting:start',
  meetingStop: 'meeting:stop',
  meetingState: 'meeting:state',
  meetingList: 'meeting:list',
  meetingGet: 'meeting:get',
  meetingDelete: 'meeting:delete',
  meetingSummarize: 'meeting:summarize',
  meetingRename: 'meeting:rename',
  meetingActions: 'meeting:actions',
  // Meeting capture bridge (main ↔ hidden meeting window).
  meetingCaptureStart: 'meeting:capture:start',
  meetingCaptureStop: 'meeting:capture:stop',
  meetingCaptureStopped: 'meeting:capture:stopped',
  meetingSegment: 'meeting:segment',
  meetingCaptureError: 'meeting:capture:error',
  // Settings file export / import.
  settingsExport: 'settings:export',
  settingsImport: 'settings:import',
  // Scratchpad floating notepad (Wave E).
  scratchpadAppend: 'scratchpad:append',
  scratchpadSetContent: 'scratchpad:set-content',
  scratchpadGetContent: 'scratchpad:get-content',
  scratchpadSetCapture: 'scratchpad:set-capture',
  scratchpadState: 'scratchpad:state',
  scratchpadClose: 'scratchpad:close'
} as const
