/**
 * Settings + History window renderer (two tabs, one window).
 */

import type { HistoryEntry, OwenFlowSettings } from '../../shared/types'

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
const cleanupFields = $('cleanup-fields')
const saveStatus = $('save-status')

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
  cleanupFields.classList.toggle('visible', s.cleanupEnabled)
}

function readForm(): Partial<OwenFlowSettings> {
  return {
    hotkey: fHotkey.value.trim() || 'RightCtrl',
    mode: fMode.value === 'toggle' ? 'toggle' : 'hold',
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

fCleanup.addEventListener('change', () => {
  cleanupFields.classList.toggle('visible', fCleanup.checked)
})

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
  ts.textContent = `${formatTs(entry.ts)} · ${(entry.durationMs / 1000).toFixed(1)}s`

  const text = document.createElement('div')
  text.className = 'text'
  text.textContent = entry.final

  body.append(ts, text)

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
  const entries = await window.owenflow.history.list(200)
  historyList.replaceChildren()
  historyCount.textContent = entries.length
    ? `${entries.length} dictation${entries.length === 1 ? '' : 's'}`
    : ''
  if (entries.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = 'No dictations yet. Hold the hotkey and speak.'
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
