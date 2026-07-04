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
 *  - normal:    Wispr-Flow-style auto-edit — removes fillers/false starts,
 *               resolves spoken self-corrections to the final version, fixes
 *               punctuation/casing/homophones, applies dictated punctuation
 *               ("new line", "period"), formats numbers/emails/URLs — while
 *               PRESERVING the speaker's voice and tone (cleanup, not a
 *               rewrite). Shaped by the Auto Cleanup intensity
 *               (settings.cleanupIntensity): 'none' skips the LLM entirely
 *               (raw verbatim paste), 'light' only strips fillers + basic
 *               punctuation/casing, 'medium' is the full auto-edit above,
 *               'high' adds run-on restructuring, spoken-list formatting and
 *               grammar fixes. The legacy cleanupEnabled toggle is still
 *               honored as 'none' when false, and the LLM is skipped for
 *               very short transcripts (≤3 words).
 *  - vibe:      prompt-engineering pass — turns rambly developer dictation into
 *               a structured prompt for an AI coding agent (objective line +
 *               "- " bullets, technical tokens preserved verbatim, detours
 *               dropped, expected-behavior line when stated) — ALWAYS runs when
 *               a key for the active provider is set
 *  - formal:    client-ready professional rewrite in natural business English;
 *               keeps every commitment/fact exactly as spoken — same gating as
 *               vibe
 *  - translate: natural native-phrasing translation into settings.translateTarget
 *               (prompt built dynamically in systemPromptFor) — same gating as
 *               vibe
 *
 * Contract: NEVER throws, never blocks the pipeline — any error, timeout (15s),
 * non-200, missing key or empty reply returns the raw transcript unchanged.
 */

import type {
  CleanupIntensity,
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

/** Shared closing line for every normal-mode prompt variant. */
const OUTPUT_ONLY = 'Output ONLY the cleaned text — no quotes, labels, or commentary.'

/** Core Wispr-style auto-edit rules — the medium intensity (numbered at build time). */
const NORMAL_EDIT_RULES = [
  'Remove filler words (um, uh, like, you know, sort of) and false starts.',
  'Resolve spoken self-corrections — keep only the final version ("send it Tuesday, no wait, Wednesday" -> Wednesday only).',
  'Fix punctuation, casing, and obvious homophone/transcription slips from context.',
  'Convert spoken punctuation ONLY when clearly dictated as a command: "new line", "period", "comma", "question mark".',
  'Format numbers, emails, and URLs naturally: "john dot smith at gmail dot com" -> john.smith@gmail.com; "twenty five percent" -> 25%.'
]

/** Extra readability rules the high intensity layers on top of medium. */
const NORMAL_HIGH_RULES = [
  'Restructure run-on sentences into clear, readable sentences.',
  'When the speaker enumerates items ("first... second...", "one... two..."), format them as a "- " bullet list (or a numbered list when the order matters).',
  'Fix grammar mistakes.'
]

/** Voice-preservation guard rails shared by medium and high. */
const NORMAL_GUARD_RULES = [
  "PRESERVE the speaker's voice, word choice, and tone; do not formalize casual speech or rephrase beyond the fixes above.",
  'Never add, answer, or summarize anything.'
]

function buildNormalPrompt(extraRules: string[]): string {
  const rules = [...NORMAL_EDIT_RULES, ...extraRules, ...NORMAL_GUARD_RULES]
  return [
    'Clean up this raw speech-to-text dictation transcript. This is cleanup, not rewriting.',
    'Rules:',
    ...rules.map((rule, i) => `${i + 1}. ${rule}`),
    OUTPUT_ONLY
  ].join('\n')
}

/**
 * Normal-mode prompt per Auto Cleanup intensity ('none' never reaches the LLM).
 * Light is a deliberately minimal variant: fillers + basic punctuation/casing
 * only — no self-correction resolution, no number/email reformatting.
 */
const NORMAL_PROMPTS: Record<Exclude<CleanupIntensity, 'none'>, string> = {
  light: [
    'Lightly clean up this raw speech-to-text dictation transcript.',
    'Rules:',
    '1. ONLY remove filler words (um, uh, like, you know, sort of).',
    '2. Add basic punctuation and sentence casing.',
    '3. Keep every word as spoken — do not resolve self-corrections, do not reformat numbers, emails, or URLs, and do not rephrase or reorder anything.',
    '4. Never add, answer, or summarize anything.',
    OUTPUT_ONLY
  ].join('\n'),
  medium: buildNormalPrompt([]),
  high: buildNormalPrompt(NORMAL_HIGH_RULES)
}

/**
 * Effective normal-mode Auto Cleanup intensity. The legacy cleanupEnabled
 * master toggle is honored as a hard 'none' when false; settings objects
 * predating cleanupIntensity fall back to 'medium' (the old enabled behavior).
 */
export function resolveNormalIntensity(settings: OwenFlowSettings): CleanupIntensity {
  if (settings.cleanupEnabled === false) return 'none'
  return settings.cleanupIntensity ?? 'medium'
}

// Terse prompts on purpose: a reasoning model (MiniMax) measurably thinks (and
// waits) less with tight instructions; Groq is unaffected.
const SYSTEM_PROMPTS: Record<Exclude<FlowMode, 'translate'>, string> = {
  normal: NORMAL_PROMPTS.medium,
  vibe: [
    'You are a senior prompt engineer. Transform this raw spoken developer dictation into a precise prompt for an AI coding agent (Claude Code, Cursor).',
    'Rules:',
    '1. Imperative voice addressed to the coding agent ("Add...", "Fix...", "Refactor...").',
    '2. Lead with a single-sentence objective stating the outcome. If the dictation has multiple requirements, constraints, or details, group them as "- " bullets under the objective (requirements first, then constraints, then edge cases); a single simple ask stays one tight paragraph.',
    '3. Preserve EVERY technical token exactly as spoken: file paths, function/variable names, package names, versions, flags, numbers, error messages. Keep code identifiers verbatim (backticks allowed).',
    '4. Resolve self-corrections to the final intent; drop thinking-out-loud detours the speaker abandoned.',
    '5. Make vague references ("that function", "the thing") concrete ONLY when the dictation itself defines them; NEVER invent requirements, tech choices, or acceptance criteria that were not said.',
    '6. If the speaker described expected behavior or success conditions, end with an "Expected behavior:" line.',
    '7. If the speaker was uncertain ("maybe", "I think", "or whatever works"), keep the decision open (e.g. "choose the best approach") — never fabricate a choice.',
    'Output ONLY the finished prompt as plain text — no preamble, no commentary, no markdown code fences.'
  ].join('\n'),
  formal: [
    'Rewrite this raw spoken dictation as a polished, client-ready professional message.',
    'Rules:',
    '1. Courteous, clear, well-structured paragraphs.',
    '2. Remove slang, filler words, and false starts; resolve self-corrections to the final version.',
    '3. Keep every commitment, fact, name, number, and date exactly as spoken — do NOT add promises, dates, or details that were not said.',
    '4. Natural business English, not stiff corporate-speak.',
    'Output ONLY the rewritten text — no quotes, labels, or commentary.'
  ].join('\n')
}

/** The system prompt for a mode; translate is dynamic (depends on the target). */
function systemPromptFor(mode: FlowMode, settings: OwenFlowSettings): string {
  if (mode === 'translate') {
    const target = settings.translateTarget?.trim() || 'English'
    return [
      `Translate the following dictation into ${target} with natural, native phrasing.`,
      'Keep names, technical terms, numbers, and formatting as-is.',
      'Do not add, omit, or explain anything.',
      'Output ONLY the translation — no quotes, labels, or commentary.'
    ].join(' ')
  }
  if (mode === 'normal') {
    const intensity = resolveNormalIntensity(settings)
    // 'none' never gets here (cleanup() returns raw first) — medium fallback.
    return NORMAL_PROMPTS[intensity === 'none' ? 'medium' : intensity]
  }
  return SYSTEM_PROMPTS[mode]
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>
}

function keyFor(settings: OwenFlowSettings, name: CleanupProvider): string {
  return name === 'groq' ? settings.groqApiKey : settings.minimaxApiKey
}

/**
 * Resolve a provider's endpoint, key and model from settings.
 *
 * When the selected provider has no key but the OTHER one does, fall back to
 * the other — a configured-but-idle key beats silently pasting raw. (Owen hit
 * this live: Groq became the default provider but only his MiniMax key was
 * saved, so vibe/formal rewrites never ran and nothing surfaced why.)
 * `allowFallback: false` keeps benchmarks honest — "Test & compare" must time
 * the provider it names or report its missing key, never a stand-in.
 */
function resolveProvider(
  settings: OwenFlowSettings,
  name: CleanupProvider,
  allowFallback = true
): { url: string; apiKey: string; model: string } {
  let chosen = name
  if (allowFallback && !keyFor(settings, name)) {
    const other: CleanupProvider = name === 'groq' ? 'minimax' : 'groq'
    if (keyFor(settings, other)) {
      console.warn(`[cleanup] no ${name} key set — falling back to ${other}`)
      chosen = other
    }
  }
  const provider = PROVIDERS[chosen]
  const model =
    chosen === 'groq' ? settings.groqModel || provider.defaultModel : provider.defaultModel
  return { url: provider.url, apiKey: keyFor(settings, chosen), model }
}

export async function cleanup(raw: string, settings: OwenFlowSettings, extraSystem?: string): Promise<string> {
  const mode: FlowMode = settings.flowMode ?? 'normal'

  // Normal mode is an opt-in cleanup pass gated by the Auto Cleanup intensity
  // ('none' = raw verbatim paste; the legacy cleanupEnabled=false is honored
  // as 'none'). Vibe/formal/translate are modes, not cleanup — they REQUIRE
  // the API, ignore the intensity (no key → graceful raw fallback).
  if (mode === 'normal' && resolveNormalIntensity(settings) === 'none') return raw
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
 * Apply a spoken editing instruction to a target text (command channel).
 * If target is provided, returns the edited text; if no target, fulfills
 * the instruction directly. Returns '' on no key / any error (never throws).
 */
export async function runCommand(
  instruction: string,
  target: string,
  settings: OwenFlowSettings
): Promise<string> {
  const { url, apiKey, model } = resolveProvider(settings, settings.cleanupProvider ?? 'groq')
  if (!apiKey) return ''
  const userContent = target.trim()
    ? `INSTRUCTION: ${instruction}\n\nTEXT:\n${target}`
    : `INSTRUCTION: ${instruction}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'Apply the spoken editing instruction to the user text. ' +
              'If TEXT is provided return only the edited text. ' +
              'If no TEXT is provided, fulfill the instruction directly. ' +
              'Output ONLY the resulting text, no preamble, no labels, no commentary.'
          },
          { role: 'user', content: userContent }
        ],
        temperature: 0,
        max_tokens: MAX_TOKENS
      }),
      signal: controller.signal
    })
    if (!res.ok) return ''
    const data = (await res.json()) as ChatResponse
    return data.choices?.[0]?.message?.content?.trim() || ''
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One-line theme summary of dictation transcripts for the daily digest.
 * Reuses the active provider; returns '' on no key / any error (never throws).
 */
export async function summarize(text: string, settings: OwenFlowSettings): Promise<string> {
  const { url, apiKey, model } = resolveProvider(settings, settings.cleanupProvider ?? 'groq')
  if (!apiKey || !text.trim()) return ''
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'Summarize the recurring themes of these dictation transcripts in one short line. Output only the summary.' },
          { role: 'user', content: text }
        ],
        temperature: 0,
        max_tokens: 200
      }),
      signal: controller.signal
    })
    if (!res.ok) return ''
    const data = (await res.json()) as ChatResponse
    return data.choices?.[0]?.message?.content?.trim() || ''
  } catch {
    return ''
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
  // No key fallback here: the benchmark must time the provider it names.
  const { url, apiKey, model } = resolveProvider(settings, provider, false)
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
