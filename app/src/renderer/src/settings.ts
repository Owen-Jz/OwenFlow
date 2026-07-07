/**
 * Settings window renderer — frameless charcoal app shell (design option B):
 * Home / Modes / Dictionary / History + a collapsible Advanced group
 * (General / Apps / Command / ZEAL / Digest / About).
 * Typography is the system UI stack (no webfonts).
 */

import { computeHomeStats, hotkeyKeyLabels, relativeTime } from './home-stats'
import type {
  AppProfile,
  CleanupIntensity,
  FlowMode,
  FolderCount,
  HistoryEntry,
  MeetingEntry,
  MeetingMeta,
  MeetingStateInfo,
  OwenFlowSettings,
  SidecarStatusInfo,
  ThemeMode
} from '../../shared/types'

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing element #${id}`)
  return el as T
}

// ─── Theme ──────────────────────────────────────────────────────────────────

const themeOpts = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.seg-opt[data-theme-opt]')
)
const systemDark = window.matchMedia('(prefers-color-scheme: dark)')
let selectedTheme: ThemeMode = 'dark'

/** Resolve + apply the theme to <html data-theme>. */
function applyTheme(): void {
  const resolved =
    selectedTheme === 'system' ? (systemDark.matches ? 'dark' : 'light') : selectedTheme
  document.documentElement.dataset.theme = resolved
}

function selectTheme(theme: ThemeMode): void {
  selectedTheme = theme
  for (const opt of themeOpts) opt.classList.toggle('active', opt.dataset.themeOpt === theme)
  applyTheme()
}

for (const opt of themeOpts) {
  opt.addEventListener('click', () => selectTheme(opt.dataset.themeOpt as ThemeMode))
}

// 'system' follows the OS live (e.g. Windows auto dark at night).
systemDark.addEventListener('change', () => {
  if (selectedTheme === 'system') applyTheme()
})

// ─── Custom titlebar window controls (frameless window) ─────────────────────

$('win-min').addEventListener('click', () => window.owenflow.win.minimize())
$('win-max').addEventListener('click', () => window.owenflow.win.maximize())
$('win-close').addEventListener('click', () => window.owenflow.win.close())

// ─── Sidebar navigation ─────────────────────────────────────────────────────

type SectionName =
  | 'home'
  | 'modes'
  | 'dictionary'
  | 'history'
  | 'meetings'
  | 'general'
  | 'apps'
  | 'command'
  | 'zeal'
  | 'digest'
  | 'about'

const navItems = Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-item'))
const pages: SectionName[] = [
  'home',
  'modes',
  'dictionary',
  'history',
  'meetings',
  'general',
  'apps',
  'command',
  'zeal',
  'digest',
  'about'
]

/** Sections that live inside the collapsible ADVANCED group. */
const ADVANCED_SECTIONS: SectionName[] = ['general', 'apps', 'command', 'zeal', 'digest', 'about']

/** Sections with no settings form → no save bar. */
const NO_SAVE_BAR: SectionName[] = ['home', 'history', 'meetings', 'about']

// Collapsible ADVANCED group — open/closed persists across sessions.
const ADVANCED_LS_KEY = 'owenflow.advancedOpen'
const advancedToggle = $('advanced-toggle')
const advancedSub = $('advanced-sub')

function setAdvancedOpen(open: boolean, persist = true): void {
  advancedSub.classList.toggle('collapsed', !open)
  advancedToggle.classList.toggle('open', open)
  advancedToggle.setAttribute('aria-expanded', String(open))
  if (persist) {
    try {
      localStorage.setItem(ADVANCED_LS_KEY, open ? '1' : '0')
    } catch {
      /* storage unavailable — session-only */
    }
  }
}

advancedToggle.addEventListener('click', () => {
  setAdvancedOpen(advancedSub.classList.contains('collapsed'))
})

// Restore persisted state (default: collapsed).
try {
  setAdvancedOpen(localStorage.getItem(ADVANCED_LS_KEY) === '1', false)
} catch {
  setAdvancedOpen(false, false)
}

/** Section currently on screen — gates the live meeting elapsed ticker. */
let currentSection: SectionName = 'home'

function showSection(name: SectionName): void {
  currentSection = name
  for (const item of navItems) item.classList.toggle('active', item.dataset.section === name)
  for (const page of pages) $(`page-${page}`).classList.toggle('active', page === name)
  // Navigating into an Advanced section (tray, tab link) reveals the group.
  if (ADVANCED_SECTIONS.includes(name) && advancedSub.classList.contains('collapsed')) {
    setAdvancedOpen(true, false)
  }
  // Save bar only applies to the settings-form sections.
  $('form-actions').classList.toggle('hidden', NO_SAVE_BAR.includes(name))
  if (name === 'history') void refreshHistory()
  if (name === 'home') void refreshHome()
  // Meetings always re-enters on the list view (detail is per-visit state).
  if (name === 'meetings') {
    closeMeetingDetail(false)
    void refreshMeetings()
  }
  syncMeetingTicker()
}

for (const item of navItems) {
  item.addEventListener('click', () => showSection(item.dataset.section as SectionName))
}

// Main process still speaks the old two-tab language (tray menu items).
window.owenflow.ui.onShowTab((tab) => showSection(tab === 'history' ? 'history' : 'home'))

// ─── Settings form ──────────────────────────────────────────────────────────

const fHotkey = $<HTMLInputElement>('f-hotkey')
const fModeHotkey = $<HTMLInputElement>('f-mode-hotkey')
const fCommandEnabled = $<HTMLInputElement>('f-command-enabled')
const fCommandHotkey = $<HTMLInputElement>('f-command-hotkey')
const commandHotkeyWarn = $('command-hotkey-warn')
const modeHotkeyWarn = $('mode-hotkey-warn')
function checkHotkeyClash(): void {
  const dictation = fHotkey.value.trim().toLowerCase()
  const command = fCommandHotkey.value.trim().toLowerCase()
  const modeKey = fModeHotkey.value.trim().toLowerCase()
  commandHotkeyWarn.classList.toggle('hidden', !(command && command === dictation))
  // Mode hotkey must differ from BOTH other hotkeys (empty = disabled, never clashes).
  modeHotkeyWarn.classList.toggle(
    'hidden',
    !(modeKey && (modeKey === dictation || modeKey === command))
  )
}
fCommandHotkey.addEventListener('input', checkHotkeyClash)
fHotkey.addEventListener('input', checkHotkeyClash)
fModeHotkey.addEventListener('input', checkHotkeyClash)

const fMode = $<HTMLSelectElement>('f-mode')
const fContinuous = $<HTMLInputElement>('f-continuous')
const fContextAwareness = $<HTMLInputElement>('f-context-awareness')
const fModel = $<HTMLSelectElement>('f-model')
const fLanguage = $<HTMLInputElement>('f-language')
const fCleanupProvider = $<HTMLSelectElement>('f-cleanup-provider')
const fMinimaxKey = $<HTMLInputElement>('f-minimax-key')
const fMinimaxGroup = $<HTMLInputElement>('f-minimax-group')
const fGroqKey = $<HTMLInputElement>('f-groq-key')
const fGroqModel = $<HTMLSelectElement>('f-groq-model')
const fGroqModelFast = $<HTMLSelectElement>('f-groq-model-fast')
const minimaxKeyRow = $('minimax-key-row')
const minimaxGroupRow = $('minimax-group-row')
const groqKeyRow = $('groq-key-row')
const groqModelRow = $('groq-model-row')
const groqModelFastRow = $('groq-model-fast-row')
const fTranslateTarget = $<HTMLInputElement>('f-translate-target')
const translateTargetRow = $('translate-target-row')
const fSnippets = $<HTMLTextAreaElement>('f-snippets')
const fSessionTones = $<HTMLTextAreaElement>('f-session-tones')
/** Show only the active provider's credential rows. */
function applyProviderVisibility(): void {
  const groq = fCleanupProvider.value === 'groq'
  groqKeyRow.classList.toggle('hidden', !groq)
  groqModelRow.classList.toggle('hidden', !groq)
  groqModelFastRow.classList.toggle('hidden', !groq)
  minimaxKeyRow.classList.toggle('hidden', groq)
  minimaxGroupRow.classList.toggle('hidden', groq)
}

fCleanupProvider.addEventListener('change', applyProviderVisibility)

// ─── Auto Cleanup intensity (Normal mode) ───────────────────────────────────

const intensityOpts = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.seg-opt[data-intensity-opt]')
)
const intensityDesc = $('intensity-desc')
let selectedIntensity: CleanupIntensity = 'medium'

const INTENSITY_DESCRIPTIONS: Record<CleanupIntensity, string> = {
  none: 'Off — pastes the raw transcript verbatim, no AI pass.',
  light: 'Removes filler words and adds basic punctuation — every word stays as spoken.',
  medium: 'Full auto-edit: fillers, self-corrections, dictated punctuation, number/email formatting.',
  high: 'Medium plus restructuring: breaks up run-ons, formats spoken lists, fixes grammar.'
}

function selectIntensity(level: CleanupIntensity): void {
  selectedIntensity = level
  for (const opt of intensityOpts) {
    opt.classList.toggle('active', opt.dataset.intensityOpt === level)
  }
  intensityDesc.textContent = INTENSITY_DESCRIPTIONS[level]
  // Home cleanup chip mirrors the current intensity.
  $('home-cleanup-level').textContent = level.charAt(0).toUpperCase() + level.slice(1)
}

for (const opt of intensityOpts) {
  opt.addEventListener('click', () => selectIntensity(opt.dataset.intensityOpt as CleanupIntensity))
}

// "Test & compare": time both providers (uses saved keys) and show the result.
$('btn-compare').addEventListener('click', async () => {
  const result = $('compare-result')
  result.textContent = 'testing both providers…'
  try {
    const timings = await window.owenflow.cleanup.benchmark()
    result.textContent = timings
      .map((t) => `${t.provider}: ${t.ok ? `${(t.ms / 1000).toFixed(1)}s` : t.error}`)
      .join('  ·  ')
  } catch {
    result.textContent = 'compare failed'
  }
})

const fDictionary = $<HTMLTextAreaElement>('f-dictionary')
const fStartup = $<HTMLInputElement>('f-startup')
const fDigestEnabled = $<HTMLInputElement>('f-digest-enabled')
const fDigestHour = $<HTMLInputElement>('f-digest-hour')
const fDigestThemes = $<HTMLInputElement>('f-digest-themes')
const fZealEndpoint = $<HTMLInputElement>('f-zeal-endpoint')
const fZealKey = $<HTMLInputElement>('f-zeal-key')
const fZealSpeak = $<HTMLInputElement>('f-zeal-speak')
const saveStatus = $('save-status')

// ─── App profiles ────────────────────────────────────────────────────────────

const fAppProfilesEnabled = $<HTMLInputElement>('f-app-profiles-enabled')
const profilesList = $('profiles-list')

let profilesDraft: AppProfile[] = []

function renderProfiles(): void {
  profilesList.replaceChildren()
  profilesDraft.forEach((profile, idx) => {
    const card = document.createElement('div')
    card.className = 'card'
    card.style.marginBottom = '16px'

    // Card header with index label and delete button
    const header = document.createElement('div')
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:14px'
    const h2 = document.createElement('h2')
    h2.style.marginBottom = '0'
    h2.textContent = `Profile ${idx + 1}`
    const delBtn = document.createElement('button')
    delBtn.type = 'button'
    delBtn.className = 'danger'
    delBtn.textContent = 'Delete'
    delBtn.style.fontSize = '12px'
    delBtn.style.padding = '5px 12px'
    delBtn.addEventListener('click', () => {
      profilesDraft.splice(idx, 1)
      renderProfiles()
    })
    header.append(h2, delBtn)
    card.append(header)

    // Match row
    const matchRow = document.createElement('div')
    matchRow.className = 'row'
    const matchLabel = document.createElement('label')
    matchLabel.className = 'title'
    matchLabel.textContent = 'Match'
    const matchHint = document.createElement('span')
    matchHint.className = 'hint'
    matchHint.textContent = 'Comma-separated process names (no .exe), e.g. Code, Cursor'
    matchLabel.append(matchHint)
    const matchInput = document.createElement('input')
    matchInput.type = 'text'
    matchInput.spellcheck = false
    matchInput.placeholder = 'Code, Cursor'
    matchInput.value = profile.match.join(', ')
    matchInput.addEventListener('input', () => {
      profile.match = matchInput.value.split(',').map((s) => s.trim()).filter(Boolean)
    })
    matchRow.append(matchLabel, matchInput)
    card.append(matchRow)

    // Flow mode row
    const modeRow = document.createElement('div')
    modeRow.className = 'row'
    const modeLabel = document.createElement('label')
    modeLabel.className = 'title'
    modeLabel.textContent = 'Flow mode'
    const modeHint = document.createElement('span')
    modeHint.className = 'hint'
    modeHint.textContent = 'Override flow mode for this app; inherit = use global setting'
    modeLabel.append(modeHint)
    const modeSelect = document.createElement('select')
    ;[['', 'inherit (global)'], ['normal', 'normal'], ['vibe', 'vibe'], ['formal', 'formal'], ['translate', 'translate']].forEach(([val, label]) => {
      const opt = document.createElement('option')
      opt.value = val
      opt.textContent = label
      modeSelect.append(opt)
    })
    modeSelect.value = profile.flowMode ?? ''
    modeSelect.addEventListener('change', () => {
      profile.flowMode = (modeSelect.value as FlowMode) || undefined
    })
    modeRow.append(modeLabel, modeSelect)
    card.append(modeRow)

    // Strip trailing period checkbox row
    const stripRow = document.createElement('div')
    stripRow.className = 'row'
    const stripLabel = document.createElement('label')
    stripLabel.className = 'title'
    stripLabel.setAttribute('for', `p${idx}-strip`)
    stripLabel.textContent = 'Strip trailing period'
    const stripHint = document.createElement('span')
    stripHint.className = 'hint'
    stripHint.textContent = 'Remove the final "." from output (useful in code/chat apps)'
    stripLabel.append(stripHint)
    const stripCheck = document.createElement('input')
    stripCheck.type = 'checkbox'
    stripCheck.id = `p${idx}-strip`
    stripCheck.checked = profile.stripTrailingPeriod ?? false
    stripCheck.addEventListener('change', () => {
      profile.stripTrailingPeriod = stripCheck.checked || undefined
    })
    stripRow.append(stripLabel, stripCheck)
    card.append(stripRow)

    // No auto-capitalize checkbox row
    const capRow = document.createElement('div')
    capRow.className = 'row'
    const capLabel = document.createElement('label')
    capLabel.className = 'title'
    capLabel.setAttribute('for', `p${idx}-cap`)
    capLabel.textContent = 'No auto-capitalize'
    const capHint = document.createElement('span')
    capHint.className = 'hint'
    capHint.textContent = 'Keep the first letter lowercase (e.g. for code identifiers)'
    capLabel.append(capHint)
    const capCheck = document.createElement('input')
    capCheck.type = 'checkbox'
    capCheck.id = `p${idx}-cap`
    capCheck.checked = profile.noAutoCapitalize ?? false
    capCheck.addEventListener('change', () => {
      profile.noAutoCapitalize = capCheck.checked || undefined
    })
    capRow.append(capLabel, capCheck)
    card.append(capRow)

    // Single line checkbox row
    const slRow = document.createElement('div')
    slRow.className = 'row'
    const slLabel = document.createElement('label')
    slLabel.className = 'title'
    slLabel.setAttribute('for', `p${idx}-sl`)
    slLabel.textContent = 'Single line'
    const slHint = document.createElement('span')
    slHint.className = 'hint'
    slHint.textContent = 'Collapse newlines to spaces (useful for single-line inputs)'
    slLabel.append(slHint)
    const slCheck = document.createElement('input')
    slCheck.type = 'checkbox'
    slCheck.id = `p${idx}-sl`
    slCheck.checked = profile.singleLine ?? false
    slCheck.addEventListener('change', () => {
      profile.singleLine = slCheck.checked || undefined
    })
    slRow.append(slLabel, slCheck)
    card.append(slRow)

    // Prompt rule row
    const prRow = document.createElement('div')
    prRow.className = 'row'
    const prLabel = document.createElement('label')
    prLabel.className = 'title'
    prLabel.setAttribute('for', `p${idx}-pr`)
    prLabel.textContent = 'Prompt rule'
    const prHint = document.createElement('span')
    prHint.className = 'hint'
    prHint.textContent = 'Extra instruction appended to the cleanup system prompt'
    prLabel.append(prHint)
    const prInput = document.createElement('input')
    prInput.type = 'text'
    prInput.id = `p${idx}-pr`
    prInput.spellcheck = false
    prInput.placeholder = 'e.g. Use imperative mood'
    prInput.value = profile.promptRule ?? ''
    prInput.addEventListener('input', () => {
      profile.promptRule = prInput.value.trim() || undefined
    })
    prRow.append(prLabel, prInput)
    card.append(prRow)

    // Replacements row (textarea)
    const repRow = document.createElement('div')
    repRow.className = 'row'
    repRow.style.alignItems = 'flex-start'
    const repLabel = document.createElement('label')
    repLabel.className = 'title'
    repLabel.setAttribute('for', `p${idx}-rep`)
    repLabel.textContent = 'Replacements'
    const repHint = document.createElement('span')
    repHint.className = 'hint'
    repHint.textContent = 'One wrong=>right per line, applied after global dictionary'
    repLabel.append(repHint)
    const repArea = document.createElement('textarea')
    repArea.id = `p${idx}-rep`
    repArea.spellcheck = false
    repArea.placeholder = 'fn=>function\nconst=>let'
    repArea.style.minHeight = '72px'
    repArea.value = (profile.replacements ?? []).join('\n')
    repArea.addEventListener('input', () => {
      const lines = repArea.value.split('\n').map((l) => l.trim()).filter(Boolean)
      profile.replacements = lines.length ? lines : undefined
    })
    repRow.append(repLabel, repArea)
    card.append(repRow)

    profilesList.append(card)
  })
}

$('btn-add-profile').addEventListener('click', () => {
  profilesDraft.push({ match: [] })
  renderProfiles()
})

$('btn-detect-app').addEventListener('click', async () => {
  const detectResult = $('detect-result')
  detectResult.textContent = 'detecting…'
  try {
    const name = await window.owenflow.apps.detect()
    detectResult.textContent = name ? name : 'no app detected'
  } catch {
    detectResult.textContent = 'detection failed'
  }
})

// ─── Mode cards ─────────────────────────────────────────────────────────────

const modeCards = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.mode-card[data-flow-mode]')
)
let selectedFlowMode: FlowMode = 'normal'

function selectFlowMode(mode: FlowMode): void {
  selectedFlowMode = mode
  for (const card of modeCards) {
    card.classList.toggle('selected', card.dataset.flowMode === mode)
  }
  translateTargetRow.classList.toggle('hidden', mode !== 'translate')
  updateHomeChips(mode)
}

for (const card of modeCards) {
  card.addEventListener('click', () => selectFlowMode(card.dataset.flowMode as FlowMode))
}

function fillForm(s: OwenFlowSettings): void {
  fHotkey.value = s.hotkey
  fMode.value = s.mode
  fContinuous.checked = s.continuousMode
  fContextAwareness.checked = s.contextAwareness
  fModel.value = s.model
  fLanguage.value = s.language
  // Settings predating cleanupIntensity map the legacy toggle: on → medium, off → none.
  selectIntensity(s.cleanupIntensity ?? (s.cleanupEnabled ? 'medium' : 'none'))
  fCleanupProvider.value = s.cleanupProvider ?? 'groq'
  fMinimaxKey.value = s.minimaxApiKey
  fMinimaxGroup.value = s.minimaxGroupId
  fGroqKey.value = s.groqApiKey
  fGroqModel.value = s.groqModel || 'llama-3.3-70b-versatile'
  fGroqModelFast.value = s.groqModelFast || 'llama-3.1-8b-instant'
  applyProviderVisibility()
  fDictionary.value = s.dictionary.join('\n')
  fTranslateTarget.value = s.translateTarget || 'English'
  fSnippets.value = s.snippets.join('\n')
  fSessionTones.value = s.sessionTones.join('\n')
  fStartup.checked = s.launchOnStartup
  fDigestEnabled.checked = s.digestEnabled
  fDigestHour.value = String(s.digestHour ?? 18)
  fDigestThemes.checked = s.digestThemes
  fAppProfilesEnabled.checked = s.appProfilesEnabled
  profilesDraft = structuredClone(s.profiles ?? [])
  renderProfiles()
  fCommandEnabled.checked = s.commandEnabled
  fCommandHotkey.value = s.commandHotkey
  fModeHotkey.value = s.modeHotkey
  checkHotkeyClash()
  fZealEndpoint.value = s.zealEndpoint
  fZealKey.value = s.zealApiKey
  fZealSpeak.checked = s.zealSpeakReplies
  selectFlowMode(s.flowMode ?? 'normal')
  selectTheme(s.theme ?? 'dark')
  updateHomeHint(s.hotkey, s.mode)
}

function readForm(): Partial<OwenFlowSettings> {
  return {
    hotkey: fHotkey.value.trim() || 'RightCtrl',
    mode: fMode.value === 'toggle' ? 'toggle' : 'hold',
    continuousMode: fContinuous.checked,
    contextAwareness: fContextAwareness.checked,
    flowMode: selectedFlowMode,
    model: fModel.value as OwenFlowSettings['model'],
    language: fLanguage.value.trim(),
    cleanupIntensity: selectedIntensity,
    // Legacy master toggle kept in sync so older readers keep working.
    cleanupEnabled: selectedIntensity !== 'none',
    cleanupProvider: fCleanupProvider.value === 'minimax' ? 'minimax' : 'groq',
    minimaxApiKey: fMinimaxKey.value.trim(),
    minimaxGroupId: fMinimaxGroup.value.trim(),
    groqApiKey: fGroqKey.value.trim(),
    groqModel: fGroqModel.value,
    groqModelFast: fGroqModelFast.value,
    dictionary: fDictionary.value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    translateTarget: fTranslateTarget.value.trim() || 'English',
    snippets: fSnippets.value.split('\n').map((l) => l.trim()).filter(Boolean),
    sessionTones: fSessionTones.value.split('\n').map((l) => l.trim()).filter(Boolean),
    launchOnStartup: fStartup.checked,
    digestEnabled: fDigestEnabled.checked,
    digestHour: Math.min(23, Math.max(0, Number(fDigestHour.value) || 18)),
    digestThemes: fDigestThemes.checked,
    theme: selectedTheme,
    appProfilesEnabled: fAppProfilesEnabled.checked,
    profiles: profilesDraft,
    commandEnabled: fCommandEnabled.checked,
    commandHotkey: fCommandHotkey.value.trim() || 'RightAlt',
    // No fallback on purpose: an emptied field means "mode hotkey off".
    modeHotkey: fModeHotkey.value.trim(),
    zealEndpoint: fZealEndpoint.value.trim(),
    zealApiKey: fZealKey.value.trim(),
    zealSpeakReplies: fZealSpeak.checked,
  }
}

let statusTimer: ReturnType<typeof setTimeout> | undefined

$('btn-save').addEventListener('click', async () => {
  const next = await window.owenflow.settings.set(readForm())
  fillForm(next)
  saveStatus.classList.add('show')
  clearTimeout(statusTimer)
  statusTimer = setTimeout(() => saveStatus.classList.remove('show'), 1800)
})

// Hidden-ish debug affordance: drives the stub pipeline so the pill is testable.
$('btn-test').addEventListener('click', () => {
  void window.owenflow.debug.simulateDictation()
})

// ─── History ────────────────────────────────────────────────────────────────

const historyList = $('history-list')
const historyCount = $('history-count')
const tagFilter = $<HTMLSelectElement>('tag-filter')
const activeFilter = $('active-filter')
const activeFilterName = $('active-filter-name')

/** Currently active tag filter ('' = show all). */
let filterTag = ''

/** All known tags (refreshed with the filter dropdown) — feeds suggestions. */
let knownTags: string[] = []

function setFilter(tag: string): void {
  filterTag = tag
  tagFilter.value = tag
  activeFilterName.textContent = tag ? `#${tag}` : ''
  activeFilter.classList.toggle('show', !!tag)
  void refreshHistory()
}

tagFilter.addEventListener('change', () => setFilter(tagFilter.value))
$('btn-clear-filter').addEventListener('click', () => setFilter(''))

async function refreshTagFilter(): Promise<void> {
  const tags = await window.owenflow.history.tags()
  knownTags = tags.map((t) => t.tag)
  tagFilter.replaceChildren()
  const all = document.createElement('option')
  all.value = ''
  all.textContent = 'all tags'
  tagFilter.append(all)
  for (const { tag, count } of tags) {
    const opt = document.createElement('option')
    opt.value = tag
    opt.textContent = `#${tag} (${count})`
    tagFilter.append(opt)
  }
  // Keep the active filter selected if it still exists; otherwise drop it.
  if (filterTag && !tags.some((t) => t.tag === filterTag)) {
    filterTag = ''
    activeFilter.classList.remove('show')
  }
  tagFilter.value = filterTag
}

// ─── Folders ────────────────────────────────────────────────────────────────

const folderRail = $('folder-rail')

/** Currently active folder filter ('' = All, shows everything incl. unfiled). */
let filterFolder = ''

/** Folders that exist through entries (from main), alphabetical. */
let knownFolders: FolderCount[] = []

/**
 * Folders the user created that have no entries yet. Folders are implicit
 * (no registry file), so an empty one lives only in this transient list until
 * its first entry is assigned — then it shows up in knownFolders instead.
 */
let transientFolders: string[] = []

/** Canonical renderer-side folder form (main normalizes again on write). */
function normalizeFolderName(raw: string): string {
  return raw.trim().slice(0, 40).trim()
}

/** All folder names (real + transient), alphabetical. */
function allFolderNames(): string[] {
  const names = knownFolders.map((f) => f.folder)
  for (const t of transientFolders) {
    if (!names.some((n) => n.toLowerCase() === t.toLowerCase())) names.push(t)
  }
  return names.sort((a, b) => a.localeCompare(b))
}

/** Existing folder matching `name` case-insensitively (prevents dupes by case). */
function canonicalFolder(name: string): string | undefined {
  return allFolderNames().find((n) => n.toLowerCase() === name.toLowerCase())
}

function setFolderFilter(name: string): void {
  filterFolder = name
  void refreshHistory()
}

/** Re-pull folder counts from main and re-render the rail (list untouched). */
async function refreshFolderRail(): Promise<void> {
  knownFolders = await window.owenflow.history.folders()
  // A transient folder becomes real once its first entry lands.
  transientFolders = transientFolders.filter(
    (t) => !knownFolders.some((f) => f.folder.toLowerCase() === t.toLowerCase())
  )
  // Active filter's folder vanished (last entry left, or deleted) → back to All.
  if (filterFolder && !canonicalFolder(filterFolder)) filterFolder = ''
  renderFolderRail()
}

function closeFolderMenus(): void {
  for (const menu of Array.from(document.querySelectorAll('.folder-menu'))) menu.remove()
}

document.addEventListener('mousedown', (e) => {
  if (!(e.target instanceof Element) || !e.target.closest('.folder-menu')) closeFolderMenus()
})

function openFolderMenu(chip: HTMLElement, name: string): void {
  closeFolderMenus()
  const menu = document.createElement('div')
  menu.className = 'folder-menu'

  const rename = document.createElement('div')
  rename.className = 'item'
  rename.textContent = 'Rename'
  rename.addEventListener('click', (e) => {
    e.stopPropagation() // keep the chip's own click (filter) from firing
    closeFolderMenus()
    startFolderRename(chip, name)
  })

  const del = document.createElement('div')
  del.className = 'item danger'
  del.textContent = 'Delete'
  del.addEventListener('click', async (e) => {
    e.stopPropagation() // keep the chip's own click (filter) from firing
    closeFolderMenus()
    if (!confirm(`Delete folder "${name}"? Its dictations become unfiled.`)) return
    transientFolders = transientFolders.filter((t) => t !== name)
    await window.owenflow.history.deleteFolder(name)
    if (filterFolder === name) filterFolder = ''
    await refreshHistory()
  })

  menu.append(rename, del)
  chip.append(menu)
}

/** Swap a folder chip for an inline rename input. */
function startFolderRename(chip: HTMLElement, name: string): void {
  const input = document.createElement('input')
  input.className = 'folder-input'
  input.value = name
  input.spellcheck = false
  chip.replaceWith(input)
  input.focus()
  input.select()

  let done = false
  const cancel = (): void => {
    if (done) return
    done = true
    renderFolderRail()
  }
  const commit = async (): Promise<void> => {
    if (done) return
    const to = normalizeFolderName(input.value)
    const existing = to ? canonicalFolder(to) : undefined
    // Block empty names and dupes (incl. case-only collisions with OTHER
    // folders); allow re-casing the folder itself.
    if (!to || to === name || (existing && existing.toLowerCase() !== name.toLowerCase())) {
      cancel()
      return
    }
    done = true
    if (transientFolders.includes(name)) {
      transientFolders = transientFolders.map((t) => (t === name ? to : t))
    } else {
      await window.owenflow.history.renameFolder(name, to)
    }
    if (filterFolder === name) filterFolder = to
    await refreshHistory()
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void commit()
    else if (e.key === 'Escape') cancel()
  })
  input.addEventListener('blur', () => void commit())
}

function renderFolderChip(name: string, count: number): HTMLElement {
  const chip = document.createElement('span')
  chip.className = 'folder-chip' + (filterFolder === name ? ' active' : '')
  chip.title = `Show only 📁 ${name}`

  const label = document.createElement('span')
  label.textContent = `📁 ${name}`

  const cnt = document.createElement('span')
  cnt.className = 'count'
  cnt.textContent = String(count)

  const menuBtn = document.createElement('span')
  menuBtn.className = 'menu-btn'
  menuBtn.textContent = '⋯'
  menuBtn.title = 'Rename / delete folder'
  menuBtn.addEventListener('mousedown', (e) => e.stopPropagation())
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    openFolderMenu(chip, name)
  })

  chip.addEventListener('click', () => setFolderFilter(name))
  chip.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    openFolderMenu(chip, name)
  })

  chip.append(label, cnt, menuBtn)
  return chip
}

function renderFolderRail(): void {
  folderRail.replaceChildren()

  const all = document.createElement('span')
  all.className = 'folder-chip' + (filterFolder ? '' : ' active')
  all.textContent = 'All'
  all.title = 'Show everything, including unfiled'
  all.addEventListener('click', () => setFolderFilter(''))
  folderRail.append(all)

  const counts = new Map(knownFolders.map((f) => [f.folder, f.count]))
  for (const name of allFolderNames()) {
    folderRail.append(renderFolderChip(name, counts.get(name) ?? 0))
  }

  const add = document.createElement('button')
  add.className = 'folder-new'
  add.textContent = '+ new folder'
  add.addEventListener('click', () => {
    const input = document.createElement('input')
    input.className = 'folder-input'
    input.placeholder = 'folder name'
    input.spellcheck = false
    add.replaceWith(input)
    input.focus()

    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      const name = normalizeFolderName(input.value)
      if (name) {
        const existing = canonicalFolder(name)
        if (!existing) transientFolders.push(name)
        // Jump straight into the (possibly pre-existing) folder so the user
        // can immediately assign entries to it.
        filterFolder = existing ?? name
      }
      void refreshHistory()
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish()
      else if (e.key === 'Escape') {
        done = true
        renderFolderRail()
      }
    })
    input.addEventListener('blur', finish)
  })
  folderRail.append(add)
}

/** Sentinel select value for the per-entry "New folder…" option. */
const NEW_FOLDER = '\u0000new-folder'

/** Per-entry 📁 dropdown: move to a folder / new folder / remove from folder. */
function renderFolderControl(entry: HistoryEntry): HTMLElement {
  const holder = document.createElement('span')

  // Persist + re-render only this control — no full-list reload (same
  // in-place pattern as the tag strip). Full refresh only when the active
  // folder filter no longer matches (entry must drop out of the list).
  const save = async (folder: string | null): Promise<void> => {
    await window.owenflow.history.setFolder(entry.ts, folder)
    entry.folder = folder ?? undefined
    if (filterFolder && entry.folder !== filterFolder) {
      await refreshHistory()
      return
    }
    await refreshFolderRail() // keep chip counts current
    holder.replaceWith(renderFolderControl(entry))
  }

  const select = document.createElement('select')
  select.className = 'folder-select'
  select.title = 'Move to folder'

  const none = document.createElement('option')
  none.value = ''
  none.textContent = entry.folder ? '✕ remove from folder' : '📁 no folder'
  select.append(none)
  for (const name of allFolderNames()) {
    const opt = document.createElement('option')
    opt.value = name
    opt.textContent = `📁 ${name}`
    select.append(opt)
  }
  const create = document.createElement('option')
  create.value = NEW_FOLDER
  create.textContent = '+ new folder…'
  select.append(create)
  select.value = entry.folder ?? ''

  select.addEventListener('change', () => {
    if (select.value !== NEW_FOLDER) {
      void save(select.value || null)
      return
    }
    // Inline "New folder…": swap the select for a text input.
    const input = document.createElement('input')
    input.className = 'folder-input'
    input.placeholder = 'folder name'
    input.spellcheck = false
    select.replaceWith(input)
    input.focus()

    let done = false
    const cancel = (): void => {
      if (done) return
      done = true
      holder.replaceWith(renderFolderControl(entry))
    }
    const commit = (): void => {
      if (done) return
      const name = normalizeFolderName(input.value)
      if (!name) {
        cancel()
        return
      }
      done = true
      // Reuse an existing folder when the name differs only by case.
      void save(canonicalFolder(name) ?? name)
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit()
      else if (e.key === 'Escape') cancel()
    })
    input.addEventListener('blur', commit)
  })

  holder.append(select)
  return holder
}

/** Canonical renderer-side tag form (main normalizes again on write). */
function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-')
}

function renderTags(entry: HistoryEntry): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'tags'

  // Persist + re-render only this entry's tag strip — no full-list reload, so
  // there is no flicker. Full refresh only when the active filter no longer
  // matches this entry (it must drop out of the list).
  const save = async (tags: string[]): Promise<void> => {
    await window.owenflow.history.updateTags(entry.ts, tags)
    entry.tags = tags
    if (filterTag && !tags.includes(filterTag)) {
      await refreshHistory()
      return
    }
    wrap.replaceWith(renderTags(entry))
    void refreshTagFilter() // keep dropdown counts + suggestions current
  }

  for (const tag of entry.tags) {
    const chip = document.createElement('span')
    chip.className = 'tag-chip'
    chip.dataset.tag = tag // lets CSS mark special tags (e.g. 'meeting')
    chip.title = `Filter by #${tag}`

    const name = document.createElement('span')
    name.textContent = `#${tag}`
    name.addEventListener('click', () => setFilter(tag))

    const x = document.createElement('span')
    x.className = 'x'
    x.textContent = '✕'
    x.title = `Remove #${tag}`
    x.addEventListener('click', (e) => {
      e.stopPropagation()
      void save(entry.tags.filter((t) => t !== tag))
    })

    chip.append(name, x)
    wrap.append(chip)
  }

  const add = document.createElement('button')
  add.className = 'tag-add'
  add.textContent = '+ tag'
  add.addEventListener('click', () => {
    const editor = document.createElement('span')
    editor.className = 'tag-editor'

    const input = document.createElement('input')
    input.className = 'tag-input'
    input.placeholder = 'new-tag'
    input.spellcheck = false

    const suggest = document.createElement('div')
    suggest.className = 'tag-suggest'
    let highlighted = -1

    editor.append(input, suggest)
    add.replaceWith(editor)
    input.focus()

    // Guard: Enter triggers commit AND the resulting DOM swap fires blur —
    // without this flag the same tag would be committed twice.
    let done = false
    const close = (): void => {
      if (done) return
      done = true
      editor.replaceWith(add)
    }
    const commit = (raw: string): void => {
      if (done) return
      const tag = normalizeTag(raw)
      if (tag && !entry.tags.includes(tag)) {
        done = true
        void save([...entry.tags, tag])
      } else {
        close()
      }
    }

    const suggestions = (): string[] => {
      const q = normalizeTag(input.value)
      return knownTags.filter((t) => !entry.tags.includes(t) && (!q || t.includes(q))).slice(0, 6)
    }

    const renderSuggest = (): void => {
      const items = suggestions()
      highlighted = Math.min(highlighted, items.length - 1)
      suggest.replaceChildren()
      suggest.classList.toggle('show', items.length > 0)
      items.forEach((tag, i) => {
        const item = document.createElement('div')
        item.className = 'item' + (i === highlighted ? ' hl' : '')
        item.textContent = `#${tag}`
        // mousedown (not click) so it wins the race against the input's blur
        item.addEventListener('mousedown', (e) => {
          e.preventDefault()
          commit(tag)
        })
        suggest.append(item)
      })
    }

    input.addEventListener('input', () => {
      highlighted = -1
      renderSuggest()
    })
    input.addEventListener('keydown', (e) => {
      const items = suggestions()
      if (e.key === 'ArrowDown' && items.length) {
        e.preventDefault()
        highlighted = (highlighted + 1) % items.length
        renderSuggest()
      } else if (e.key === 'ArrowUp' && items.length) {
        e.preventDefault()
        highlighted = (highlighted - 1 + items.length) % items.length
        renderSuggest()
      } else if (e.key === 'Enter') {
        commit(highlighted >= 0 && items[highlighted] ? items[highlighted] : input.value)
      } else if (e.key === 'Escape') {
        close()
      }
    })
    input.addEventListener('blur', () => commit(input.value))
    renderSuggest()
  })
  wrap.append(add)

  return wrap
}

function formatTs(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function renderEntry(entry: HistoryEntry): HTMLElement {
  const el = document.createElement('div')
  el.className = 'entry'

  const body = document.createElement('div')
  body.className = 'body'

  const ts = document.createElement('div')
  ts.className = 'ts'
  const tsText = document.createElement('span')
  tsText.textContent =
    `${formatTs(entry.ts)} · ${(entry.durationMs / 1000).toFixed(1)}s` +
    (entry.mode ? ` · ${entry.mode}` : '')
  ts.append(tsText, renderFolderControl(entry))

  const text = document.createElement('div')
  text.className = 'text'
  text.textContent = entry.final

  body.append(ts, text, renderTags(entry))

  // navigator.clipboard is undefined in the packaged file:// context
  // (not a secure context) — copy through main via IPC instead.
  const makeCopyButton = (label: string, getText: () => string): HTMLButtonElement => {
    const btn = document.createElement('button')
    btn.className = 'copy'
    btn.textContent = label
    btn.addEventListener('click', async () => {
      let ok = false
      try {
        ok = await window.owenflow.clipboard.write(getText())
      } catch {
        ok = false
      }
      btn.textContent = ok ? 'Copied ✓' : 'Copy failed'
      btn.classList.toggle('failed', !ok)
      setTimeout(() => {
        btn.textContent = label
        btn.classList.remove('failed')
      }, 1200)
    })
    return btn
  }

  const copyWrap = document.createElement('div')
  copyWrap.className = 'copy-group'
  copyWrap.append(
    makeCopyButton('Copy Formatted', () => entry.final),
    makeCopyButton('Copy Raw', () => entry.raw)
  )

  // ── Edit / Learn ───────────────────────────────────────────────────────────
  const editBtn = document.createElement('button')
  editBtn.className = 'ghost'
  editBtn.textContent = 'Edit'
  editBtn.style.marginLeft = '6px'

  // Container that shows either the read-only text or the edit UI.
  // We mutate `text` in-place rather than swapping it out of the DOM so that
  // the entry layout stays stable.
  editBtn.addEventListener('click', () => {
    // Swap text div for a textarea.
    const textarea = document.createElement('textarea')
    textarea.value = entry.final
    textarea.spellcheck = true
    textarea.style.cssText =
      'width:100%;min-height:72px;resize:vertical;font:inherit;margin-top:6px'
    text.replaceWith(textarea)
    textarea.focus()

    // Proposals panel (hidden until Learn is clicked).
    const proposalsWrap = document.createElement('div')
    proposalsWrap.style.marginTop = '8px'

    // Action buttons: Learn + Cancel.
    const learnBtn = document.createElement('button')
    learnBtn.className = 'copy'
    learnBtn.textContent = 'Learn'

    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'ghost'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.style.marginLeft = '6px'

    const editActions = document.createElement('div')
    editActions.style.cssText = 'display:flex;align-items:center;margin-top:6px'
    editActions.append(learnBtn, cancelBtn)

    body.append(editActions, proposalsWrap)

    const restoreReadOnly = (): void => {
      textarea.replaceWith(text)
      editActions.remove()
      proposalsWrap.remove()
    }

    cancelBtn.addEventListener('click', restoreReadOnly)

    learnBtn.addEventListener('click', async () => {
      const corrected = textarea.value.trim()
      learnBtn.disabled = true
      learnBtn.textContent = 'Analyzing…'
      proposalsWrap.replaceChildren()

      let proposals: string[]
      try {
        proposals = await window.owenflow.learn.propose(entry.raw, corrected)
      } catch {
        proposals = []
      }

      learnBtn.disabled = false
      learnBtn.textContent = 'Learn'

      if (proposals.length === 0) {
        const note = document.createElement('span')
        note.className = 'hint'
        note.textContent = 'No clear correction to learn.'
        proposalsWrap.append(note)
        return
      }

      const dismissBtn = document.createElement('button')
      dismissBtn.className = 'ghost'
      dismissBtn.textContent = 'Dismiss'
      dismissBtn.style.cssText = 'margin-top:8px;font-size:11px'
      dismissBtn.addEventListener('click', () => proposalsWrap.replaceChildren())

      for (const proposal of proposals) {
        const row = document.createElement('div')
        row.style.cssText =
          'display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px'

        const label = document.createElement('code')
        label.textContent = proposal
        label.style.cssText =
          'flex:1;background:var(--panel-2);padding:3px 7px;border-radius:6px;font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap'

        const addBtn = document.createElement('button')
        addBtn.className = 'copy'
        addBtn.textContent = 'Add'
        addBtn.style.cssText = 'padding:4px 10px;font-size:11px'

        addBtn.addEventListener('click', async () => {
          const settings = await window.owenflow.settings.get()
          const lower = proposal.toLowerCase()
          const already = settings.dictionary.some((d) => d.toLowerCase() === lower)
          if (!already) {
            const nextDict = [...settings.dictionary, proposal]
            await window.owenflow.settings.set({ dictionary: nextDict })
          }
          addBtn.textContent = 'Added ✓'
          addBtn.disabled = true
        })

        row.append(label, addBtn)
        proposalsWrap.append(row)
      }

      proposalsWrap.append(dismissBtn)
    })
  })

  copyWrap.append(editBtn)

  el.append(body, copyWrap)
  return el
}

async function refreshHistory(): Promise<void> {
  const [all] = await Promise.all([
    window.owenflow.history.list(200),
    refreshTagFilter(),
    refreshFolderRail()
  ])
  // Tag filter + folder filter combine as AND.
  let entries = filterTag ? all.filter((e) => e.tags.includes(filterTag)) : all
  if (filterFolder) entries = entries.filter((e) => e.folder === filterFolder)
  historyList.replaceChildren()
  const filterSuffix =
    (filterTag ? ` · #${filterTag}` : '') + (filterFolder ? ` · 📁 ${filterFolder}` : '')
  historyCount.textContent = entries.length
    ? `${entries.length} dictation${entries.length === 1 ? '' : 's'}${filterSuffix}`
    : ''
  if (entries.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent =
      filterTag || filterFolder
        ? `No dictations${filterTag ? ` tagged #${filterTag}` : ''}${filterFolder ? ` in 📁 ${filterFolder}` : ''}.`
        : 'No dictations yet. Hold the hotkey and speak.'
    historyList.append(empty)
    return
  }
  for (const entry of entries) historyList.append(renderEntry(entry))
}

$('btn-clear').addEventListener('click', async () => {
  await window.owenflow.history.clear()
  await refreshHistory()
})

// ─── Meetings ───────────────────────────────────────────────────────────────
// Meeting recordings are a separate store from dictation history: their own
// nav section, their own cards (MEETING badge, Recorded + Updated dates) and
// a per-meeting detail view with the conversation transcript.

const meetingsListView = $('meetings-list-view')
const meetingsList = $('meetings-list')
const meetingDetail = $('meeting-detail')
const meetingToggleBtn = $<HTMLButtonElement>('btn-meeting-toggle')
const mtgAutodetect = $<HTMLInputElement>('mtg-autodetect')
const homeMeetingPill = $('home-meeting-pill')
const homeMeetingElapsed = $('home-meeting-elapsed')

let meetingState: MeetingStateInfo = { active: false, startedAt: null }
/** Meeting id currently open in the detail view (null = list view). */
let openMeetingId: string | null = null
let meetingTicker: ReturnType<typeof setInterval> | undefined

/** "Friday, July 5 · 2:04 PM" — friendly card/detail title. */
function meetingTitle(startedAt: number): string {
  const d = new Date(startedAt)
  const day = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day} · ${time}`
}

/** Custom title when set (meetings.rename), else the friendly recorded date. */
function meetingDisplayTitle(meta: MeetingMeta): string {
  return meta.title?.trim() || meetingTitle(meta.startedAt)
}

/** "Jul 5, 02:04 PM" — the full Recorded date+time for the meta line. */
function meetingDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** "0:42", "12:05", "1:02:03" — duration/elapsed from milliseconds. */
function formatMeetingDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** HH:mm timestamp for a transcript turn. */
function turnTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * "just now" / "2h ago" for the Updated marker; null when there is nothing
 * meaningfully newer than the recording itself (within a minute of start).
 */
function meetingUpdatedLabel(meta: MeetingMeta): string | null {
  if (meta.updatedAt == null) return null
  if (Math.abs(meta.updatedAt - meta.startedAt) < 60_000) return null
  const rel = relativeTime(meta.updatedAt)
  return rel === 'now' ? 'just now' : `${rel} ago`
}

/** "Recorded <dt> · <duration> · <n> words · Updated <rel>" with bold labels. */
function meetingMetaLine(meta: MeetingMeta): HTMLElement {
  const line = document.createElement('div')
  line.className = 'mc-meta'
  const addPart = (label: string | null, value: string): void => {
    if (line.childNodes.length > 0) line.append(' · ')
    if (label) {
      const b = document.createElement('b')
      b.textContent = label
      line.append(b, ' ')
    }
    line.append(value)
  }
  addPart('Recorded', meetingDateTime(meta.startedAt))
  if (meta.durationMs != null) addPart(null, formatMeetingDuration(meta.durationMs))
  if (meta.words != null) addPart(null, `${meta.words.toLocaleString()} words`)
  const updated = meetingUpdatedLabel(meta)
  if (updated) addPart('Updated', updated)
  return line
}

function meetingChip(): HTMLElement {
  const chip = document.createElement('span')
  chip.className = 'meeting-chip'
  chip.textContent = 'Meeting'
  return chip
}

/** The red header button flips Start meeting ↔ End meeting with the state. */
function renderMeetingControls(): void {
  meetingToggleBtn.innerHTML = meetingState.active
    ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>'
    : '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="7"/></svg>'
  meetingToggleBtn.append(meetingState.active ? 'End meeting' : 'Start meeting')
  meetingToggleBtn.title = meetingState.active
    ? 'Stop recording this meeting'
    : 'Record mic + system audio as a meeting transcript'
}

/** Home greeting pill: visible only while a meeting is recording. */
function renderHomeMeetingPill(): void {
  homeMeetingPill.classList.toggle('show', meetingState.active)
  if (meetingState.active && meetingState.startedAt != null) {
    homeMeetingElapsed.textContent = `Meeting recording — ${formatMeetingDuration(
      Date.now() - meetingState.startedAt
    )}`
  }
}

function tickMeetingElapsed(): void {
  if (!meetingState.active || meetingState.startedAt == null) return
  const label = formatMeetingDuration(Date.now() - meetingState.startedAt)
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('.meeting-elapsed'))) {
    el.textContent = label
  }
  renderHomeMeetingPill()
}

/**
 * The 1s elapsed ticker runs ONLY while a meeting is active AND a section
 * that shows the elapsed time (Meetings list, Home pill) is on a visible
 * window — no background timers otherwise.
 */
function syncMeetingTicker(): void {
  const want =
    meetingState.active &&
    !document.hidden &&
    (currentSection === 'meetings' || currentSection === 'home')
  if (want && meetingTicker === undefined) {
    tickMeetingElapsed()
    meetingTicker = setInterval(tickMeetingElapsed, 1000)
  } else if (!want && meetingTicker !== undefined) {
    clearInterval(meetingTicker)
    meetingTicker = undefined
  }
}

document.addEventListener('visibilitychange', syncMeetingTicker)

/** The pinned "Recording…" card shown above the list while a meeting runs. */
function renderLiveMeetingCard(): HTMLElement {
  const card = document.createElement('div')
  card.className = 'meeting-live'

  const dot = document.createElement('span')
  dot.className = 'rec-dot'

  const body = document.createElement('div')
  const title = document.createElement('div')
  title.className = 'ml-title'
  title.textContent = 'Recording…'
  const sub = document.createElement('div')
  sub.className = 'ml-sub'
  sub.textContent =
    meetingState.startedAt != null
      ? `Started ${new Date(meetingState.startedAt).toLocaleTimeString(undefined, {
          hour: 'numeric',
          minute: '2-digit'
        })} — transcribing as you go`
      : 'Transcribing as you go'
  body.append(title, sub)

  const time = document.createElement('span')
  time.className = 'ml-time meeting-elapsed'
  time.textContent =
    meetingState.startedAt != null
      ? formatMeetingDuration(Date.now() - meetingState.startedAt)
      : '0:00'

  card.append(dot, body, time)
  return card
}

function renderMeetingCard(meta: MeetingMeta): HTMLElement {
  const card = document.createElement('button')
  card.type = 'button'
  card.className = 'meeting-card'
  card.title = 'Open transcript'

  const top = document.createElement('div')
  top.className = 'mc-top'
  const title = document.createElement('div')
  title.className = 'mc-title'
  title.textContent = meetingDisplayTitle(meta)
  top.append(title, meetingChip())

  card.append(top, meetingMetaLine(meta))
  card.addEventListener('click', () => void openMeeting(meta.id))
  return card
}

/** Reload the list view: live card (when recording) + one card per meeting. */
async function refreshMeetings(): Promise<void> {
  const [stateResult, currentSettings] = await Promise.all([
    window.owenflow.meetings.state(),
    window.owenflow.settings.get()
  ])
  meetingState = stateResult
  mtgAutodetect.checked = currentSettings.meetingAutoDetect
  renderMeetingControls()
  renderHomeMeetingPill()
  syncMeetingTicker()

  const metas = await window.owenflow.meetings.list()
  // The running meeting is already listable (meta lands at start) — the live
  // card represents it, so keep its unfinished meta out of the cards.
  const finished = meetingState.active
    ? metas.filter((m) => !(m.endedAt == null && m.startedAt === meetingState.startedAt))
    : metas
  meetingsList.replaceChildren()
  if (meetingState.active) meetingsList.append(renderLiveMeetingCard())
  if (finished.length === 0) {
    if (meetingState.active) return
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent =
      'No meetings yet. Start one here (or tap the meeting hotkey) to record and transcribe both sides of a call.'
    meetingsList.append(empty)
    return
  }
  for (const meta of finished) meetingsList.append(renderMeetingCard(meta))
}

/** Grouped consecutive same-speaker entries → one conversation turn. */
interface MeetingTurn {
  speaker: MeetingEntry['speaker']
  t: number
  entries: MeetingEntry[]
}

function groupMeetingTurns(entries: MeetingEntry[]): MeetingTurn[] {
  const turns: MeetingTurn[] = []
  for (const entry of entries) {
    const last = turns[turns.length - 1]
    if (last && last.speaker === entry.speaker) last.entries.push(entry)
    else turns.push({ speaker: entry.speaker, t: entry.t, entries: [entry] })
  }
  return turns
}

/** Plain-text transcript for the clipboard: "You: …\nThem: …". */
function meetingTranscriptText(entries: MeetingEntry[]): string {
  return groupMeetingTurns(entries)
    .map((turn) => `${turn.speaker === 'you' ? 'You' : 'Them'}: ${turn.entries.map((e) => e.text).join(' ')}`)
    .join('\n')
}

/** Ghost action button with the History copy-button feedback pattern. */
function meetingActionButton(label: string, run: () => Promise<boolean>): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = 'ghost'
  btn.textContent = label
  btn.addEventListener('click', async () => {
    let ok = false
    try {
      ok = await run()
    } catch {
      ok = false
    }
    btn.textContent = ok ? 'Copied ✓' : 'Copy failed'
    setTimeout(() => (btn.textContent = label), 1200)
  })
  return btn
}

function renderMeetingDetail(meta: MeetingMeta, entries: MeetingEntry[], zealConfigured: boolean): void {
  meetingDetail.replaceChildren()

  const back = document.createElement('button')
  back.className = 'back-link'
  back.textContent = '← Meetings'
  back.addEventListener('click', () => closeMeetingDetail())

  const head = document.createElement('div')
  head.className = 'meeting-detail-head'
  const title = document.createElement('div')
  title.className = 'page-title mtg-title'
  title.textContent = meetingDisplayTitle(meta)
  title.title = 'Click to rename'

  // Click-to-rename: title swaps to an input; Enter/blur saves (blank clears
  // back to the friendly date), Escape cancels. Re-opens the meeting after a
  // save so meta (incl. the rename-bumped Updated stamp) re-renders fresh.
  title.addEventListener('click', () => {
    const input = document.createElement('input')
    input.className = 'mtg-title-input'
    input.value = meta.title?.trim() ?? ''
    input.placeholder = meetingTitle(meta.startedAt)
    head.replaceChild(input, title)
    input.focus()
    input.select()
    let settled = false
    const settle = (save: boolean): void => {
      if (settled) return
      settled = true
      if (!save) {
        head.replaceChild(title, input)
        return
      }
      void window.owenflow.meetings.rename(meta.id, input.value).then(() => openMeeting(meta.id))
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') settle(true)
      else if (e.key === 'Escape') settle(false)
    })
    // Escape's replaceChild also fires blur — the settled flag makes it a no-op.
    input.addEventListener('blur', () => settle(true))
  })

  head.append(title, meetingChip())

  const actions = document.createElement('div')
  actions.className = 'meeting-actions'

  // Transcript before actions so the copy buttons can close over it.
  const transcript = document.createElement('div')
  if (entries.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = 'No transcript segments were captured for this meeting.'
    transcript.append(empty)
  } else {
    for (const turn of groupMeetingTurns(entries)) {
      const el = document.createElement('div')
      el.className = 'turn' + (turn.speaker === 'you' ? ' you' : '')

      const headRow = document.createElement('div')
      headRow.className = 't-head'
      const speaker = document.createElement('span')
      speaker.className = 't-speaker'
      speaker.textContent = turn.speaker === 'you' ? 'You' : 'Them'
      const time = document.createElement('span')
      time.className = 't-time'
      time.textContent = turnTime(turn.t)
      headRow.append(speaker, time)

      const text = document.createElement('div')
      text.className = 't-text'
      turn.entries.forEach((entry, i) => {
        if (i > 0) text.append(' ')
        if (entry.text === '[inaudible]') {
          const dim = document.createElement('span')
          dim.className = 'inaudible'
          dim.textContent = entry.text
          text.append(dim)
        } else {
          text.append(entry.text)
        }
      })

      el.append(headRow, text)
      transcript.append(el)
    }
  }

  // Summary panel (distinct card above the transcript) — shown when the
  // summary exists; Summarize generates + persists it on demand otherwise.
  const summaryPanel = document.createElement('div')
  summaryPanel.className = 'meeting-summary'
  const renderSummary = (text: string): void => {
    summaryPanel.replaceChildren()
    const h = document.createElement('h2')
    h.textContent = 'Summary'
    const body = document.createElement('div')
    body.className = 'summary-text'
    body.textContent = text
    summaryPanel.append(h, body)
  }
  if (meta.summary) {
    renderSummary(meta.summary)
    actions.append(meetingActionButton('Copy summary', () => window.owenflow.clipboard.write(meta.summary ?? '')))
  } else {
    summaryPanel.style.display = 'none'
    const sumBtn = document.createElement('button')
    sumBtn.className = 'ghost'
    sumBtn.textContent = 'Summarize'
    sumBtn.title = 'Generate an AI summary of this meeting (persisted)'
    sumBtn.addEventListener('click', async () => {
      sumBtn.disabled = true
      sumBtn.textContent = 'Summarizing…'
      let summary = ''
      try {
        summary = await window.owenflow.meetings.summarize(meta.id)
      } catch {
        summary = ''
      }
      if (summary) {
        // Re-open: the backend persisted the summary, so a fresh render shows
        // the Summary panel + Copy summary in their steady-state form.
        await openMeeting(meta.id)
        return
      }
      sumBtn.textContent = 'Summary failed'
      setTimeout(() => {
        sumBtn.textContent = 'Summarize'
        sumBtn.disabled = false
      }, 2000)
    })
    actions.append(sumBtn)
  }

  if (zealConfigured) {
    const zealBtn = document.createElement('button')
    zealBtn.className = 'ghost'
    zealBtn.textContent = meta.actionsSentAt ? 'Re-send action items → ZEAL' : 'Action items → ZEAL'
    zealBtn.addEventListener('click', async () => {
      zealBtn.disabled = true
      zealBtn.textContent = 'Extracting…'
      try {
        const res = await window.owenflow.meetings.sendActions(meta.id)
        if (res.items.length === 0) zealBtn.textContent = 'No action items found'
        else if (res.sent) {
          zealBtn.textContent = `Sent ${res.items.length} ✓`
          // re-open so the actionsSentAt-aware label + Updated stamp re-render
          setTimeout(() => void openMeeting(meta.id), 1200)
          return
        } else zealBtn.textContent = 'ZEAL send failed'
      } catch {
        zealBtn.textContent = 'ZEAL send failed'
      }
      setTimeout(() => {
        zealBtn.textContent = meta.actionsSentAt ? 'Re-send action items → ZEAL' : 'Action items → ZEAL'
        zealBtn.disabled = false
      }, 1600)
    })
    actions.append(zealBtn)
  }

  actions.append(
    meetingActionButton('Copy transcript', () =>
      window.owenflow.clipboard.write(meetingTranscriptText(entries))
    )
  )

  // Delete: inline two-step confirm (no modal), disarms after 3s.
  const delBtn = document.createElement('button')
  delBtn.className = 'danger'
  delBtn.textContent = 'Delete'
  let armed = false
  let disarmTimer: ReturnType<typeof setTimeout> | undefined
  delBtn.addEventListener('click', async () => {
    if (!armed) {
      armed = true
      delBtn.textContent = 'Confirm delete'
      delBtn.style.color = 'var(--danger)'
      disarmTimer = setTimeout(() => {
        armed = false
        delBtn.textContent = 'Delete'
        delBtn.style.color = ''
      }, 3000)
      return
    }
    clearTimeout(disarmTimer)
    delBtn.disabled = true
    await window.owenflow.meetings.remove(meta.id)
    closeMeetingDetail()
  })
  actions.append(delBtn)

  meetingDetail.append(back, head, meetingMetaLine(meta), actions, summaryPanel, transcript)
}

async function openMeeting(id: string): Promise<void> {
  const [{ meta, entries }, s] = await Promise.all([
    window.owenflow.meetings.get(id),
    window.owenflow.settings.get()
  ])
  openMeetingId = id
  renderMeetingDetail(meta, entries, Boolean(s.zealApiKey?.trim() && s.zealEndpoint?.trim()))
  meetingsListView.classList.add('hidden')
  meetingDetail.classList.remove('hidden')
}

function closeMeetingDetail(refresh = true): void {
  openMeetingId = null
  meetingDetail.classList.add('hidden')
  meetingsListView.classList.remove('hidden')
  if (refresh) void refreshMeetings()
}

meetingToggleBtn.addEventListener('click', async () => {
  meetingToggleBtn.disabled = true
  try {
    if (meetingState.active) await window.owenflow.meetings.stop()
    else await window.owenflow.meetings.start()
    meetingState = await window.owenflow.meetings.state()
  } finally {
    meetingToggleBtn.disabled = false
  }
  renderMeetingControls()
  renderHomeMeetingPill()
  syncMeetingTicker()
  if (currentSection === 'meetings' && !openMeetingId) void refreshMeetings()
})

// Instant-apply: the Meetings page has no save bar, so the toggle behaves
// like the Home mode chips — one click, persisted immediately.
mtgAutodetect.addEventListener('change', () => {
  void window.owenflow.settings.set({ meetingAutoDetect: mtgAutodetect.checked })
})

// Live pushes (hotkey toggles, pill, tray) keep this window in sync.
window.owenflow.meetings.onState((s) => {
  meetingState = s
  renderMeetingControls()
  renderHomeMeetingPill()
  syncMeetingTicker()
  if (currentSection === 'meetings' && !openMeetingId) void refreshMeetings()
})

homeMeetingPill.addEventListener('click', () => showSection('meetings'))

void window.owenflow.meetings.state().then((s) => {
  meetingState = s
  renderMeetingControls()
  renderHomeMeetingPill()
  syncMeetingTicker()
})

// ─── About ──────────────────────────────────────────────────────────────────

void window.owenflow.appinfo.get().then((info) => {
  $('about-version').textContent = `v${info.version}`
  $('about-data-path').textContent = info.dataDir
})

// ─── Sidecar status pill (sidebar bottom) ──────────────────────────────────

const sidecarPill = $('sidecar-pill')
const sidecarText = $('sidecar-status-text')

function renderSidecarStatus({ status, detail }: SidecarStatusInfo): void {
  sidecarPill.dataset.status = status
  // The pill is 180px-sidebar-wide: show just the model name when ready
  // ('whisper "large-v3-turbo" on cuda' → 'large-v3-turbo · ready'); full
  // detail stays in the hover tooltip. A CPU fallback (CUDA failed to load)
  // means 5-15s transcriptions instead of ~1.5s — surface it on the pill
  // itself so the slowness is explained at a glance.
  const model = /"([^"]+)"/.exec(detail)?.[1]
  const onCpu = / on cpu\b/.test(detail)
  sidecarText.textContent =
    status === 'ready' && model
      ? `${model} · ready${onCpu ? ' · CPU' : ''}`
      : `sidecar ${status}${detail ? ` · ${detail}` : ''}`
  sidecarPill.title = `Local Whisper sidecar — ${status}${detail ? ` (${detail})` : ''}`
}

void window.owenflow.sidecar.get().then(renderSidecarStatus)
window.owenflow.sidecar.onStatus(renderSidecarStatus)

// ─── Home ───────────────────────────────────────────────────────────────────

const homeChips = Array.from(document.querySelectorAll<HTMLButtonElement>('.chip[data-home-mode]'))

/** Reflect the active flow mode on the Home chip row (called by selectFlowMode). */
function updateHomeChips(mode: FlowMode): void {
  for (const chip of homeChips) chip.classList.toggle('active', chip.dataset.homeMode === mode)
}

// Home chips are LIVE: clicking one persists the flow mode immediately
// (unlike the Modes cards, which stage a draft until Save).
for (const chip of homeChips) {
  chip.addEventListener('click', async () => {
    const mode = chip.dataset.homeMode as FlowMode
    selectFlowMode(mode) // instant feedback (also syncs the Modes cards)
    await window.owenflow.settings.set({ flowMode: mode })
  })
}

// Cleanup chip navigates to Modes, where intensity lives.
$('home-cleanup-chip').addEventListener('click', () => showSection('modes'))
$('home-view-history').addEventListener('click', () => showSection('history'))

/** Time-of-day greeting + date line. */
function renderGreeting(now = new Date()): void {
  const hour = now.getHours()
  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  $('home-greeting').textContent = `Good ${part}, Owen`
  $('home-date').textContent = now.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })
}

/** Footer hint built from the ACTUAL configured hotkey + dictation mode. */
function updateHomeHint(hotkey: string, mode: string): void {
  const hint = $('home-hint')
  hint.replaceChildren()
  const kbds = hotkeyKeyLabels(hotkey).map((label) => {
    const kbd = document.createElement('span')
    kbd.className = 'kbd'
    kbd.textContent = label
    return kbd
  })
  if (mode === 'toggle') {
    hint.append('Press ', ...kbds, ' to start dictating  ·  press again to stop')
  } else {
    hint.append('Hold ', ...kbds, ' to dictate  ·  double-tap to lock')
  }
}

/** Short badge for the app column, e.g. "Cursor" → "Cu". */
function appBadge(app: string | undefined): string {
  const name = (app ?? '').trim()
  if (!name) return '·'
  return name.slice(0, 2).replace(/^(.)(.)$/, (_m, a: string, b: string) => a.toUpperCase() + b)
}

function renderRecentRow(entry: HistoryEntry): HTMLElement {
  const row = document.createElement('div')
  row.className = 'rrow'

  const badge = document.createElement('div')
  badge.className = 'appbadge'
  badge.textContent = appBadge(entry.app)
  badge.title = entry.app ?? ''

  const body = document.createElement('div')
  body.className = 'rbody'
  const text = document.createElement('div')
  text.className = 'rtext'
  text.textContent = entry.final
  text.title = entry.final
  const meta = document.createElement('div')
  meta.className = 'rmeta'
  meta.textContent = `${entry.app ? `${entry.app} · ` : ''}${relativeTime(entry.ts)}`
  body.append(text, meta)

  const copy = document.createElement('button')
  copy.className = 'rcopy'
  copy.title = 'Copy'
  copy.innerHTML =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 4.5h-9a2 2 0 0 0-2 2v9"/></svg>'
  copy.addEventListener('click', async () => {
    try {
      await window.owenflow.clipboard.write(entry.final)
      copy.title = 'Copied ✓'
      setTimeout(() => (copy.title = 'Copy'), 1200)
    } catch {
      /* ignore */
    }
  })

  row.append(badge, body, copy)
  return row
}

/** Recompute greeting, stats and the recent list from history. */
async function refreshHome(): Promise<void> {
  renderGreeting()
  const entries = await window.owenflow.history.list(1000)
  const stats = computeHomeStats(entries)

  $('stat-count').textContent = String(stats.todayCount)
  $('stat-words').textContent = stats.wordsToday.toLocaleString()
  const saved = $('stat-saved')
  saved.replaceChildren(String(stats.timeSavedMin))
  const savedUnit = document.createElement('small')
  savedUnit.textContent = 'min'
  saved.append(savedUnit)
  const streak = $('stat-streak')
  streak.replaceChildren(String(stats.streakDays))
  const streakUnit = document.createElement('small')
  streakUnit.textContent = stats.streakDays === 1 ? 'day' : 'days'
  streak.append(streakUnit)

  const recent = $('home-recent')
  recent.replaceChildren()
  const latest = entries.slice(0, 5)
  if (latest.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'rempty'
    empty.textContent = 'No dictations yet. Hold the hotkey and speak.'
    recent.append(empty)
    return
  }
  for (const entry of latest) recent.append(renderRecentRow(entry))
}

// "Dictate now": main minimizes this window and starts a dictation (no-op if
// one is already active). Stopping is owned by the hotkey state machine.
$('btn-dictate-now').addEventListener('click', () => {
  void window.owenflow.dictation.start()
})

// ─── Init ───────────────────────────────────────────────────────────────────

void window.owenflow.settings.get().then(fillForm)
void refreshHome()
