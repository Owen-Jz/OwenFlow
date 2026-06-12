/**
 * Pill overlay renderer. Pure state display driven by "pill:state" pushes
 * from the main process. Auto-hide timing is owned by main (pipeline.ts);
 * this renderer only animates in/out.
 */

import type { PillState } from '../../shared/types'

const pill = document.getElementById('pill') as HTMLDivElement
const label = document.getElementById('label') as HTMLDivElement

const DEFAULT_LABELS: Record<string, string> = {
  recording: 'Listening…',
  transcribing: 'Transcribing…',
  done: 'Done',
  error: 'Something went wrong'
}

function render(state: PillState): void {
  if (state.state === 'idle') {
    pill.classList.remove('visible')
    // keep last data-state during fade-out so icon doesn't flicker
    return
  }
  pill.dataset.state = state.state
  label.textContent = state.message || DEFAULT_LABELS[state.state] || ''
  // restart entry animation when becoming visible
  if (!pill.classList.contains('visible')) {
    void pill.offsetWidth // reflow
  }
  pill.classList.add('visible')
}

window.owenflow.pill.onState(render)
