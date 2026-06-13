# OwenFlow Batch A (QoL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship three pipeline-level quality-of-life features: (#5) voice snippets/macros, (#10) local translation mode, (#9) speaker-tone per session.

**Architecture:** Two new pure modules (`snippets.ts`, `sessions.ts`) hold all matching/parse logic (unit-tested, no electron). `cleanup.ts` gains a dynamic translate prompt. `pipeline.ts` gains a snippet short-circuit + session-mode override + session auto-tag. Settings/tray expose configuration. No new IPC channels (tray runs in main, calls `setSettings` directly).

**Tech Stack:** TypeScript, Electron (electron-vite), electron-store, Vitest. All commands run from `app/` (`C:\Users\owen\Downloads\OwenFlow\app`).

**Spec:** `docs/superpowers/specs/2026-06-13-owenflow-batch-a-qol-design.md`

---

## File Structure

| File | Change |
|---|---|
| `app/src/shared/types.ts` | `FlowMode` += `translate`; 4 new `OwenFlowSettings` fields; `TrayCallbacks` += session methods |
| `app/src/main/config.ts` | defaults + schema for new fields; flowMode enum += translate |
| `app/src/main/snippets.ts` | NEW pure module: parse + whole-utterance match |
| `app/src/main/sessions.ts` | NEW pure module: parse label⇒mode + active lookup |
| `app/src/main/cleanup.ts` | dynamic `systemPromptFor(mode, settings)` incl. translate |
| `app/src/main/pipeline.ts` | snippet short-circuit + session mode override + auto-tag |
| `app/src/main/tray.ts` | translate label + Session submenu + callbacks |
| `app/src/main/index.ts` | wire new tray callbacks + refresh on session settings change |
| `app/src/renderer/settings.html` | Translate card + target row; Snippets card; Sessions card |
| `app/src/renderer/src/settings.ts` | refs + fill/read + translate-target show/hide |
| tests: `snippets.test.ts`, `sessions.test.ts`, `cleanup.test.ts`, `pipeline.test.ts`, `config.test.ts` | new + extended |

---

## Task 1: Types + config (settings + translate flow mode)

**Files:** `src/shared/types.ts`, `src/main/config.ts`, `tests/config.test.ts`

- [ ] **Step 1 — failing config test.** Add to `tests/config.test.ts` a new describe:

```ts
describe('config batch-A settings', () => {
  it('declares new defaults', () => {
    expect(DEFAULT_SETTINGS.snippets).toEqual([])
    expect(DEFAULT_SETTINGS.translateTarget).toBe('English')
    expect(DEFAULT_SETTINGS.sessionTones).toEqual([])
    expect(DEFAULT_SETTINGS.activeSession).toBe('')
  })

  it('flowMode schema includes translate', () => {
    const schema = captured.options?.schema as Record<string, { enum?: string[] }>
    expect(schema.flowMode.enum).toEqual(['normal', 'vibe', 'formal', 'translate'])
  })
})
```

- [ ] **Step 2 — run, expect FAIL.** `npm run test -- config`

- [ ] **Step 3 — types.** In `src/shared/types.ts`:
  - Change `export type FlowMode = 'normal' | 'vibe' | 'formal'` to `export type FlowMode = 'normal' | 'vibe' | 'formal' | 'translate'` and add `translate` to the doc comment list.
  - In `OwenFlowSettings`, after the `dictionary: string[]` field block, add:

```ts
  /** Voice snippets: "trigger => expansion" per line; matched whole-utterance, pasted verbatim. */
  snippets: string[]
  /** Target language for the Translate flow mode (e.g. "English", "Spanish"). */
  translateTarget: string
  /** Session tones: "label => mode" per line (mode in normal|vibe|formal|translate). */
  sessionTones: string[]
  /** Active session label ('' = none); maps to a tone via sessionTones and auto-tags history. */
  activeSession: string
```

- [ ] **Step 4 — config.** In `src/main/config.ts` `DEFAULT_SETTINGS`, after `dictionary: [],` add:

```ts
  snippets: [],
  translateTarget: 'English',
  sessionTones: [],
  activeSession: '',
```

In the `schema`, change the flowMode line to:

```ts
    flowMode: { type: 'string', enum: ['normal', 'vibe', 'formal', 'translate'], default: 'normal' },
```

and after the `dictionary` schema line add:

```ts
    snippets: { type: 'array', items: { type: 'string' }, default: [] },
    translateTarget: { type: 'string', default: 'English' },
    sessionTones: { type: 'array', items: { type: 'string' }, default: [] },
    activeSession: { type: 'string', default: '' },
```

- [ ] **Step 5 — run, expect PASS.** `npm run test -- config`
- [ ] **Step 6 — commit.** `git add src/shared/types.ts src/main/config.ts tests/config.test.ts` →
`feat: batch-A settings + translate flow mode` (+ Co-Authored-By trailer).

---

## Task 2: Pure modules — snippets.ts + sessions.ts (TDD)

**Files:** create `src/main/snippets.ts`, `src/main/sessions.ts`; create `tests/snippets.test.ts`, `tests/sessions.test.ts`

- [ ] **Step 1 — failing tests.** Create `tests/snippets.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseSnippets, matchSnippet } from '../src/main/snippets'

describe('parseSnippets', () => {
  it('parses trigger => expansion and converts \\n', () => {
    expect(parseSnippets(['sign off=>Best,\\nOwen'])).toEqual([
      { trigger: 'sign off', expansion: 'Best,\nOwen' }
    ])
  })
  it('skips blank and malformed lines', () => {
    expect(parseSnippets(['', '   ', 'noarrow', '=>x', 'a=>b'])).toEqual([
      { trigger: 'a', expansion: 'b' }
    ])
  })
})

describe('matchSnippet', () => {
  const snips = parseSnippets(['my address=>10 Main St', 'sign off=>Best,\\nOwen'])
  it('matches whole utterance case-insensitively', () => {
    expect(matchSnippet('My Address', snips)).toBe('10 Main St')
  })
  it('tolerates trailing sentence punctuation/whitespace', () => {
    expect(matchSnippet('  sign off.  ', snips)).toBe('Best,\nOwen')
  })
  it('returns null when no whole-utterance match (substring is not enough)', () => {
    expect(matchSnippet('please sign off now', snips)).toBeNull()
    expect(matchSnippet('', snips)).toBeNull()
  })
})
```

Create `tests/sessions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseSessionTones, activeSessionMode } from '../src/main/sessions'

describe('parseSessionTones', () => {
  it('parses label => mode and drops invalid modes', () => {
    expect(parseSessionTones(['client => formal', 'notes=>normal', 'bad=>nope', 'x=>vibe'])).toEqual([
      { label: 'client', mode: 'formal' },
      { label: 'notes', mode: 'normal' },
      { label: 'x', mode: 'vibe' }
    ])
  })
})

describe('activeSessionMode', () => {
  const tones = parseSessionTones(['client => formal', 'notes => normal'])
  it('looks up case-insensitively', () => {
    expect(activeSessionMode('Client', tones)).toBe('formal')
  })
  it('returns null for none/unmapped', () => {
    expect(activeSessionMode('', tones)).toBeNull()
    expect(activeSessionMode('unknown', tones)).toBeNull()
  })
})
```

- [ ] **Step 2 — run, expect FAIL.** `npm run test -- snippets sessions`

- [ ] **Step 3 — implement `src/main/snippets.ts`:**

```ts
/**
 * Voice snippets/macros: a spoken trigger expands to canned text, pasted
 * verbatim (no cleanup). Pure module (no electron) so the pipeline + tests
 * use it directly. Format reuses the dictionary's "trigger => expansion".
 */

export interface Snippet {
  trigger: string
  expansion: string
}

/** Parse "trigger => expansion" lines; \n in the expansion becomes a newline. */
export function parseSnippets(lines: string[]): Snippet[] {
  const out: Snippet[] = []
  for (const raw of lines) {
    const entry = raw.trim()
    if (!entry) continue
    const idx = entry.indexOf('=>')
    if (idx <= 0) continue
    const trigger = entry.slice(0, idx).trim()
    const expansion = entry.slice(idx + 2).trim().replace(/\\n/g, '\n')
    if (trigger) out.push({ trigger, expansion })
  }
  return out
}

/** Normalize for whole-utterance comparison: trim, drop trailing . ! ?, lowercase. */
function normalize(text: string): string {
  return text.trim().replace(/[.!?]+$/, '').trim().toLowerCase()
}

/**
 * If the whole transcript equals a snippet trigger (case-insensitive, trailing
 * sentence punctuation tolerated), return its expansion; else null.
 */
export function matchSnippet(transcript: string, snippets: Snippet[]): string | null {
  const key = normalize(transcript)
  if (!key) return null
  for (const s of snippets) {
    if (normalize(s.trigger) === key) return s.expansion
  }
  return null
}
```

- [ ] **Step 4 — implement `src/main/sessions.ts`:**

```ts
/**
 * Session tones: an active "session" label maps to a flow mode and auto-tags
 * dictations. Pure module (no electron). Format: "label => mode".
 */

import type { FlowMode } from '../shared/types'

export interface SessionTone {
  label: string
  mode: FlowMode
}

const VALID_MODES: readonly FlowMode[] = ['normal', 'vibe', 'formal', 'translate']

function isFlowMode(s: string): s is FlowMode {
  return (VALID_MODES as readonly string[]).includes(s)
}

/** Parse "label => mode" lines; entries with an unknown mode are dropped. */
export function parseSessionTones(lines: string[]): SessionTone[] {
  const out: SessionTone[] = []
  for (const raw of lines) {
    const entry = raw.trim()
    if (!entry) continue
    const idx = entry.indexOf('=>')
    if (idx <= 0) continue
    const label = entry.slice(0, idx).trim()
    const mode = entry.slice(idx + 2).trim().toLowerCase()
    if (label && isFlowMode(mode)) out.push({ label, mode })
  }
  return out
}

/** The flow mode for the active session label (case-insensitive), or null. */
export function activeSessionMode(activeLabel: string, tones: SessionTone[]): FlowMode | null {
  const key = activeLabel.trim().toLowerCase()
  if (!key) return null
  for (const t of tones) {
    if (t.label.toLowerCase() === key) return t.mode
  }
  return null
}
```

- [ ] **Step 5 — run, expect PASS.** `npm run test -- snippets sessions`
- [ ] **Step 6 — commit.** `git add src/main/snippets.ts src/main/sessions.ts tests/snippets.test.ts tests/sessions.test.ts` → `feat: snippets + sessions pure modules`.

---

## Task 3: Translate prompt in cleanup.ts

**Files:** `src/main/cleanup.ts`, `tests/cleanup.test.ts`

- [ ] **Step 1 — failing tests.** In `tests/cleanup.test.ts`, the `settings()` helper already exists — it must include the new required fields or TS object literals break. Add to the returned object: `snippets: [], translateTarget: 'English', sessionTones: [], activeSession: ''`. Then add:

```ts
describe('translate mode', () => {
  it('builds a translate prompt with the configured target and routes to the provider', async () => {
    fetchMock.mockResolvedValue(okResponse('Hola mundo'))
    await cleanup('hello world', settings({ flowMode: 'translate', translateTarget: 'Spanish', cleanupProvider: 'groq', groqApiKey: 'gk' }))
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].content).toContain('Spanish')
    expect(body.messages[0].content.toLowerCase()).toContain('translate')
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions')
  })
  it('defaults the target to English when translateTarget is empty', async () => {
    fetchMock.mockResolvedValue(okResponse('x'))
    await cleanup('hola', settings({ flowMode: 'translate', translateTarget: '', cleanupProvider: 'groq', groqApiKey: 'gk' }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content).toContain('English')
  })
  it('translates even a short transcript (no ≤3-word skip)', async () => {
    fetchMock.mockResolvedValue(okResponse('Hola'))
    await cleanup('hello', settings({ flowMode: 'translate', cleanupProvider: 'groq', groqApiKey: 'gk' }))
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2 — run, expect FAIL.** `npm run test -- cleanup`

- [ ] **Step 3 — implement.** In `src/main/cleanup.ts`, add a helper above `cleanup()`:

```ts
/** The system prompt for a mode; translate is dynamic (depends on target). */
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
```

Then in `cleanup()`, change the message system content from `SYSTEM_PROMPTS[mode]` to `systemPromptFor(mode, settings)`. (The existing gating already lets non-normal modes through without the cleanupEnabled check and without the ≤3-word skip, so translate runs whenever the provider key is set.)

NOTE: `SYSTEM_PROMPTS` is typed `Record<FlowMode, string>`; adding `translate` to `FlowMode` makes TS require a `translate` entry. To avoid an unused static entry, change the type of `SYSTEM_PROMPTS` to `Record<Exclude<FlowMode, 'translate'>, string>`. Verify `npm run typecheck:node` passes after this.

- [ ] **Step 4 — run, expect PASS.** `npm run test -- cleanup`
- [ ] **Step 5 — commit.** `git add src/main/cleanup.ts tests/cleanup.test.ts` → `feat: translate flow mode in cleanup`.

---

## Task 4: Pipeline integration (snippet short-circuit + session mode + auto-tag)

**Files:** `src/main/pipeline.ts`, `tests/pipeline.test.ts`

- [ ] **Step 1 — failing tests.** In `tests/pipeline.test.ts`: add the four new fields to `baseSettings` (`snippets: [], translateTarget: 'English', sessionTones: [], activeSession: ''`). Then add:

```ts
it('snippet match short-circuits: injects expansion verbatim, no cleanup/dictionary', async () => {
  const order: string[] = []
  const deps = makeDeps(
    baseSettings({ snippets: ['sign off=>Best,\\nOwen'], dictionary: ['Owen=>OWEN'] }),
    order
  )
  deps.transcribe.mockResolvedValue({ text: 'sign off', durationMs: 10 })
  await runDictation(deps)
  expect(deps.cleanup).not.toHaveBeenCalled()
  expect(deps.inject).toHaveBeenCalledWith('Best,\nOwen') // dictionary NOT applied
})

it('active session overrides flow mode and auto-tags history', async () => {
  const order: string[] = []
  const settings = baseSettings({
    flowMode: 'normal',
    cleanupEnabled: false,
    sessionTones: ['client=>formal'],
    activeSession: 'client'
  })
  const deps = makeDeps(settings, order)
  deps.transcribe.mockResolvedValue({ text: 'please review the attached', durationMs: 10 })
  await runDictation(deps)
  // formal mode → cleanup runs even though cleanupEnabled is false
  expect(deps.cleanup).toHaveBeenCalledTimes(1)
  const passedSettings = deps.cleanup.mock.calls[0][1]
  expect(passedSettings.flowMode).toBe('formal')
  const entry = deps.appendHistory.mock.calls.at(-1)[0]
  expect(entry.tags).toContain('client')
})
```

(Check the existing `makeDeps`/`runDictation` helpers and the transcribe mock shape; adapt the mock calls to match how other tests in the file drive a dictation. If `deps.transcribe` is set up differently, follow the file's existing pattern to control the transcript text.)

- [ ] **Step 2 — run, expect FAIL.** `npm run test -- pipeline`

- [ ] **Step 3 — implement in `src/main/pipeline.ts`.** Add imports at top:

```ts
import { matchSnippet, parseSnippets } from './snippets'
import { parseSessionTones, activeSessionMode } from './sessions'
```

In `stopDictation`, after the empty-check block (`if (!raw) { … }`) and BEFORE the cleanup block, insert the snippet short-circuit:

```ts
  // 2b. Voice snippet: whole-utterance trigger → paste expansion verbatim
  //     (skip cleanup AND dictionary; canned text must not be rewritten).
  const snippetText = matchSnippet(raw, parseSnippets(settings.snippets))
  if (snippetText !== null) {
    try {
      if (!deps.inject) throw new Error('Injector unavailable')
      await deps.inject(snippetText)
    } catch (err) {
      if (gen !== generation) return
      processing = false
      appendEntry(raw, snippetText, startedAt, settings.flowMode, sessionTag(settings))
      failPill(err instanceof Error ? err.message : 'Paste failed')
      return
    }
    if (gen !== generation) return
    processing = false
    appendEntry(raw, snippetText, startedAt, settings.flowMode, sessionTag(settings))
    deps.setPillState({ state: 'done' })
    scheduleHide(1200)
    return
  }
```

Replace the cleanup block's effective-mode handling: compute the session-effective mode and pass modified settings to cleanup. Change:

```ts
  let cleaned = raw
  const wantsCleanup = settings.flowMode !== 'normal' || settings.cleanupEnabled
  if (wantsCleanup && deps.cleanup) {
    try {
      cleaned = (await deps.cleanup(raw, settings)) || raw
    } catch {
      cleaned = raw
    }
    if (gen !== generation) return
  }
```

to:

```ts
  const sessionMode = activeSessionMode(settings.activeSession, parseSessionTones(settings.sessionTones))
  const effective = sessionMode ? { ...settings, flowMode: sessionMode } : settings
  let cleaned = raw
  const wantsCleanup = effective.flowMode !== 'normal' || effective.cleanupEnabled
  if (wantsCleanup && deps.cleanup) {
    try {
      cleaned = (await deps.cleanup(raw, effective)) || raw
    } catch {
      cleaned = raw
    }
    if (gen !== generation) return
  }
```

Update both `appendEntry(raw, final, startedAt, settings.flowMode)` calls (success + inject-failure paths) to `appendEntry(raw, final, startedAt, effective.flowMode, sessionTag(settings))`.

Update the `appendEntry` helper signature + a `sessionTag` helper:

```ts
function sessionTag(settings: OwenFlowSettings): string[] {
  const label = settings.activeSession?.trim()
  return label ? [label.toLowerCase().replace(/\s+/g, '-')] : []
}

function appendEntry(
  raw: string,
  final: string,
  startedAt: number,
  mode: string,
  tags: string[] = []
): void {
  const ts = Date.now()
  deps?.appendHistory({ ts, raw, final, durationMs: ts - startedAt, tags, mode })
}
```

(Import `OwenFlowSettings` type if not already imported in pipeline.ts.)

- [ ] **Step 4 — run, expect PASS.** `npm run test -- pipeline` (and `npm run test` to confirm no regressions).
- [ ] **Step 5 — commit.** `git add src/main/pipeline.ts tests/pipeline.test.ts` → `feat: pipeline snippet short-circuit + session mode/auto-tag`.

---

## Task 5: Tray — translate label + Session submenu

**Files:** `src/main/tray.ts`, `src/main/index.ts`

- [ ] **Step 1 — tray.ts.** Add `{ value: 'translate', label: 'Translate' }` to `FLOW_MODE_LABELS`. Extend `TrayCallbacks` with:

```ts
  /** Configured session labels (from sessionTones), for the Session submenu. */
  getSessions: () => string[]
  getActiveSession: () => string
  onSetActiveSession: (label: string) => void
```

In `rebuildMenu`, add a **Session** submenu after the Mode submenu (before the next separator):

```ts
      {
        label: 'Session',
        submenu: [
          {
            label: 'None',
            type: 'radio' as const,
            checked: !callbacks.getActiveSession(),
            click: () => callbacks.onSetActiveSession('')
          },
          ...callbacks.getSessions().map((label) => ({
            label,
            type: 'radio' as const,
            checked: callbacks.getActiveSession() === label,
            click: () => callbacks.onSetActiveSession(label)
          }))
        ]
      },
```

- [ ] **Step 2 — index.ts.** Import the sessions parser: `import { parseSessionTones } from './sessions'`. In the `createTray({ … })` call, add the three callbacks:

```ts
    getSessions: () => parseSessionTones(getSettings().sessionTones).map((t) => t.label),
    getActiveSession: () => getSettings().activeSession,
    onSetActiveSession: (label) => {
      setSettings({ activeSession: label })
    },
```

In the existing `onSettingsChange((next, prev) => { … })` handler, extend the tray-refresh condition so the Session submenu updates when sessions change. Add:

```ts
    if (next.activeSession !== prev.activeSession ||
        next.sessionTones.join('\n') !== prev.sessionTones.join('\n')) {
      refreshTrayMenu()
    }
```

- [ ] **Step 3 — verify.** `npm run typecheck:node` (PASS). `npm run build`.
- [ ] **Step 4 — commit.** `git add src/main/tray.ts src/main/index.ts` → `feat: tray translate mode + Session picker`.

---

## Task 6: Settings UI — Translate card+target, Snippets, Sessions

**Files:** `src/renderer/settings.html`, `src/renderer/src/settings.ts`

- [ ] **Step 1 — settings.html.**
  1. **Translate mode card** — in the `.mode-grid` (`#mode-grid`), after the `data-flow-mode="formal"` card, add:

```html
                <button type="button" class="mode-card" data-flow-mode="translate">
                  <span class="mode-tag"></span>
                  <span class="mode-name">Translate</span>
                  <span class="mode-desc">transcribes, then translates to your target language</span>
                </button>
```

  2. **Translate target row** — inside the "AI cleanup" card (or a new card on the Modes page), add a row that the renderer shows only in translate mode:

```html
              <div class="row" id="translate-target-row">
                <label class="title" for="f-translate-target">
                  Translate to
                  <span class="hint">Target language for Translate mode (e.g. English, Spanish)</span>
                </label>
                <input type="text" id="f-translate-target" spellcheck="false" />
              </div>
```

  3. **Snippets card** — on the Dictionary page (`#page-dictionary`), after the existing dictionary card, add:

```html
            <div class="card">
              <h2>Snippets</h2>
              <label class="hint" for="f-snippets" style="margin-bottom: 8px">
                One <b>trigger=&gt;expansion</b> per line. Say the trigger alone and the expansion is
                pasted verbatim (skips AI cleanup). Use <b>\n</b> for line breaks.
              </label>
              <textarea id="f-snippets" spellcheck="false" placeholder="sign off email=>Best,\nOwen&#10;my address=>10 Main St, Lagos"></textarea>
            </div>
```

  4. **Sessions card** — also on the Dictionary page (or Modes page), add:

```html
            <div class="card">
              <h2>Sessions</h2>
              <label class="hint" for="f-session-tones" style="margin-bottom: 8px">
                One <b>label=&gt;mode</b> per line (mode: normal, vibe, formal, translate). Pick the
                active session from the tray; its tone is used and dictations are tagged with the label.
              </label>
              <textarea id="f-session-tones" spellcheck="false" placeholder="client=>formal&#10;notes=>normal"></textarea>
            </div>
```

- [ ] **Step 2 — settings.ts refs + show/hide.** Add refs near the other `f*` refs:

```ts
const fTranslateTarget = $<HTMLInputElement>('f-translate-target')
const translateTargetRow = $('translate-target-row')
const fSnippets = $<HTMLTextAreaElement>('f-snippets')
const fSessionTones = $<HTMLTextAreaElement>('f-session-tones')
```

Extend `selectFlowMode` to toggle the translate-target row:

```ts
function selectFlowMode(mode: FlowMode): void {
  selectedFlowMode = mode
  for (const card of modeCards) {
    card.classList.toggle('selected', card.dataset.flowMode === mode)
  }
  translateTargetRow.classList.toggle('hidden', mode !== 'translate')
}
```

- [ ] **Step 3 — fillForm / readForm.** In `fillForm`, add:

```ts
  fTranslateTarget.value = s.translateTarget || 'English'
  fSnippets.value = s.snippets.join('\n')
  fSessionTones.value = s.sessionTones.join('\n')
```

(`selectFlowMode` is already called at the end of `fillForm`, so the translate row visibility resolves there.)

In `readForm`, add to the returned object:

```ts
    translateTarget: fTranslateTarget.value.trim() || 'English',
    snippets: fSnippets.value.split('\n').map((l) => l.trim()).filter(Boolean),
    sessionTones: fSessionTones.value.split('\n').map((l) => l.trim()).filter(Boolean),
```

(Note: `activeSession` is NOT written from the settings form — the tray owns it. `readForm` must not include `activeSession`, so a Save won't clobber the tray's selection.)

- [ ] **Step 4 — verify.** `npm run typecheck` (node + web) PASS; `npm run build` PASS.
- [ ] **Step 5 — manual smoke (human).** Modes shows a Translate card; selecting it reveals "Translate to"; Dictionary page shows Snippets + Sessions textareas; Save persists; tray Session submenu lists configured labels.
- [ ] **Step 6 — commit.** `git add src/renderer/settings.html src/renderer/src/settings.ts` → `feat: settings UI for translate/snippets/sessions`.

---

## Task 7: Docs + full verification

**Files:** `README.md`

- [ ] **Step 1 — README.** Add to the Usage section bullets:
  - "**Snippets:** say a trigger ("sign off email") to paste a saved expansion verbatim — configure in Settings → Dictionary."
  - "**Translate mode:** a flow mode that transcribes any language and pastes a translation into your target language."
  - "**Sessions:** pick a session from the tray (client/notes/…) to auto-apply a tone and tag dictations."
- [ ] **Step 2 — full suite.** `npm run test` (all green; report counts).
- [ ] **Step 3 — build.** `npm run build` (typecheck node+web + bundles, no errors).
- [ ] **Step 4 — commit.** `git add README.md` → `docs: document snippets/translate/sessions`.

---

## Self-Review Notes (resolved)

- **Spec coverage:** #5 (snippets.ts + pipeline short-circuit + UI), #10 (translate FlowMode + cleanup prompt + UI + tray), #9 (sessions.ts + pipeline override/auto-tag + tray picker + UI) — all covered.
- **Type ordering:** `FlowMode += translate` (Task 1) lands before `sessions.ts`/`cleanup.ts` consume it. `SYSTEM_PROMPTS` retyped to `Exclude<FlowMode,'translate'>` so no dead static entry is required.
- **Fixtures:** `cleanup.test.ts`, `pipeline.test.ts`, and the production `DEFAULT_SETTINGS` all gain the 4 new fields; `config.test.ts` covers defaults + the translate enum.
- **No clobber:** `readForm` intentionally omits `activeSession` (tray-owned); the snippet path skips cleanup AND dictionary; session tag normalized like other tags.
- **Safety:** new modules pure/total; translate falls back to English; unknown session/mode falls back to global mode.
