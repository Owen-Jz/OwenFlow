/**
 * MiniMax post-processing pass, driven by the flow mode:
 *  - normal: optional cleanup (punctuation/casing/fillers) — respects cleanupEnabled
 *  - vibe:   restructures rambly speech into a refined AI coding prompt — ALWAYS
 *            runs when an API key is set (ignores cleanupEnabled)
 *  - formal: client-ready professional rewrite — same gating as vibe
 *
 * Contract: NEVER throws, never blocks the pipeline — any error, timeout
 * (6s normal / 12s vibe+formal), non-200, missing key or empty reply returns
 * the raw transcript unchanged.
 */

import type { FlowMode, OwenFlowSettings } from '../shared/types'

const MINIMAX_URL = 'https://api.minimax.io/v1/text/chatcompletion_v2'
const MODEL = 'MiniMax-M2.5'

/** Vibe/formal rewrite more text — give them longer. */
const TIMEOUT_MS: Record<FlowMode, number> = {
  normal: 6_000,
  vibe: 12_000,
  formal: 12_000
}

const SYSTEM_PROMPTS: Record<FlowMode, string> = {
  normal: [
    'You clean up raw speech-to-text dictation transcripts.',
    'Fix punctuation and casing. Remove filler words (um, uh, like, you know, sort of) and false starts.',
    'Keep the meaning and the original wording otherwise verbatim — do NOT paraphrase, summarize, answer questions, or add anything.',
    'Output ONLY the cleaned text, with no quotes, labels or commentary.'
  ].join(' '),
  vibe: [
    'You turn raw spoken dictation from a developer into a clear, well-structured prompt for an AI coding assistant.',
    'The input is a rambly spoken thought; rewrite it into a refined prompt.',
    'Preserve ALL technical specifics exactly: names, file paths, identifiers, versions, numbers, and constraints.',
    'When it reads naturally, organize the prompt as goal, then context, then requirements.',
    'Tighten the wording and remove filler, but do NOT invent requirements, assumptions, or details that were not said.',
    'Output ONLY the refined prompt — no preamble, no commentary, no markdown code fences.'
  ].join(' '),
  formal: [
    'You rewrite raw spoken dictation into polished professional prose suitable for a message to a client.',
    'Make it courteous, clear and well structured. Remove slang, filler words and false starts.',
    'Keep the meaning exactly — do NOT add promises, facts or details that were not said.',
    'Output ONLY the rewritten text, with no quotes, labels or commentary.'
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
  if (!settings.minimaxApiKey) return raw
  if (!raw.trim()) return raw

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
        temperature: 0.2
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
