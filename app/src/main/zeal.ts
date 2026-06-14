/**
 * ZEAL voice-command HTTP client. POSTs a spoken instruction to the VPS
 * /api/voice route and returns ZEAL's reply. Never throws.
 */
import type { OwenFlowSettings } from '../shared/types'

export interface ZealReply {
  ok: boolean
  reply: string
  actions?: Array<{ tool?: string; label?: string }>
  error?: string
}

const TIMEOUT_MS = 30_000

export async function sendZealCommand(message: string, settings: OwenFlowSettings): Promise<ZealReply> {
  const endpoint = settings.zealEndpoint?.trim()
  const key = settings.zealApiKey?.trim()
  if (!endpoint || !key) return { ok: false, reply: '', error: 'ZEAL endpoint/key not configured' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-voice-key': key },
      body: JSON.stringify({ message }),
      signal: controller.signal
    })
    if (!res.ok) return { ok: false, reply: '', error: `ZEAL HTTP ${res.status}` }
    const data = (await res.json()) as ZealReply
    return { ok: !!data.ok, reply: data.reply ?? '', actions: data.actions, error: data.error }
  } catch (err) {
    return { ok: false, reply: '', error: err instanceof Error ? err.message : 'request failed' }
  } finally {
    clearTimeout(timer)
  }
}
