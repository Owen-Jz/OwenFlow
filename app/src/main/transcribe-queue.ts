/**
 * In-memory retry queue for dictations that failed to transcribe (sidecar cold
 * or busy). Retries on an interval until success or MAX_ATTEMPTS, then delivers
 * the recovered transcript (never throws). Lost on app quit — by design.
 */
import type { OwenFlowSettings } from '../shared/types'

export interface QueueItem {
  wav: ArrayBuffer
  settings: OwenFlowSettings
  startedAt: number
  attempts: number
}

interface TranscribeResult { text: string; durationMs: number }
interface QueueDeps {
  transcribe: (wav: ArrayBuffer, settings: OwenFlowSettings) => Promise<TranscribeResult>
  deliver: (text: string, item: QueueItem) => void
  onDrop?: (item: QueueItem) => void
}

const RETRY_INTERVAL_MS = 3000
const MAX_ATTEMPTS = 40

let deps: QueueDeps | null = null
let items: QueueItem[] = []
let timer: NodeJS.Timeout | null = null
let draining = false

export function initTranscribeQueue(d: QueueDeps): void {
  deps = d
}

export function queueLength(): number {
  return items.length
}

/** Test helper — clears state. */
export function _resetQueue(): void {
  items = []
  if (timer) clearInterval(timer)
  timer = null
  draining = false
}

export function enqueue(wav: ArrayBuffer, settings: OwenFlowSettings, startedAt: number): void {
  items.push({ wav, settings, startedAt, attempts: 0 })
  startTimer()
}

function startTimer(): void {
  if (timer) return
  timer = setInterval(() => void drain(), RETRY_INTERVAL_MS)
}

function stopTimer(): void {
  if (timer) clearInterval(timer)
  timer = null
}

async function drain(): Promise<void> {
  if (draining || !deps || items.length === 0) return
  draining = true
  try {
    const item = items[0]
    item.attempts++
    try {
      const result = await deps.transcribe(item.wav, item.settings)
      items.shift()
      deps.deliver(result.text, item)
    } catch {
      if (item.attempts >= MAX_ATTEMPTS) {
        items.shift()
        deps.onDrop?.(item)
      }
    }
    if (items.length === 0) stopTimer()
  } finally {
    draining = false
  }
}
