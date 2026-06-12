/**
 * Optional MiniMax cleanup pass: fix punctuation/casing, strip filler words.
 * Contract: NEVER throws, never blocks the pipeline — any error, timeout (6s),
 * non-200 or empty reply returns the raw transcript unchanged.
 */

import type { OwenFlowSettings } from '../shared/types'

const MINIMAX_URL = 'https://api.minimax.io/v1/text/chatcompletion_v2'
const MODEL = 'MiniMax-Text-01'
const TIMEOUT_MS = 6_000

const SYSTEM_PROMPT = [
  'You clean up raw speech-to-text dictation transcripts.',
  'Fix punctuation and casing. Remove filler words (um, uh, like, you know, sort of) and false starts.',
  'Keep the meaning and the original wording otherwise verbatim — do NOT paraphrase, summarize, answer questions, or add anything.',
  'Output ONLY the cleaned text, with no quotes, labels or commentary.'
].join(' ')

interface MiniMaxResponse {
  choices?: Array<{ message?: { content?: string } }>
}

export async function cleanup(raw: string, settings: OwenFlowSettings): Promise<string> {
  if (!settings.cleanupEnabled || !settings.minimaxApiKey) return raw
  if (!raw.trim()) return raw

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(MINIMAX_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.minimaxApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: raw }
        ],
        temperature: 0.2
      }),
      signal: controller.signal
    })
    if (!res.ok) {
      console.warn(`[cleanup] MiniMax HTTP ${res.status} — using raw transcript`)
      return raw
    }
    const data = (await res.json()) as MiniMaxResponse
    const text = data.choices?.[0]?.message?.content?.trim()
    return text || raw
  } catch (err) {
    console.warn(
      '[cleanup] failed — using raw transcript:',
      err instanceof Error ? err.message : err
    )
    return raw
  } finally {
    clearTimeout(timer)
  }
}
