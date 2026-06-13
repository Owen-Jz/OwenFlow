# Fast Refinement (Groq provider) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OwenFlow's text-refinement pass fast by adding Groq (a non-reasoning, sub-second model) as the default cleanup provider, keep MiniMax selectable as the slow "max-polish" fallback, preserve the instant off-switch, and add a "Test & compare" button that times both providers head-to-head.

**Architecture:** `cleanup.ts` gains a tiny provider table. MiniMax (`chatcompletion_v2`) and Groq (OpenAI-compatible `/openai/v1/chat/completions`) are both OpenAI-shaped — `messages` in, `choices[0].message.content` out — so one request/parse path serves both; only the URL, key and model differ. `cleanup.ts` also exports `benchmarkProvider`/`benchmarkProviders` (forced-provider timing) surfaced to the renderer via a new `cleanup:benchmark` IPC channel. Provider + Groq key/model are new settings, shown in the existing "AI cleanup" settings card alongside the compare button. The per-mode system prompts and the never-throw/raw-fallback contract are unchanged.

**Tech Stack:** TypeScript, Electron (electron-vite), electron-store, Vitest. Commands run from `app/`.

**Spec:** `docs/superpowers/specs/2026-06-13-owenflow-fast-refinement-groq-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `app/src/shared/types.ts` | `CleanupProvider` + `ProviderTiming` types, settings fields, `cleanup:benchmark` IPC + API | Modify |
| `app/src/main/config.ts` | defaults + electron-store schema for the new fields | Modify |
| `app/src/main/cleanup.ts` | provider abstraction, provider-aware request, benchmark functions | Modify |
| `app/src/main/index.ts` | `cleanup:benchmark` IPC handler | Modify |
| `app/src/preload/index.ts` | expose `window.owenflow.cleanup.benchmark` | Modify |
| `app/src/renderer/settings.html` | provider select + Groq rows + Test & compare button | Modify |
| `app/src/renderer/src/settings.ts` | fill/read fields, show/hide rows, compare handler | Modify |
| `app/tests/config.test.ts` | assert new defaults + schema | Modify |
| `app/tests/cleanup.test.ts` | provider resolution + benchmark tests + fixture update | Modify |
| `app/tests/pipeline.test.ts` | fixture update (type only) | Modify |
| `app/README.md` | document the Groq provider | Modify |

---

## Task 1: Settings + benchmark types, config defaults & schema

**Files:**
- Modify: `app/src/shared/types.ts`
- Modify: `app/src/main/config.ts`
- Test: `app/tests/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `app/tests/config.test.ts`, inside a new `describe` after the existing one:

```ts
describe('config cleanup provider', () => {
  it('defaults cleanupProvider to groq', () => {
    expect(DEFAULT_SETTINGS.cleanupProvider).toBe('groq')
    expect(getSettings().cleanupProvider).toBe('groq')
  })

  it('defaults groqModel to llama-3.3-70b-versatile', () => {
    expect(DEFAULT_SETTINGS.groqModel).toBe('llama-3.3-70b-versatile')
    expect(DEFAULT_SETTINGS.groqApiKey).toBe('')
  })

  it('declares cleanupProvider schema as groq | minimax with groq default', () => {
    const schema = captured.options?.schema as Record<
      string,
      { enum?: string[]; default?: string }
    >
    expect(schema.cleanupProvider.enum).toEqual(['groq', 'minimax'])
    expect(schema.cleanupProvider.default).toBe('groq')
    expect(schema.groqModel.default).toBe('llama-3.3-70b-versatile')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- config`
Expected: FAIL — `cleanupProvider` is `undefined` / `schema.cleanupProvider` is undefined.

- [ ] **Step 3: Add the `CleanupProvider` + `ProviderTiming` types and settings fields**

In `app/src/shared/types.ts`, after the `WhisperModel` type declaration, add:

```ts
/** Which LLM backend runs the refinement/cleanup pass. */
export type CleanupProvider = 'groq' | 'minimax'

/** Result of timing one provider's refinement round-trip ("cleanup:benchmark"). */
export interface ProviderTiming {
  provider: CleanupProvider
  ok: boolean
  /** Round-trip milliseconds (0 when skipped for a missing key). */
  ms: number
  /** Present when ok is false: 'no API key', 'HTTP 429', an abort/network message, etc. */
  error?: string
}
```

Then in the `OwenFlowSettings` interface, replace this block:

```ts
  cleanupEnabled: boolean
  minimaxApiKey: string
  minimaxGroupId: string
```

with:

```ts
  cleanupEnabled: boolean
  /** Which LLM provider runs the cleanup/refinement pass. */
  cleanupProvider: CleanupProvider
  minimaxApiKey: string
  minimaxGroupId: string
  /** Groq API key (used when cleanupProvider === 'groq'). Stored locally only. */
  groqApiKey: string
  /** Groq model id, e.g. llama-3.3-70b-versatile or llama-3.1-8b-instant. */
  groqModel: string
```

- [ ] **Step 4: Add defaults and schema in `config.ts`**

In `app/src/main/config.ts`, in `DEFAULT_SETTINGS`, replace:

```ts
  cleanupEnabled: false,
  minimaxApiKey: '',
  minimaxGroupId: '',
```

with:

```ts
  cleanupEnabled: false,
  cleanupProvider: 'groq',
  minimaxApiKey: '',
  minimaxGroupId: '',
  groqApiKey: '',
  groqModel: 'llama-3.3-70b-versatile',
```

Then in the `schema` object, replace:

```ts
    cleanupEnabled: { type: 'boolean', default: false },
    minimaxApiKey: { type: 'string', default: '' },
    minimaxGroupId: { type: 'string', default: '' },
```

with:

```ts
    cleanupEnabled: { type: 'boolean', default: false },
    cleanupProvider: { type: 'string', enum: ['groq', 'minimax'], default: 'groq' },
    minimaxApiKey: { type: 'string', default: '' },
    minimaxGroupId: { type: 'string', default: '' },
    groqApiKey: { type: 'string', default: '' },
    groqModel: { type: 'string', default: 'llama-3.3-70b-versatile' },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- config`
Expected: PASS (all config tests, including the 3 new ones).

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/config.ts tests/config.test.ts
git commit -m "feat(owenflow): cleanupProvider + ProviderTiming + Groq settings"
```
(End the commit message with a trailing line: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.)

---

## Task 2: Provider abstraction + benchmark functions in cleanup.ts

**Files:**
- Modify: `app/src/main/cleanup.ts`
- Test: `app/tests/cleanup.test.ts`

- [ ] **Step 1: Update the test fixture and add provider + benchmark tests**

In `app/tests/cleanup.test.ts`, change the import line:

```ts
import { cleanup } from '../src/main/cleanup'
```

to:

```ts
import { benchmarkProvider, benchmarkProviders, cleanup } from '../src/main/cleanup'
```

Replace the `settings` helper so the new fields exist and existing MiniMax assertions stay valid (pin the helper to MiniMax):

```ts
const settings = (patch: Partial<OwenFlowSettings> = {}): OwenFlowSettings => ({
  hotkey: 'RightCtrl',
  mode: 'hold',
  flowMode: 'normal',
  model: 'small',
  language: '',
  cleanupEnabled: true,
  cleanupProvider: 'minimax',
  minimaxApiKey: 'test-key',
  minimaxGroupId: '',
  groqApiKey: 'groq-key',
  groqModel: 'llama-3.3-70b-versatile',
  launchOnStartup: false,
  theme: 'dark',
  ...patch
})
```

Then add these two `describe` blocks (place them after the `cleanupEnabled gating` block):

```ts
describe('provider selection', () => {
  it('groq provider hits the Groq endpoint with the groq key and model', async () => {
    fetchMock.mockResolvedValue(okResponse('Cleaned.'))
    await cleanup(RAW, settings({ cleanupProvider: 'groq', groqApiKey: 'gk' }))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(init.headers.Authorization).toBe('Bearer gk')
    expect(JSON.parse(init.body).model).toBe('llama-3.3-70b-versatile')
  })

  it('groq uses the configured groqModel when set', async () => {
    fetchMock.mockResolvedValue(okResponse('Cleaned.'))
    await cleanup(RAW, settings({ cleanupProvider: 'groq', groqModel: 'llama-3.1-8b-instant' }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('llama-3.1-8b-instant')
  })

  it('groq falls back to the default model when groqModel is empty', async () => {
    fetchMock.mockResolvedValue(okResponse('Cleaned.'))
    await cleanup(RAW, settings({ cleanupProvider: 'groq', groqModel: '' }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('llama-3.3-70b-versatile')
  })

  it('returns raw without fetching when groq is selected but groqApiKey is empty', async () => {
    await expect(
      cleanup(RAW, settings({ cleanupProvider: 'groq', groqApiKey: '' }))
    ).resolves.toBe(RAW)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('minimax provider still hits the MiniMax endpoint with the minimax key', async () => {
    fetchMock.mockResolvedValue(okResponse('Cleaned.'))
    await cleanup(RAW, settings({ cleanupProvider: 'minimax' }))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.minimax.io/v1/text/chatcompletion_v2')
    expect(init.headers.Authorization).toBe('Bearer test-key')
    expect(JSON.parse(init.body).model).toBe('MiniMax-M2.5')
  })
})

describe('benchmarkProvider', () => {
  it('returns ok timing for a provider with a key', async () => {
    fetchMock.mockResolvedValue(okResponse('done'))
    const r = await benchmarkProvider('groq', settings({ groqApiKey: 'gk' }))
    expect(r.provider).toBe('groq')
    expect(r.ok).toBe(true)
    expect(typeof r.ms).toBe('number')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(init.headers.Authorization).toBe('Bearer gk')
  })

  it('forces the requested provider regardless of cleanupProvider setting', async () => {
    fetchMock.mockResolvedValue(okResponse('done'))
    await benchmarkProvider('minimax', settings({ cleanupProvider: 'groq' }))
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.minimax.io/v1/text/chatcompletion_v2')
  })

  it('returns ok:false with "no API key" when the provider key is missing (no fetch)', async () => {
    const r = await benchmarkProvider('groq', settings({ groqApiKey: '' }))
    expect(r.ok).toBe(false)
    expect(r.error).toBe('no API key')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns ok:false on non-200 (never throws)', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 429 }))
    const r = await benchmarkProvider('groq', settings({ groqApiKey: 'gk' }))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('429')
  })
})

describe('benchmarkProviders', () => {
  it('times both providers', async () => {
    fetchMock.mockResolvedValue(okResponse('done'))
    const results = await benchmarkProviders(settings({ groqApiKey: 'gk', minimaxApiKey: 'mk' }))
    expect(results.map((r) => r.provider).sort()).toEqual(['groq', 'minimax'])
    expect(results.every((r) => r.ok)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- cleanup`
Expected: FAIL — `benchmarkProvider`/`benchmarkProviders` are not exported; groq tests hit the MiniMax URL.

- [ ] **Step 3: Rewrite `cleanup.ts` with the provider abstraction + benchmark**

Replace the **entire contents** of `app/src/main/cleanup.ts` with:

```ts
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
const SYSTEM_PROMPTS: Record<FlowMode, string> = {
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

export async function cleanup(raw: string, settings: OwenFlowSettings): Promise<string> {
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
          { role: 'system', content: SYSTEM_PROMPTS[mode] },
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
    await res.json()
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- cleanup`
Expected: PASS — all existing cleanup tests AND the new provider + benchmark tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/cleanup.ts tests/cleanup.test.ts
git commit -m "feat(owenflow): provider-aware cleanup + benchmark (Groq default)"
```

---

## Task 3: Fix pipeline test fixture (type-only)

**Files:**
- Test: `app/tests/pipeline.test.ts`

Adding required fields to `OwenFlowSettings` makes the `baseSettings` literal incomplete; fix it.

- [ ] **Step 1: Update the `baseSettings` fixture**

In `app/tests/pipeline.test.ts`, replace:

```ts
  cleanupEnabled: true,
  minimaxApiKey: 'key',
  minimaxGroupId: '',
```

with:

```ts
  cleanupEnabled: true,
  cleanupProvider: 'groq',
  minimaxApiKey: 'key',
  minimaxGroupId: '',
  groqApiKey: 'key',
  groqModel: 'llama-3.3-70b-versatile',
```

- [ ] **Step 2: Run the suite to verify it passes**

Run: `npm run test -- pipeline`
Expected: PASS (cleanup is a mocked dep here, so provider value is irrelevant to behavior).

- [ ] **Step 3: Commit**

```bash
git add tests/pipeline.test.ts
git commit -m "test(owenflow): extend pipeline fixture for new cleanup settings"
```

---

## Task 4: Benchmark IPC channel + preload + main handler

**Files:**
- Modify: `app/src/shared/types.ts`
- Modify: `app/src/main/index.ts`
- Modify: `app/src/preload/index.ts`

No new unit tests (IPC plumbing); verified by typecheck in Task 6 and the manual smoke test in Task 5.

- [ ] **Step 1: Add the IPC channel and API surface in `types.ts`**

In `app/src/shared/types.ts`, in the `OwenFlowApi` interface, find the `clipboard` member:

```ts
  clipboard: {
    /**
     * Copy text via main-process Electron clipboard ("clipboard:write").
     * navigator.clipboard is unavailable in the packaged file:// context.
     */
    write: (text: string) => Promise<boolean>
  }
```

and add a new `cleanup` member immediately after it (after the closing `}` of `clipboard`, add a comma then):

```ts
  cleanup: {
    /** Time both providers against a sample sentence ("cleanup:benchmark"). */
    benchmark: () => Promise<ProviderTiming[]>
  }
```

Then in the `IPC` const object, find:

```ts
  clipboardWrite: 'clipboard:write',
```

and add immediately after it:

```ts
  cleanupBenchmark: 'cleanup:benchmark',
```

- [ ] **Step 2: Register the main-process handler in `index.ts`**

In `app/src/main/index.ts`, add this import next to the other `./` imports (e.g. right after `import { clipboardWrite } from './clipboard'`):

```ts
import { benchmarkProviders } from './cleanup'
```

Then in `registerIpc()`, right after the `IPC.clipboardWrite` handler line, add:

```ts
  // Settings "Test & compare": time both refinement providers with saved keys.
  ipcMain.handle(IPC.cleanupBenchmark, () => benchmarkProviders(getSettings()))
```

- [ ] **Step 3: Expose it in the preload bridge**

In `app/src/preload/index.ts`, add `ProviderTiming` to the type import block (the `import type { ... } from '../shared/types'` list).

Then in the `api` object, after the `clipboard` member:

```ts
  clipboard: {
    write: (text: string): Promise<boolean> => ipcRenderer.invoke(IPC.clipboardWrite, text)
  },
```

add:

```ts
  cleanup: {
    benchmark: (): Promise<ProviderTiming[]> => ipcRenderer.invoke(IPC.cleanupBenchmark)
  },
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck:node`
Expected: PASS (main + preload + shared compile; `OwenFlowApi` is satisfied by preload).

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/main/index.ts src/preload/index.ts
git commit -m "feat(owenflow): cleanup:benchmark IPC channel + preload bridge"
```

---

## Task 5: Settings UI — provider select, Groq fields, Test & compare

**Files:**
- Modify: `app/src/renderer/settings.html`
- Modify: `app/src/renderer/src/settings.ts`

DOM wiring (not unit-tested in this project); verify via typecheck + build + a manual smoke test.

- [ ] **Step 1: Add the provider rows, Groq rows and compare row to the AI-cleanup card**

In `app/src/renderer/settings.html`, inside the `<div class="card">` whose `<h2>` is `AI cleanup`, locate `<div class="row" id="minimax-key-row">` and insert these rows **immediately before** it:

```html
              <div class="row">
                <label class="title" for="f-cleanup-provider">
                  Refinement engine
                  <span class="hint">Groq is fast (sub-second); MiniMax is slower but max-polish</span>
                </label>
                <select id="f-cleanup-provider">
                  <option value="groq">Groq (fast)</option>
                  <option value="minimax">MiniMax (polish)</option>
                </select>
              </div>
              <div class="row" id="groq-key-row">
                <label class="title" for="f-groq-key">
                  Groq API key
                  <span class="hint">Stored locally; free key at console.groq.com</span>
                </label>
                <input type="password" id="f-groq-key" spellcheck="false" />
              </div>
              <div class="row" id="groq-model-row">
                <label class="title" for="f-groq-model">
                  Groq model
                  <span class="hint">70b = best balance; 8b-instant = fastest</span>
                </label>
                <select id="f-groq-model">
                  <option value="llama-3.3-70b-versatile">llama-3.3-70b-versatile</option>
                  <option value="llama-3.1-8b-instant">llama-3.1-8b-instant</option>
                </select>
              </div>
```

Then locate `<div class="row" id="minimax-group-row">` … `</div>` (the MiniMax group row) and insert this compare row **immediately after** that row's closing `</div>`:

```html
              <div class="row">
                <label class="title">
                  Compare speed
                  <span class="hint">Times both providers with your saved keys — Save first</span>
                </label>
                <div style="text-align: right">
                  <button type="button" class="ghost" id="btn-compare">Test &amp; compare</button>
                  <div id="compare-result" class="hint" style="margin-top: 6px"></div>
                </div>
              </div>
```

- [ ] **Step 2: Add the `.row.hidden` CSS rule**

In `app/src/renderer/settings.html`, inside the `<style>` block, next to the existing `.actions.hidden` rule, add:

```css
      .row.hidden {
        display: none;
      }
```

- [ ] **Step 3: Add field refs in `settings.ts`**

In `app/src/renderer/src/settings.ts`, find:

```ts
const fMinimaxKey = $<HTMLInputElement>('f-minimax-key')
const fMinimaxGroup = $<HTMLInputElement>('f-minimax-group')
```

Replace it with:

```ts
const fCleanupProvider = $<HTMLSelectElement>('f-cleanup-provider')
const fMinimaxKey = $<HTMLInputElement>('f-minimax-key')
const fMinimaxGroup = $<HTMLInputElement>('f-minimax-group')
const fGroqKey = $<HTMLInputElement>('f-groq-key')
const fGroqModel = $<HTMLSelectElement>('f-groq-model')
const minimaxKeyRow = $('minimax-key-row')
const minimaxGroupRow = $('minimax-group-row')
const groqKeyRow = $('groq-key-row')
const groqModelRow = $('groq-model-row')
```

- [ ] **Step 4: Add the show/hide helper, the compare handler, and wire events**

In `app/src/renderer/src/settings.ts`, immediately after the refs block from Step 3, add:

```ts
/** Show only the active provider's credential rows. */
function applyProviderVisibility(): void {
  const groq = fCleanupProvider.value === 'groq'
  groqKeyRow.classList.toggle('hidden', !groq)
  groqModelRow.classList.toggle('hidden', !groq)
  minimaxKeyRow.classList.toggle('hidden', groq)
  minimaxGroupRow.classList.toggle('hidden', groq)
}

fCleanupProvider.addEventListener('change', applyProviderVisibility)

// "Test & compare": time both providers (uses saved keys) and show the result.
$('btn-compare').addEventListener('click', async () => {
  const result = $('compare-result')
  result.textContent = 'testing both providers…'
  try {
    const timings = await window.owenflow.cleanup.benchmark()
    result.textContent = timings
      .map((t) => `${t.provider}: ${t.ok ? `${(t.ms / 1000).toFixed(1)}s` : t.error}`)
      .join('  ·  ')
  } catch {
    result.textContent = 'compare failed'
  }
})
```

- [ ] **Step 5: Populate the fields in `fillForm`**

In `app/src/renderer/src/settings.ts`, in `fillForm`, replace:

```ts
  fMinimaxKey.value = s.minimaxApiKey
  fMinimaxGroup.value = s.minimaxGroupId
```

with:

```ts
  fCleanupProvider.value = s.cleanupProvider ?? 'groq'
  fMinimaxKey.value = s.minimaxApiKey
  fMinimaxGroup.value = s.minimaxGroupId
  fGroqKey.value = s.groqApiKey
  fGroqModel.value = s.groqModel || 'llama-3.3-70b-versatile'
  applyProviderVisibility()
```

- [ ] **Step 6: Read the fields in `readForm`**

In `app/src/renderer/src/settings.ts`, in `readForm`, replace:

```ts
    minimaxApiKey: fMinimaxKey.value.trim(),
    minimaxGroupId: fMinimaxGroup.value.trim(),
```

with:

```ts
    cleanupProvider: fCleanupProvider.value === 'minimax' ? 'minimax' : 'groq',
    minimaxApiKey: fMinimaxKey.value.trim(),
    minimaxGroupId: fMinimaxGroup.value.trim(),
    groqApiKey: fGroqKey.value.trim(),
    groqModel: fGroqModel.value,
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS (node + web).

- [ ] **Step 8: Manual smoke test**

Run: `npm run dev`
Then open Settings → Modes section. Verify:
- "Refinement engine" defaults to **Groq (fast)**; Groq key + model rows visible; MiniMax key/group rows hidden.
- Switching to **MiniMax (polish)** hides Groq rows, shows MiniMax rows.
- Paste a Groq key, click **Save settings**, reopen Settings → provider, key and model persist.
- Click **Test & compare** → result line shows each provider's time or "no API key"/error (e.g. `groq: 0.7s  ·  minimax: no API key`).

- [ ] **Step 9: Commit**

```bash
git add src/renderer/settings.html src/renderer/src/settings.ts
git commit -m "feat(owenflow): settings UI for provider + Groq key/model + compare"
```

---

## Task 6: Docs + full verification

**Files:**
- Modify: `app/README.md`

- [ ] **Step 1: Update the README cleanup row**

In `app/README.md`, in the "Customizing" table, replace the row:

```
| Cleanup prompt / provider | `app/src/main/cleanup.ts` |
```

with:

```
| Refinement provider (Groq default / MiniMax) | Settings → Modes, or `app/src/main/cleanup.ts` |
```

If that exact row text differs, update the nearest cleanup/provider row to the same effect. Also, in the **Usage → Cleanup** bullet, append: "Refinement defaults to **Groq** (`llama-3.3-70b-versatile`, sub-second); add a Groq API key in Settings. MiniMax remains selectable as a slower max-polish option, and a **Test & compare** button times both."

- [ ] **Step 2: Run the full test suite**

Run: `npm run test`
Expected: PASS — entire suite green.

- [ ] **Step 3: Typecheck + build**

Run: `npm run build`
Expected: typecheck passes and the electron-vite build completes with no errors.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(owenflow): document Groq refinement provider + compare"
```

---

## Self-Review Notes (resolved)

- **Spec coverage:** provider abstraction (Task 2), settings + schema + `ProviderTiming` type (Task 1), benchmark functions (Task 2), benchmark IPC/preload/handler (Task 4), Settings UI with provider select + show/hide + Test & compare (Task 5), off-switch + raw fallback preserved (unchanged gating in Task 2), Groq default (Task 1) — all covered.
- **Type/ordering safety:** `ProviderTiming` is defined in Task 1 so Task 2's `cleanup.ts` import resolves; `OwenFlowApi.cleanup` is added together with its preload implementation (Task 4) so the interface is never unsatisfied across tasks.
- **Fixture breakage:** both `cleanup.test.ts` (Task 2) and `pipeline.test.ts` (Task 3) fixtures gain the new required fields; the cleanup helper is pinned to `minimax` so pre-existing MiniMax assertions stay valid. (Full `npm run typecheck` is deferred to Task 6, after all fixtures are fixed; earlier per-file vitest runs are unaffected.)
- **Type consistency:** `CleanupProvider = 'groq' | 'minimax'` used identically across types, config schema enum, `cleanup.ts`, `readForm`, and `benchmarkProvider`. Model ids match across config default, `PROVIDERS.groq.defaultModel`, and the HTML `<option>` values. `resolveProvider(settings, name)` signature is consistent between `cleanup()` and `benchmarkProvider()`.
- **No new prompt content:** the `SYSTEM_PROMPTS` block is reproduced verbatim from the current file.
- **Security:** Groq key lives only in electron-store + masked `password` input; never logged (the warn logs `model`, not the key; benchmark logs nothing).
```
