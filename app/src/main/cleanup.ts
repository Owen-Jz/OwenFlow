/**
 * MiniMax post-processing pass, driven by the flow mode:
 *  - normal: cleanup + restructuring (fillers out, well-formed sentences,
 *            faithful to what was said) — respects cleanupEnabled, and skips
 *            the LLM entirely for very short transcripts (≤3 words)
 *  - vibe:   restructures rambly speech into a refined AI coding prompt — ALWAYS
 *            runs when an API key is set (ignores cleanupEnabled)
 *  - formal: client-ready professional rewrite — same gating as vibe
 *
 * Latency notes (measured live 2026-06-12 against MiniMax-M2.5, a reasoning
 * model — thinking can NOT be disabled on M2.x): terse prompts + temperature 0
 * + a max_tokens cap cut p50 from ~4.7s/7.0s (short/long) to ~2.5s/3.9s, with
 * the worst observed run at 8.0s. Legacy fast models (MiniMax-Text-01, M1,
 * abab6.5s) are unavailable on this key; M2 / M2.5-highspeed were no faster.
 *
 * Contract: NEVER throws, never blocks the pipeline — any error, timeout
 * (15s, all modes — measured p95 ~6s + headroom), non-200, missing key or
 * empty reply returns the raw transcript unchanged.
 */

import type { FlowMode, OwenFlowSettings } from '../shared/types'

const MINIMAX_URL = 'https://api.minimax.io/v1/text/chatcompletion_v2'
const MODEL = 'MiniMax-M2.5'

/** Measured p95 ≈ 6s on long dictations; generous headroom so vibe/formal
 *  reliably finish instead of silently falling back to the raw transcript. */
const TIMEOUT_MS: Record<FlowMode, number> = {
  normal: 15_000,
  vibe: 15_000,
  formal: 15_000
}

/** Caps runaway reasoning/output — reasoning tokens count toward this. */
const MAX_TOKENS = 1_500

/**
 * Normal-mode transcripts of ≤ this many words skip the LLM entirely:
 * nothing to restructure, and the user gets an instant paste.
 */
const SKIP_WORD_COUNT = 3

// Terse prompts on purpose: M2.5 is a reasoning model and measurably thinks
// (and waits) less with tight instructions.
const SYSTEM_PROMPTS: Record<FlowMode, string> = {
  normal: [
    'Rewrite this raw speech-to-text dictation transcript:',
    'remove filler words (um, uh, like, you know, sort of) and false starts,',
    'fix punctuation and casing, and restructure into well-formed sentences that make sense in context —',
    'stay faithful to what was said; never add, answer, or summarize.',
    'Output ONLY the rewritten text — no quotes, labels or commentary.'
  ].join(' '),
  vibe: [
    'Rewrite this raw spoken developer dictation into a clear, well-structured prompt for an AI coding assistant.',
    'Preserve ALL technical specifics exactly: names, file paths, identifiers, versions, numbers, constraints.',
    'Organize as goal, then context, then requirements when natural. Remove filler;',
    'do NOT invent requirements or details that were not said.',
    'Output ONLY the refined prompt — no preamble, no commentary, no markdown code fences.'
  ].join(' '),
  formal: [
    'Rewrite this raw spoken dictation into polished professional prose suitable for a message to a client.',
    'Courteous, clear, well structured; remove slang, filler words and false starts.',
    'Keep the meaning exactly — do NOT add promises, facts or details that were not said.',
    'Output ONLY the rewritten text — no quotes, labels or commentary.'
  ].join(' ')
}

interface MiniMaxResponse {
  choices?: Array<{ message?: { content?: string } }>
}

export async function cleanup(raw: string, settings: OwenFlowSettings): Promise<string> {
  const mode: FlowMode = settings.flowMode ?? 'normal'

  // Normal mode is an opt-in cleanup pass; vibe/formal REQUIRE the API and
  // ignore the cleanupEnabled toggle (no key → graceful raw fallback).
  if (mode === 'normal' && !settings.cleanupEnabled) return raw
  if (!raw.trim()) return raw

  // Very short normal-mode dictations ("yes", "send it", "on my way") have
  // nothing to restructure — skip the LLM round-trip for an instant paste.
  if (mode === 'normal' && raw.trim().split(/\s+/).length <= SKIP_WORD_COUNT) return raw

  if (!settings.minimaxApiKey) return raw

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS[mode])
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
          { role: 'system', content: SYSTEM_PROMPTS[mode] },
          { role: 'user', content: raw }
        ],
        temperature: 0,
        max_tokens: MAX_TOKENS
      }),
      signal: controller.signal
    })
    if (!res.ok) {
      console.warn(`[cleanup] MiniMax HTTP ${res.status} (${mode}) — using raw transcript`)
      return raw
    }
    const data = (await res.json()) as MiniMaxResponse
    const text = data.choices?.[0]?.message?.content?.trim()
    return text || raw
  } catch (err) {
    console.warn(
      `[cleanup] ${mode} pass failed — using raw transcript:`,
      err instanceof Error ? err.message : err
    )
    return raw
  } finally {
    clearTimeout(timer)
  }
}
