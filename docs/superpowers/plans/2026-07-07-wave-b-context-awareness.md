# Wave B: Context Awareness + Editor Symbol Biasing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dictation context-aware — read the focused app's editable text and (in browsers) the URL via Windows UI Automation so cleanup spells on-screen names right and continues the current sentence; and in code editors, read visible identifiers so Whisper transcribes them correctly ("user I.D." → `userId`).

**Architecture:** A new `uia.ts` module extends the existing persistent PowerShell helper pattern (a second helper that loads `UIAutomationClient`/`UIAutomationTypes` once, then answers read requests line-by-line). Two consumers: (1) editor symbols are read at dictation **start** (focused editor known then) and folded into the Whisper bias prompt at stop, behind a short await cap; (2) focus context (surrounding field text + browser URL) is read at **stop** in parallel with transcription and folded into the cleanup system prompt. Everything is best-effort and never-throws: no UIA, no window, an unreadable app → empty result → today's behavior unchanged. A single `contextAwareness` setting gates both, shipped **OFF by default** (Owen opts in — reading the focused field can surface on-screen text the user didn't dictate, and the cleanup snippet leaves the machine, so it stays opt-in).

**Tech Stack:** Electron 39 main (TypeScript strict), a persistent `powershell -NoProfile -Command -` helper loading the managed UIAutomation API (`[System.Windows.Automation.AutomationElement]`), vitest.

## De-risk results (verified on this machine 2026-07-07, keep for reference)

- Notepad focused field via `AutomationElement.FocusedElement` → `TextPattern`/`ValuePattern` returned the field text. ✅
- Chrome address bar via a descendants tree-walk for the `Edit` control named "Address and search bar" → returned the full URL in ~110ms. ✅
- Conclusion: focused-field read + browser-URL read both work; reads cost ~100–300ms (acceptable off the hot path / behind caps); degrade cleanly where a11y is unavailable.

## Global Constraints

- Repo: `C:\Users\owen\Downloads\OwenFlow`, branch `main`, baseline v1.10.0 (433 vitest green).
- Never-throw / never-block: every UIA read returns a best-effort result or empty; a UIA failure or timeout must NEVER delay a paste or reject the dictation pipeline. The dictation hot path may wait on an editor-symbol read only behind an explicit short cap (250ms) and only when already warm.
- Windows-only APIs acceptable. Follow the existing `injector.ts` persistent-helper pattern (Add-Type/assembly load once → line-per-request → FIFO waiters → lazy respawn on exit).
- TypeScript strict; heavily-commented "why" style. `npm run typecheck` clean.
- Tests: `cd C:\Users\owen\Downloads\OwenFlow\app; npx vitest run` — full suite green before every commit. UIA glue itself is untestable in vitest (no Windows automation host); all extractable pure logic (identifier extraction, context compaction, URL→site, reply parsing) MUST be unit-tested.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Ship (`git -c credential.helper="!gh auth git-credential" push origin main` — plain push hangs on this machine).

---

### Task 1: Pure text helpers (identifiers, context compaction, site)

The parsing logic that turns raw UIA reads into prompt-ready strings. Pure, fully testable, no Electron.

**Files:**
- Create: `app/src/main/uia-parse.ts`
- Test: `app/tests/uia-parse.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `extractIdentifiers(text: string, max?: number): string[]` — code identifiers worth biasing Whisper toward: camelCase, snake_case, PascalCase, dotted (`foo.bar`), and multi-char ALLCAPS; dedup preserving first-seen order; drop plain lowercase dictionary words and tokens < 3 chars; cap at `max` (default 40) longest-first-then-order.
  - `siteFromUrl(url: string): string | null` — the registrable-ish host label for tone context: `https://mail.google.com/...` → `mail.google.com`; strips scheme, path, query, `www.`; null for empty/garbage.
  - `compactContext(fieldText: string, max?: number): string` — trim + collapse whitespace, keep the LAST `max` chars (default 500 — the caret sits at the end of what the user just dictated/typed), never mid-word cut at the start (drop the leading partial word).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { compactContext, extractIdentifiers, siteFromUrl } from '../src/main/uia-parse'

describe('extractIdentifiers', () => {
  it('pulls camelCase, snake_case, PascalCase, dotted, ALLCAPS', () => {
    const out = extractIdentifiers('const userId = fetchUser(user_id, MAX_RETRIES); api.postMessage()')
    expect(out).toContain('userId')
    expect(out).toContain('fetchUser')
    expect(out).toContain('user_id')
    expect(out).toContain('MAX_RETRIES')
    expect(out).toContain('api.postMessage')
  })
  it('drops plain words, short tokens, and dupes (first-seen order kept)', () => {
    const out = extractIdentifiers('the userId and the userId and go')
    expect(out).toEqual(['userId'])
    expect(out).not.toContain('the')
    expect(out).not.toContain('go')
  })
  it('caps the count', () => {
    const many = Array.from({ length: 100 }, (_, i) => `symUnique${i}`).join(' ')
    expect(extractIdentifiers(many, 10).length).toBe(10)
  })
  it('returns [] for empty/plain prose', () => {
    expect(extractIdentifiers('')).toEqual([])
    expect(extractIdentifiers('just some normal english words here')).toEqual([])
  })
})

describe('siteFromUrl', () => {
  it('reduces a URL to its host, stripping scheme/path/www', () => {
    expect(siteFromUrl('https://www.github.com/Owen-Jz/repo/pull/3')).toBe('github.com')
    expect(siteFromUrl('https://mail.google.com/mail/u/0/#inbox')).toBe('mail.google.com')
    expect(siteFromUrl('github.com/x/y')).toBe('github.com')
  })
  it('returns null for empty/garbage', () => {
    expect(siteFromUrl('')).toBeNull()
    expect(siteFromUrl('   ')).toBeNull()
    expect(siteFromUrl('not a url at all !!!')).toBeNull()
  })
})

describe('compactContext', () => {
  it('keeps the tail (caret end) and collapses whitespace', () => {
    const out = compactContext('  Hello   there\n\n world  ', 100)
    expect(out).toBe('Hello there world')
  })
  it('caps to the last N chars without a leading partial word', () => {
    const out = compactContext('alpha beta gamma delta', 12)
    // last 12 chars = "gamma delta" after dropping the partial leading word
    expect(out).toBe('gamma delta')
    expect(out.length).toBeLessThanOrEqual(12)
  })
  it('returns "" for empty', () => {
    expect(compactContext('   ')).toBe('')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd C:\Users\owen\Downloads\OwenFlow\app; npx vitest run tests/uia-parse.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `app/src/main/uia-parse.ts`**

```ts
/**
 * Pure parsing for the UIA reads (see uia.ts). Kept Electron-free so the
 * identifier/site/context logic is unit-testable without a Windows host.
 */

/** Tokens worth biasing Whisper toward: they carry casing a dictation can't. */
const IDENTIFIER_RE = /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+\b|\b[A-Za-z_$][A-Za-z0-9_$]*\b/g

/** A bare lowercase word ("fetch", "message") carries no casing to preserve. */
function isPlainWord(tok: string): boolean {
  return /^[a-z]+$/.test(tok)
}

export function extractIdentifiers(text: string, max = 40): string[] {
  if (!text) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(IDENTIFIER_RE)) {
    const tok = m[0]
    if (tok.length < 3) continue
    if (isPlainWord(tok)) continue // plain english adds noise, not casing
    if (seen.has(tok)) continue
    seen.add(tok)
    out.push(tok)
  }
  // Longest first (most distinctive), then first-seen order among ties.
  out.sort((a, b) => b.length - a.length)
  return out.slice(0, max)
}

export function siteFromUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  // strip scheme, then take up to the first / ? #, then drop www.
  const host = trimmed
    .replace(/^[a-z]+:\/\//i, '')
    .split(/[/?#]/)[0]
    .replace(/^www\./i, '')
    .trim()
  // must look like a host (has a dot, no spaces)
  if (!host || /\s/.test(host) || !host.includes('.')) return null
  return host.toLowerCase()
}

export function compactContext(fieldText: string, max = 500): string {
  const collapsed = fieldText.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  const tail = collapsed.slice(collapsed.length - max)
  // drop a leading partial word so the snippet starts clean
  const space = tail.indexOf(' ')
  return space > 0 ? tail.slice(space + 1) : tail
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/uia-parse.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/uia-parse.ts app/tests/uia-parse.test.ts
git commit -m "feat: pure text helpers for UIA context (identifiers, site, compaction)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: The UIA reader helper (persistent PowerShell) + reply parser

A second persistent PowerShell helper (twin of injector.ts's) that loads the UIAutomation assemblies once and answers two request types: read the focused editable element's text, and read a foreground app's editor/browser context. The PowerShell bodies below are lifted verbatim from the verified de-risk probes.

**Files:**
- Create: `app/src/main/uia.ts`
- Test: `app/tests/uia.test.ts` (covers only the pure reply parser — the helper glue is Windows-only)

**Interfaces:**
- Consumes: `extractIdentifiers`, `siteFromUrl`, `compactContext` (Task 1); `spawn` from `node:child_process`.
- Produces:
  - `parseUiaReply(line: string): { field: string; url: string }` — the helper answers one line: `OK <base64-json>` where the JSON is `{field, url}`; returns `{field:'', url:''}` for any non-OK/garbage line. (base64 avoids newline/quote escaping across the stdin pipe.)
  - `readFocusContext(): Promise<{ text: string; site: string | null }>` — reads the currently-focused element's field text (best-effort) + the foreground window's URL if it's a browser; returns compacted text + site. Never throws; empty on any failure or 400ms timeout.
  - `readEditorSymbols(): Promise<string[]>` — reads the focused element's document text and extracts identifiers; `[]` on any failure or 400ms timeout.
  - `warmupUia(): void`, `killUia(): void` — lifecycle twins of injector's warmup/kill.

- [ ] **Step 1: Write the failing test** (parser only):

```ts
import { describe, expect, it } from 'vitest'
import { parseUiaReply } from '../src/main/uia'

describe('parseUiaReply', () => {
  it('decodes an OK base64 JSON payload', () => {
    const payload = Buffer.from(JSON.stringify({ field: 'Hello there', url: 'https://github.com/x' })).toString('base64')
    expect(parseUiaReply(`OK ${payload}`)).toEqual({ field: 'Hello there', url: 'https://github.com/x' })
  })
  it('returns empties for ERR / garbage / missing fields', () => {
    expect(parseUiaReply('ERR nope')).toEqual({ field: '', url: '' })
    expect(parseUiaReply('')).toEqual({ field: '', url: '' })
    expect(parseUiaReply('OK not-base64!!')).toEqual({ field: '', url: '' })
    const partial = Buffer.from(JSON.stringify({ field: 'hi' })).toString('base64')
    expect(parseUiaReply(`OK ${partial}`)).toEqual({ field: 'hi', url: '' })
  })
})
```

- [ ] **Step 2: Run to verify failure** — module not found.

- [ ] **Step 3: Implement `app/src/main/uia.ts`.** Mirror `injector.ts`'s persistent-helper machinery (copy its `onHelperStdout`/`nextLine`/`discardHelper`/`ensureHelper` FIFO-waiter shape — this is the established pattern in the repo; a shared abstraction is out of scope for this task). Load the assemblies + define a `Read-Focus` and `Read-Editor` function once at init; each request writes one line and reads one `OK <base64>` line back. The PowerShell reader body (verbatim from the de-risk probes, base64-wrapped output):

```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { compactContext, extractIdentifiers, siteFromUrl } from './uia-parse'

const READY_TIMEOUT_MS = 15_000
const READ_TIMEOUT_MS = 400 // reads are best-effort; never make the user wait

// Loaded once into the persistent helper. Emits READY when the UIA assemblies
// and reader functions are defined. Read-Focus returns the focused element's
// text (TextPattern → ValuePattern fallback) plus, if the foreground window is
// a browser, its address-bar URL — all as base64(JSON) so newlines/quotes in
// field text can't corrupt the line protocol.
const INIT_SCRIPT = [
  "Add-Type -AssemblyName UIAutomationClient;",
  "Add-Type -AssemblyName UIAutomationTypes;",
  "function Enc($f,$u){",
  "  $o=@{field=$f;url=$u} | ConvertTo-Json -Compress;",
  "  $b=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($o));",
  "  [Console]::Out.WriteLine('OK ' + $b);",
  "}",
  "function Focused-Text {",
  "  try {",
  "    $fe=[System.Windows.Automation.AutomationElement]::FocusedElement;",
  "    if(-not $fe){return ''};",
  "    $tp=$null;",
  "    if($fe.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$tp)){",
  "      return $tp.DocumentRange.GetText(4000);",
  "    }",
  "    $vp=$null;",
  "    if($fe.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$vp)){",
  "      return $vp.Current.Value;",
  "    }",
  "    return '';",
  "  } catch { return '' }",
  "}",
  "function Browser-Url {",
  "  try {",
  "    $root=[System.Windows.Automation.AutomationElement]::RootElement;",
  "    $fw=[System.Windows.Automation.AutomationElement]::FocusedElement;",
  "    if(-not $fw){return ''};",
  "    $pid=$fw.Current.ProcessId;",
  "    $pname=(Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName;",
  "    if($pname -notmatch 'chrome|msedge|brave|firefox|opera'){return ''};",
  "    $cond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$pid);",
  "    $win=$root.FindFirst([System.Windows.Automation.TreeScope]::Children,$cond);",
  "    if(-not $win){return ''};",
  "    $ec=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit);",
  "    $edit=$win.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$ec);",
  "    if(-not $edit){return ''};",
  "    $vp=$null;",
  "    if($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$vp)){return $vp.Current.Value};",
  "    return '';",
  "  } catch { return '' }",
  "}",
  "[Console]::Out.WriteLine('READY');"
].join(' ')

const READ_FOCUS_LINE = "Enc (Focused-Text) (Browser-Url)"
const READ_EDITOR_LINE = "Enc (Focused-Text) ''"

export function parseUiaReply(line: string): { field: string; url: string } {
  const empty = { field: '', url: '' }
  if (!line.startsWith('OK ')) return empty
  try {
    const json = Buffer.from(line.slice(3).trim(), 'base64').toString('utf8')
    const obj = JSON.parse(json) as { field?: unknown; url?: unknown }
    return {
      field: typeof obj.field === 'string' ? obj.field : '',
      url: typeof obj.url === 'string' ? obj.url : ''
    }
  } catch {
    return empty
  }
}

// ─── persistent helper (twin of injector.ts) ────────────────────────────────
// [copy injector.ts's helper/helperReady/stdoutBuffer/lineWaiters/onHelperStdout/
//  nextLine/discardHelper/ensureHelper verbatim, renaming for this module and
//  using INIT_SCRIPT in place of ADD_TYPE_LINE, and 'READY' as the ready token.]

async function readOnce(requestLine: string): Promise<{ field: string; url: string }> {
  try {
    await ensureHelper()
    const proc = helper
    if (!proc?.stdin) return { field: '', url: '' }
    const reply = nextLine(READ_TIMEOUT_MS)
    proc.stdin.write(requestLine + '\n')
    return parseUiaReply(await reply)
  } catch {
    return { field: '', url: '' }
  }
}

export async function readFocusContext(): Promise<{ text: string; site: string | null }> {
  const { field, url } = await readOnce(READ_FOCUS_LINE)
  return { text: compactContext(field), site: siteFromUrl(url) }
}

export async function readEditorSymbols(): Promise<string[]> {
  const { field } = await readOnce(READ_EDITOR_LINE)
  return extractIdentifiers(field)
}

export function warmupUia(): void {
  ensureHelper().catch(() => {})
}

export function killUia(): void {
  discardHelper()
}
```

The implementer copies the helper plumbing from injector.ts (lines 89–168 there), renaming symbols to keep the two helpers independent (separate child process, separate FIFO). `ensureHelper` writes `INIT_SCRIPT` and awaits the `READY` line.

- [ ] **Step 4: Run** — `npx vitest run tests/uia.test.ts` → PASS; `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/uia.ts app/tests/uia.test.ts
git commit -m "feat: UIA reader helper — focused field text + browser URL + editor symbols

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `contextAwareness` setting + lifecycle wiring

**Files:**
- Modify: `app/src/shared/types.ts` (`contextAwareness: boolean` on `OwenFlowSettings`, doc: "Read the focused app's text (and browser URL) via UI Automation to improve name spelling and code-identifier recognition. Windows-only; best-effort. Sends a short focused-field snippet to the cleanup LLM, so it ships OFF by default (opt-in).")
- Modify: `app/src/main/config.ts` (default `contextAwareness: false` + schema `{ type: 'boolean', default: false }`, next to `meetingAutoDetect`)
- Modify: `app/src/main/index.ts` (`warmupUia()` at boot next to `warmupInjector()`; `killUia()` in the quit hook next to `killInjector()`)
- Test: `app/tests/config.test.ts`

**Interfaces:**
- Consumes: `warmupUia`, `killUia` (Task 2).
- Produces: the `contextAwareness` setting other tasks gate on.

- [ ] **Step 1: Write the failing config test** (append to the settings-defaults/schema block, matching `config.test.ts`'s existing assertion shape — read it first):

```ts
it('contextAwareness defaults OFF and is schema-typed boolean', () => {
  expect(DEFAULT_SETTINGS.contextAwareness).toBe(false)
  // match the file's actual schema assertion shape (captured.options?.schema)
  expect(schema.contextAwareness).toEqual({ type: 'boolean', default: false })
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** the type field, config default + schema, and the two index.ts lifecycle calls (`warmupUia()` beside the existing `warmupInjector()` call; `killUia()` beside `killInjector()` in `will-quit`).

- [ ] **Step 4: Run** — full suite green; `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add app/src/shared/types.ts app/src/main/config.ts app/src/main/index.ts app/tests/config.test.ts
git commit -m "feat: contextAwareness setting (default on) + UIA helper lifecycle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Editor symbol biasing into the Whisper prompt

Symbols must be ready when the transcribe prompt is built at stop. Read them at dictation **start** (the target editor is focused then), store the promise, and await it behind a 250ms cap at stop. Only for known editors, only when `contextAwareness` is on.

**Files:**
- Modify: `app/src/main/pipeline.ts` (`PipelineDeps` gains `readEditorSymbols?: () => Promise<string[]>`; kick it off in `startDictation`; await-with-cap in `stopDictation` and merge into the transcribe context)
- Modify: `app/src/main/index.ts` (wire `readEditorSymbols` dep + gate on `contextAwareness` and an editor-app check)
- Test: `app/tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `readEditorSymbols` (Task 2); the existing `PipelineDeps.transcribe(wav, settings, context?)` third arg (already used for continuous boundary context).
- Produces: editor symbols appended to the transcribe `context` string (so `buildBiasPrompt` vocabulary + symbols both bias Whisper).

Key facts from the current code: `pipeline.ts` `startDictation()` sets `dictating = true` and calls `deps.recorderStart()`. `stopDictation()` calls `deps.transcribe(wav, settings, context?)`. `index.ts` builds the transcribe prompt as `[bias, context].filter(Boolean).join(' ')`. Editor symbols are more context to prepend.

- [ ] **Step 1: Write the failing tests** (in `pipeline.test.ts`, matching its DI-mock style — read it first):

```ts
it('reads editor symbols at start and feeds them to transcribe at stop', async () => {
  const symbols = vi.fn().mockResolvedValue(['userId', 'fetchUser'])
  const transcribe = vi.fn().mockResolvedValue({ text: 'hello', durationMs: 1 })
  const deps = makePipelineDeps({ readEditorSymbols: symbols, transcribe }) // use the file's existing dep factory/mocks
  initPipeline(deps)
  await startDictation()
  expect(symbols).toHaveBeenCalledOnce() // fired at start, not stop
  await stopDictation()
  const ctx = transcribe.mock.calls[0][2] as string
  expect(ctx).toContain('userId')
  expect(ctx).toContain('fetchUser')
})

it('does not block stop when the symbol read hangs past the cap', async () => {
  const symbols = vi.fn().mockReturnValue(new Promise(() => {})) // never resolves
  const transcribe = vi.fn().mockResolvedValue({ text: 'hi', durationMs: 1 })
  initPipeline(makePipelineDeps({ readEditorSymbols: symbols, transcribe }))
  await startDictation()
  const stopped = stopDictation()
  await vi.advanceTimersByTimeAsync(300) // past the 250ms cap
  await stopped
  expect(transcribe).toHaveBeenCalledOnce() // proceeded without symbols
})

it('skips the symbol read entirely when the dep is absent', async () => {
  const transcribe = vi.fn().mockResolvedValue({ text: 'hi', durationMs: 1 })
  initPipeline(makePipelineDeps({ transcribe })) // no readEditorSymbols
  await startDictation()
  await stopDictation()
  expect(transcribe).toHaveBeenCalledOnce()
})
```

(Adapt `makePipelineDeps`/mock names to whatever `pipeline.test.ts` already uses.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement in `pipeline.ts`:**

- Add to `PipelineDeps`: `readEditorSymbols?: () => Promise<string[]>`.
- Module state: `let editorSymbolsPromise: Promise<string[]> | null = null`.
- In `startDictation()`, right after `deps.recorderStart()`:

```ts
  // Editor symbols are read NOW (the target editor is focused at start); the
  // read is awaited behind a cap at stop so a slow UIA read never delays paste.
  editorSymbolsPromise = deps.readEditorSymbols ? deps.readEditorSymbols().catch(() => []) : null
```

- Add a cap helper near the other helpers:

```ts
const EDITOR_SYMBOL_CAP_MS = 250
function withCap<T>(p: Promise<T> | null, ms: number, fallback: T): Promise<T> {
  if (!p) return Promise.resolve(fallback)
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))])
}
```

- In `stopDictation()`, before the `deps.transcribe(...)` call, resolve symbols and thread them into the context. The transcribe dep is called by index.ts's wiring which builds `context`; here pipeline passes its own context arg. Currently the one-shot path calls `deps.transcribe(wav, settings)` with no context — change it to pass the symbols as context:

```ts
  const symbols = await withCap(editorSymbolsPromise, EDITOR_SYMBOL_CAP_MS, [])
  editorSymbolsPromise = null
  const symbolContext = symbols.length ? `Code identifiers: ${symbols.join(', ')}.` : undefined
  // ...
  const result = await deps.transcribe(wav, settings, symbolContext)
```

(Preserve the existing generation-guard checks around the await. If the one-shot `transcribe` call site currently passes no third arg, add `symbolContext`.)

- Reset `editorSymbolsPromise = null` in `cancelDictation()` too.

- [ ] **Step 4: Implement the index.ts wiring** — add the dep, gated:

```ts
    readEditorSymbols: async () => {
      if (!getSettings().contextAwareness) return []
      const app = (await getForegroundApp()) ?? ''
      // Only editors carry code identifiers worth biasing toward.
      if (!/^(Code|Cursor|Windsurf|devenv|idea|pycharm|webstorm|sublime_text)$/i.test(app)) return []
      return readEditorSymbols()
    },
```

- [ ] **Step 5: Run** — full suite green; `npm run typecheck` clean.

- [ ] **Step 6: Commit**

```bash
git add app/src/main/pipeline.ts app/src/main/index.ts app/tests/pipeline.test.ts
git commit -m "feat: bias Whisper toward on-screen code identifiers in editors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Focus context into the cleanup prompt

Read the focused field text + browser site at **stop**, in parallel with transcription, and pass it to `cleanup()` via the existing `extraSystem` third arg so the LLM spells on-screen names right and matches the surrounding register.

**Files:**
- Modify: `app/src/main/pipeline.ts` (`PipelineDeps` gains `readFocusContext?: () => Promise<{ text: string; site: string | null }>`; read in parallel with transcribe; build an `extraSystem` context line; merge with the existing profile prompt rule)
- Modify: `app/src/main/index.ts` (wire the dep, gated on `contextAwareness`)
- Modify: `app/src/main/cleanup.ts` — no signature change (it already accepts `extraSystem`); confirm `extraSystem` is appended to the system prompt (it is).
- Test: `app/tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `readFocusContext` (Task 2); the existing `cleanup(raw, settings, extraSystem?)` and `profilePromptRule(profile)`.
- Produces: an `extraSystem` string combining the app-profile prompt rule (existing) + a new context hint.

Current code: `stopDictation()` computes `profile ? profilePromptRule(profile) || undefined : undefined` and passes it as `cleanup`'s third arg. This task merges a context hint into that same arg.

- [ ] **Step 1: Write the failing tests:**

```ts
it('passes focused-field context to cleanup as extra system guidance', async () => {
  const focus = vi.fn().mockResolvedValue({ text: 'Hi Tunde, about the Nomba invoice', site: 'mail.google.com' })
  const cleanup = vi.fn().mockResolvedValue('cleaned')
  initPipeline(makePipelineDeps({
    readFocusContext: focus,
    transcribe: vi.fn().mockResolvedValue({ text: 'thanks for the update', durationMs: 1 }),
    cleanup
  }))
  await startDictation()
  await stopDictation()
  const extra = cleanup.mock.calls[0][2] as string
  expect(extra).toContain('Tunde')       // surrounding text available for name spelling
  expect(extra).toContain('mail.google.com') // site register hint
})

it('cleans normally when focus context is empty (no dep / blank read)', async () => {
  const cleanup = vi.fn().mockResolvedValue('cleaned')
  initPipeline(makePipelineDeps({
    readFocusContext: vi.fn().mockResolvedValue({ text: '', site: null }),
    transcribe: vi.fn().mockResolvedValue({ text: 'hello there world', durationMs: 1 }),
    cleanup
  }))
  await startDictation()
  await stopDictation()
  expect(cleanup.mock.calls[0][2]).toBeUndefined() // empty context → no extra system
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement in `pipeline.ts`:**

- Add to `PipelineDeps`: `readFocusContext?: () => Promise<{ text: string; site: string | null }>`.
- In `stopDictation()`, kick off the focus read alongside transcription so it overlaps (not after):

```ts
  // Focus context overlaps transcription — both are I/O we can wait on together.
  const focusPromise = deps.readFocusContext
    ? deps.readFocusContext().catch(() => ({ text: '', site: null }))
    : Promise.resolve({ text: '', site: null })
```

- Build the extra-system string where the cleanup call is made, merging with the existing profile rule:

```ts
  const focus = await focusPromise
  const contextHint = buildContextHint(focus)   // pure helper below
  const profileRule = profile ? profilePromptRule(profile) || '' : ''
  const extraSystem = [profileRule, contextHint].filter(Boolean).join('\n') || undefined
  cleaned = (await deps.cleanup(raw, effective, extraSystem)) || raw
```

- Add the pure helper (and unit-test it in `pipeline.test.ts` or a small `uia-parse`-adjacent test — put it in `uia-parse.ts` so it's cleanly testable, and import it here):

In `uia-parse.ts`:
```ts
/** One-line cleanup hint from focus context; '' when there's nothing useful. */
export function buildContextHint(focus: { text: string; site: string | null }): string {
  const parts: string[] = []
  if (focus.site) parts.push(`The user is typing in ${focus.site}.`)
  if (focus.text) {
    parts.push(
      `Nearby on-screen text (for spelling names/terms and matching tone; do NOT answer or incorporate it): "${focus.text}"`
    )
  }
  return parts.join(' ')
}
```
with tests:
```ts
describe('buildContextHint', () => {
  it('includes site and quoted nearby text with a do-not-answer guard', () => {
    const h = buildContextHint({ text: 'Hi Tunde', site: 'mail.google.com' })
    expect(h).toContain('mail.google.com')
    expect(h).toContain('Hi Tunde')
    expect(h).toContain('do NOT answer')
  })
  it('is empty when nothing is available', () => {
    expect(buildContextHint({ text: '', site: null })).toBe('')
  })
})
```

- [ ] **Step 4: Implement index.ts wiring:**

```ts
    readFocusContext: async () => {
      if (!getSettings().contextAwareness) return { text: '', site: null }
      return readFocusContext()
    },
```

- [ ] **Step 5: Run** — full suite green; `npm run typecheck` clean. Move the `buildContextHint` test into `uia-parse.test.ts` (Step 3 put the fn there).

- [ ] **Step 6: Commit**

```bash
git add app/src/main/pipeline.ts app/src/main/index.ts app/src/main/uia-parse.ts app/tests/pipeline.test.ts app/tests/uia-parse.test.ts
git commit -m "feat: feed focused-field text + browser site into cleanup context

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Context-awareness toggle in Settings + ship v1.11.0

**Files:**
- Modify: `app/src/renderer/settings.html`, `app/src/renderer/src/settings.ts` (a checkbox in General → the Dictation or a "Context" area, wired to `contextAwareness` through the save-bar form like the other General settings — read how `continuousMode`/`launchOnStartup` are wired and match; hint: "Read the focused app's text via UI Automation to spell on-screen names right and recognize code identifiers. Windows-only, best-effort.")
- Modify: `docs/mockups/settings-harness-stub.js` (`contextAwareness: true` in the mocked settings)
- Modify: `app/package.json` (version → `1.11.0`)

- [ ] **Step 1:** Add the checkbox + wiring (fillForm/readForm) matching the existing General-page boolean settings. Build clean.
- [ ] **Step 2:** Full verify: `npx vitest run` (all green), `npm run typecheck`, `npm run build`.
- [ ] **Step 3:** Commit the UI + version bump; push `main`.
- [ ] **Step 4:** `npm run build:win`; stop running OwenFlow + port-8484 sidecar; install `dist\owenflow-1.11.0-setup.exe /S`; relaunch; poll `/health` until `loaded:true`.
- [ ] **Step 5:** Live check: focus a text field with a name in it (or a code editor), dictate, and confirm the transcript spelled the on-screen name/identifier correctly. Because UIA is best-effort, the acceptance bar is "improves in supported apps, never regresses / never blocks a paste anywhere."

## Self-Review (done)

- **Coverage:** UIA reader (T2) built on proven probes; pure parsing (T1) fully tested; editor-symbol bias (T4) and focus-context cleanup (T5) each wired + tested via DI mocks; setting + gating (T3, T6); ship (T6). Both Wave-B gaps (context awareness, editor symbol biasing) covered.
- **Placeholders:** the only "match the existing file" directives are the config-test assertion shape (T3), the pipeline dep-mock factory name (T4/T5), and the General-settings checkbox wiring (T6) — each names the concrete pattern to copy, with full new code supplied. The UIA helper plumbing (T2) is an explicit "copy injector.ts lines 89–168, renamed" — that file is the in-repo reference implementation.
- **Type consistency:** `readEditorSymbols(): Promise<string[]>` and `readFocusContext(): Promise<{text; site: string|null}>` identical across uia.ts (T2), PipelineDeps (T4/T5), and index.ts wiring; `buildContextHint` defined in uia-parse.ts (T5) and consumed in pipeline.ts; `parseUiaReply` returns `{field,url}` consistently.
- **Never-block guarantee:** editor symbols read at start + 250ms cap at stop (T4); focus context overlaps transcription (T5); every UIA read `.catch(()=>empty)`. No path lets UIA delay a paste.
