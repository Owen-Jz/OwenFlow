/**
 * Scratchpad renderer — floating always-on-top dictation notepad.
 *
 * Boot sequence:
 *  1. Fetch existing content from main via `getContent()` and populate textarea.
 *  2. Subscribe to `onAppend` pushes (dictated text arriving from the pipeline).
 *  3. Subscribe to `onState` pushes (capture flag sync from main).
 *  4. Wire textarea `input` → `setContent`, capture toggle, copy-all, clear, close.
 */

const sp = window.owenflow.scratchpad

// ─── DOM refs ─────────────────────────────────────────────────────────────────

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing element #${id}`)
  return el as T
}

const pad = $<HTMLTextAreaElement>('pad')
const captureCheckbox = $<HTMLInputElement>('capture-toggle')
const btnCopy = $<HTMLButtonElement>('btn-copy')
const btnClear = $<HTMLButtonElement>('btn-clear')
const btnClose = $<HTMLButtonElement>('btn-close')

// ─── Boot: load persisted content ─────────────────────────────────────────────

sp.getContent().then((text) => {
  pad.value = text
})

// ─── Dictation append: push from main ─────────────────────────────────────────

sp.onAppend((text) => {
  // Insert with a separator when the pad already has content
  if (pad.value.length > 0) {
    pad.value += '\n' + text
  } else {
    pad.value = text
  }
  // Scroll to the new text
  pad.scrollTop = pad.scrollHeight
})

// ─── Capture state sync: main may push updated flag ──────────────────────────

sp.onState(({ capturing }) => {
  captureCheckbox.checked = capturing
})

// ─── Textarea input → persist to main ─────────────────────────────────────────

pad.addEventListener('input', () => {
  sp.setContent(pad.value)
})

// ─── Capture toggle ───────────────────────────────────────────────────────────

captureCheckbox.addEventListener('change', () => {
  sp.setCapture(captureCheckbox.checked)
})

// ─── Copy all ────────────────────────────────────────────────────────────────

btnCopy.addEventListener('click', () => {
  if (!pad.value) return
  navigator.clipboard.writeText(pad.value).catch(() => {
    // fallback: select all so the user can Ctrl+C manually
    pad.select()
  })
})

// ─── Clear ────────────────────────────────────────────────────────────────────

btnClear.addEventListener('click', () => {
  pad.value = ''
  sp.setContent('')
})

// ─── Close ───────────────────────────────────────────────────────────────────

btnClose.addEventListener('click', () => {
  sp.close()
})
