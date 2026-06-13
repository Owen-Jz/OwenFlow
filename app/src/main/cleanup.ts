/**
 * LLM post-processing pass, driven by the flow mode and the selected provider.
 *
 * Provider-agnostic: MiniMax (chatcompletion_v2) and Groq (OpenAI-compatible
 * /openai/v1/chat/completions) are both OpenAI-shaped — `messages` in,
 * `choices[0].message.content` out — so a single request/parse path serves
 * both. Groq's llama-3.3-70b-versatile is the default (a non-reasoning model
 * that returns sub-second); MiniMax-M2.5 (a reasoning model whose thinking
 * can't be disabled, ~2.5–8s) is kept as the slow "max-polish" fallback.
 *
 *  - normal: cleanup + restructuring — respects cleanupEnabled, and skips the
 *            LLM entirely for very short transcripts (≤3 words)
 *  - vibe:   restructures rambly speech into a refined AI coding prompt — ALWAYS
 *            runs when a key for the active provider is set
 *  - formal: client-ready professional rewrite — same gating as vibe
 *
 * Contract: NEVER throws, never blocks the pipeline — any error, timeout (15s),
 * non-200, missing key or empty reply returns the raw transcript unchanged.
 */

import type {
  CleanupProvider,
  FlowMode,
  OwenFlowSettings,
  ProviderTiming
} from '../shared/types'

interface ProviderConfig {
  url: string
  defaultModel: string
}

/** OpenAI-shaped chat providers: identical request/response shape, different
 *  endpoint + model. Groq (non-reasoning, sub-second) is the default; MiniMax
 *  (reasoning, 2.5–8s) is the max-polish fallback. */
const PROVIDERS: Record<CleanupProvider, ProviderConfig> = {
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile'
  },
  minimax: {
    url: 'https://api.minimax.io/v1/text/chatcompletion_v2',
    defaultModel: 'MiniMax-M2.5'
  }
}

/** Generous ceiling; Groq usually resolves <1s, MiniMax p95 ≈ 6s. */
const TIMEOUT_MS = 15_000

/** Caps runaway reasoning/output — reasoning tokens count toward this. */
const MAX_TOKENS = 1_500

/**
 * Normal-mode transcripts of ≤ this many words skip the LLM entirely:
 * nothing to restructure, and the user gets an instant paste.
 */
const SKIP_WORD_COUNT = 3

/** Sample sentence used by the Settings "Test & compare" speed benchmark. */
const BENCHMARK_TEXT =
  'um so this is a quick test of the refinement speed you know to compare the two providers'

// Terse prompts on purpose: a reasoning model (MiniMax) measurably thinks (and
// waits) less with tight instructions; Groq is unaffected.
const SYSTEM_PROMPTS: Record<Exclude<FlowMode, 'translate'>, string> = {
  normal: [
    'Rewrite this raw speech-to-text dictation transcript:',
    'remove filler words (um, uh, like, you know, sort of) and false starts,',
    'fix punctuation and casing, and restructure into well-formed sentences that make sense in context —',
    'stay faithful to what was said; never add, answer, or summarize.',
    'Output ONLY the rewritten text — no quotes, labels or commentary.'
  ].join(' '),
  vibe: [
    'You are a prompt engineer. Transform this raw spoken developer dictation into the best possible prompt for an AI coding assistant.',
    'Rules:',
    '1. Write as direct instructions to the AI (imperative: "Add...", "Refactor...", "Fix...").',
    '2. Lead with a one-sentence objective. If the dictation has multiple requirements or details, list them as "- " bullets under the objective; if it is a single simple ask, one tight paragraph.',
    '3. Preserve EVERY technical specific exactly as spoken: names, file paths, identifiers, versions, numbers, constraints.',
    '4. Resolve self-corrections — when the speaker changes their mind ("actually, make it X instead"), keep only the final intent.',
    '5. Make vague references concrete only when the dictation itself makes them clear; NEVER invent requirements, technologies, or details that were not said.',
    '6. End with expected behavior or acceptance criteria when the speaker described an outcome.',
    'Output ONLY the finished prompt text — no preamble, no commentary, no markdown code fences.'
  ].join('\n'),
  formal: [
    'Rewrite this raw spoken dictation into polished professional prose suitable for a message to a client.',
    'Courteous, clear, well structured; remove slang, filler words and false starts.',
    'Keep the meaning exactly — do NOT add promises, facts or details that were not said.',
    'Output ONLY the rewritten text — no quotes, labels or commentary.'
  ].join(' ')
}

/** The system prompt for a mode; translate is dynamic (depends on the target). */
function systemPromptFor(mode: FlowMode, settings: OwenFlowSettings): string {
  if (mode === 'translate') {
    const target = settings.translateTarget?.trim() || 'English'
    return [
      `Translate the following dictation into ${target}.`,
      'Output ONLY the translation — no quotes, labels, or commentary.',
      'Preserve meaning and tone; do not add or omit content.'
    ].join(' ')
  }
  return SYSTEM_PROMPTS[mode]
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>
}

/** Resolve a provider's endpoint, key and model from settings. */
function resolveProvider(
  settings: OwenFlowSettings,
  name: CleanupProvider
): { url: string; apiKey: string; model: string } {
  const provider = PROVIDERS[name]
  const apiKey = name === 'groq' ? settings.groqApiKey : settings.minimaxApiKey
  const model =
    name === 'groq' ? settings.groqModel || provider.defaultModel : provider.defaultModel
  return { url: provider.url, apiKey, model }
}

export async function cleanup(raw: string, settings: OwenFlowSettings, extraSystem?: string): Promise<string> {
  const mode: FlowMode = settings.flowMode ?? 'normal'

  // Normal mode is an opt-in cleanup pass; vibe/formal REQUIRE the API and
  // ignore the cleanupEnabled toggle (no key → graceful raw fallback).
  if (mode === 'normal' && !settings.cleanupEnabled) return raw
  if (!raw.trim()) return raw

  // Very short normal-mode dictations ("yes", "send it", "on my way") have
  // nothing to restructure — skip the LLM round-trip for an instant paste.
  if (mode === 'normal' && raw.trim().split(/\s+/).length <= SKIP_WORD_COUNT) return raw

  const { url, apiKey, model } = resolveProvider(settings, settings.cleanupProvider ?? 'groq')
  if (!apiKey) return raw

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: extraSystem ? `${systemPromptFor(mode, settings)}\n${extraSystem}` : systemPromptFor(mode, settings) },
          { role: 'user', content: raw }
        ],
        temperature: 0,
        max_tokens: MAX_TOKENS
      }),
      signal: controller.signal
    })
    if (!res.ok) {
      console.warn(`[cleanup] ${model} HTTP ${res.status} (${mode}) — using raw transcript`)
      return raw
    }
    const data = (await res.json()) as ChatResponse
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

/**
 * Time one provider's refinement round-trip against a fixed sample sentence.
 * Forces `provider` regardless of settings.cleanupProvider so the Settings
 * "Test & compare" button can race both. Never throws: a missing key returns
 * { ok: false, error: 'no API key' }; non-200/timeout returns { ok: false }.
 */
export async function benchmarkProvider(
  provider: CleanupProvider,
  settings: OwenFlowSettings
): Promise<ProviderTiming> {
  const { url, apiKey, model } = resolveProvider(settings, provider)
  if (!apiKey) return { provider, ok: false, ms: 0, error: 'no API key' }

  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPTS.normal },
          { role: 'user', content: BENCHMARK_TEXT }
        ],
        temperature: 0,
        max_tokens: MAX_TOKENS
      }),
      signal: controller.signal
    })
    const ms = Date.now() - started
    if (!res.ok) return { provider, ok: false, ms, error: `HTTP ${res.status}` }
    // Deliberately do NOT read the body: we only need the round-trip time, and
    // these are non-streaming JSON endpoints (server completes before sending
    // headers). Skipping the read also avoids double body-consumption when both
    // providers share a mocked Response in concurrent tests.
    return { provider, ok: true, ms }
  } catch (err) {
    return {
      provider,
      ok: false,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : 'failed'
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Benchmark both providers concurrently for the Settings "Test & compare" button. */
export async function benchmarkProviders(settings: OwenFlowSettings): Promise<ProviderTiming[]> {
  return Promise.all([benchmarkProvider('groq', settings), benchmarkProvider('minimax', settings)])
}
