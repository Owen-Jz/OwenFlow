/**
 * Settings + History window renderer (two tabs, one window).
 */

// Techy typography: Space Grotesk for headings/UI, JetBrains Mono for
// values, inputs and micro-text.
import '@fontsource/space-grotesk/400.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/700.css'

import type { FlowMode, HistoryEntry, OwenFlowSettings } from '../../shared/types'

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing element #${id}`)
  return el as T
}

// ─── Tabs ───────────────────────────────────────────────────────────────────

const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'))

function showTab(name: 'settings' | 'history'): void {
  for (const tab of tabs) tab.classList.toggle('active', tab.dataset.tab === name)
  $('page-settings').classList.toggle('active', name === 'settings')
  $('page-history').classList.toggle('active', name === 'history')
  if (name === 'history') void refreshHistory()
}

for (const tab of tabs) {
  tab.addEventListener('click', () => showTab(tab.dataset.tab as 'settings' | 'history'))
}

window.owenflow.ui.onShowTab((tab) => showTab(tab))

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
    launchOnStartup: fStartup.checked
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

async function saveTags(entry: HistoryEntry, tags: string[]): Promise<void> {
  entry.tags = tags
  await window.owenflow.history.updateTags(entry.ts, tags)
  await refreshHistory()
}

function renderTags(entry: HistoryEntry): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'tags'

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
      void saveTags(
        entry,
        entry.tags.filter((t) => t !== tag)
      )
    })

    chip.append(name, x)
    wrap.append(chip)
  }

  const add = document.createElement('button')
  add.className = 'tag-add'
  add.textContent = '+ tag'
  add.addEventListener('click', () => {
    const input = document.createElement('input')
    input.className = 'tag-input'
    input.placeholder = 'new-tag'
    input.spellcheck = false
    add.replaceWith(input)
    input.focus()

    const commit = (): void => {
      const tag = input.value.trim().toLowerCase().replace(/\s+/g, '-')
      if (tag && !entry.tags.includes(tag)) {
        void saveTags(entry, [...entry.tags, tag])
      } else {
        input.replaceWith(add)
      }
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit()
      if (e.key === 'Escape') input.replaceWith(add)
    })
    input.addEventListener('blur', () => commit())
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
  ts.textContent =
    `${formatTs(entry.ts)} · ${(entry.durationMs / 1000).toFixed(1)}s` +
    (entry.mode ? ` · ${entry.mode}` : '')

  const text = document.createElement('div')
  text.className = 'text'
  text.textContent = entry.final

  body.append(ts, text, renderTags(entry))

  const copy = document.createElement('button')
  copy.className = 'copy'
  copy.textContent = 'Copy'
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(entry.final)
    copy.textContent = 'Copied ✓'
    setTimeout(() => (copy.textContent = 'Copy'), 1200)
  })

  el.append(body, copy)
  return el
}

async function refreshHistory(): Promise<void> {
  const [all] = await Promise.all([window.owenflow.history.list(200), refreshTagFilter()])
  const entries = filterTag ? all.filter((e) => e.tags.includes(filterTag)) : all
  historyList.replaceChildren()
  historyCount.textContent = entries.length
    ? `${entries.length} dictation${entries.length === 1 ? '' : 's'}${filterTag ? ` · #${filterTag}` : ''}`
    : ''
  if (entries.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = filterTag
      ? `No dictations tagged #${filterTag}.`
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

// ─── Init ───────────────────────────────────────────────────────────────────

void window.owenflow.settings.get().then(fillForm)
