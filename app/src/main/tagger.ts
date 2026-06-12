/**
 * Background auto-tagger: after a successful dictation, ask MiniMax for 1-2
 * short lowercase topic tags (e.g. "fluxboard", "client-email", "vibe-prompt")
 * and attach them to the history entry.
 *
 * Contract (mirrors cleanup.ts): NEVER throws, NEVER blocks the pipeline —
 * it is fired-and-forgotten AFTER inject. Strict 8s timeout; any error,
 * non-200, missing key or empty reply silently yields no tags.
 */

import type { OwenFlowSettings } from '../shared/types'

const MINIMAX_URL = 'https://api.minimax.io/v1/text/chatcompletion_v2'
const MODEL = 'MiniMax-M2.5'
const TIMEOUT_MS = 8_000
const MAX_TAGS = 2

const SYSTEM_PROMPT = [
  'You label speech-to-text dictation transcripts with topic tags.',
  'Reply with 1-2 short lowercase topic tags describing what the transcript is about.',
  'Each tag is 1-3 words joined by hyphens, e.g. "fluxboard", "client-email", "vibe-prompt".',
  'Output ONLY the tags, comma-separated — no quotes, labels or commentary.'
].join(' ')

interface MiniMaxResponse {
  choices?: Array<{ message?: { content?: string } }>
}

/** Parse the model reply into at most MAX_TAGS clean kebab-case tags. */
export function parseTags(content: string): string[] {
  const tags: string[] = []
  for (const part of content.split(/[,\n]/)) {
    const tag = part
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (tag && tag.length <= 32 && !tags.includes(tag)) tags.push(tag)
    if (tags.length >= MAX_TAGS) break
  }
  return tags
}

/**
 * Ask MiniMax for topic tags. Silent failure: any problem returns [].
 */
export async function generateTags(
  transcript: string,
  settings: OwenFlowSettings
): Promise<string[]> {
  if (!settings.minimaxApiKey) return []
  if (!transcript.trim()) return []

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
          { role: 'user', content: transcript }
        ],
        temperature: 0.2
      }),
      signal: controller.signal
    })
    if (!res.ok) return []
    const data = (await res.json()) as MiniMaxResponse
    const text = data.choices?.[0]?.message?.content?.trim()
    return text ? parseTags(text) : []
  } catch {
    return [] // silent — tagging is best-effort decoration
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fire-and-forget: tag the history entry with timestamp `ts` in the
 * background. `applyTags` is injected (history.updateTags in production)
 * so this module stays electron-free and testable.
 */
export function autoTag(
  ts: number,
  transcript: string,
  settings: OwenFlowSettings,
  applyTags: (ts: number, tags: string[]) => unknown
): void {
  void generateTags(transcript, settings)
    .then((tags) => {
      if (tags.length) applyTags(ts, tags)
    })
    .catch(() => {
      /* never surfaces */
    })
}
