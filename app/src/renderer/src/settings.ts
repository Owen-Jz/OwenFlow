/**
 * Settings window renderer — sidebar app shell with
 * General / Modes / Dictionary / History / About sections.
 */

// Techy typography: Space Grotesk for headings/UI, JetBrains Mono for
// values, inputs and micro-text.
import '@fontsource/space-grotesk/400.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'

import type {
  FlowMode,
  FolderCount,
  HistoryEntry,
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

// ─── Sidebar navigation ─────────────────────────────────────────────────────

type SectionName = 'general' | 'modes' | 'dictionary' | 'history' | 'about'

const navItems = Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-item'))
const pages: SectionName[] = ['general', 'modes', 'dictionary', 'history', 'about']

function showSection(name: SectionName): void {
  for (const item of navItems) item.classList.toggle('active', item.dataset.section === name)
  for (const page of pages) $(`page-${page}`).classList.toggle('active', page === name)
  // Save bar only applies to the settings-form sections.
  $('form-actions').classList.toggle('hidden', name === 'history' || name === 'about')
  if (name === 'history') void refreshHistory()
}

for (const item of navItems) {
  item.addEventListener('click', () => showSection(item.dataset.section as SectionName))
}

// Main process still speaks the old two-tab language (tray menu items).
window.owenflow.ui.onShowTab((tab) => showSection(tab === 'history' ? 'history' : 'general'))

// ─── Settings form ──────────────────────────────────────────────────────────

const fHotkey = $<HTMLInputElement>('f-hotkey')
const fMode = $<HTMLSelectElement>('f-mode')
const fModel = $<HTMLSelectElement>('f-model')
const fLanguage = $<HTMLInputElement>('f-language')
const fCleanup = $<HTMLInputElement>('f-cleanup')
const fMinimaxKey = $<HTMLInputElement>('f-minimax-key')
const fMinimaxGroup = $<HTMLInputElement>('f-minimax-group')
const fDictionary = $<HTMLTextAreaElement>('f-dictionary')
const fStartup = $<HTMLInputElement>('f-startup')
const saveStatus = $('save-status')

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
}

for (const card of modeCards) {
  card.addEventListener('click', () => selectFlowMode(card.dataset.flowMode as FlowMode))
}

function fillForm(s: OwenFlowSettings): void {
  fHotkey.value = s.hotkey
  fMode.value = s.mode
  fModel.value = s.model
  fLanguage.value = s.language
  fCleanup.checked = s.cleanupEnabled
  fMinimaxKey.value = s.minimaxApiKey
  fMinimaxGroup.value = s.minimaxGroupId
  fDictionary.value = s.dictionary.join('\n')
  fStartup.checked = s.launchOnStartup
  selectFlowMode(s.flowMode ?? 'normal')
  selectTheme(s.theme ?? 'dark')
}

function readForm(): Partial<OwenFlowSettings> {
  return {
    hotkey: fHotkey.value.trim() || 'RightCtrl',
    mode: fMode.value === 'toggle' ? 'toggle' : 'hold',
    flowMode: selectedFlowMode,
    model: fModel.value as OwenFlowSettings['model'],
    language: fLanguage.value.trim(),
    cleanupEnabled: fCleanup.checked,
    minimaxApiKey: fMinimaxKey.value.trim(),
    minimaxGroupId: fMinimaxGroup.value.trim(),
    dictionary: fDictionary.value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    launchOnStartup: fStartup.checked,
    theme: selectedTheme
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
  sidecarText.textContent = `sidecar ${status}${detail ? ` · ${detail}` : ''}`
  sidecarPill.title = `Local Whisper sidecar — ${status}${detail ? ` (${detail})` : ''}`
}

void window.owenflow.sidecar.get().then(renderSidecarStatus)
window.owenflow.sidecar.onStatus(renderSidecarStatus)

// ─── Init ───────────────────────────────────────────────────────────────────

void window.owenflow.settings.get().then(fillForm)
