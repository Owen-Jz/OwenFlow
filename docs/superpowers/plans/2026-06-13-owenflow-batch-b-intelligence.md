# OwenFlow Batch B (Intelligence) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps. All commands from `app/` (`C:\Users\owen\Downloads\OwenFlow\app`).

**Goal:** #1 App-aware formatting profiles (foreground-app detection → per-app reshaping) and #4 Auto-learning dictionary (correct-in-history → propose `wrong=>right`).

**Architecture:** New pure modules `profiles.ts`, `learn.ts`. `injector.ts` gains `getForegroundApp()` via its warm PowerShell helper. `cleanup.ts` gains an `extraSystem` append. `pipeline.ts` captures the app at record-start and applies profile (mode precedence session>profile>global; transforms after dictionary). New "Apps" settings section + History edit/Learn UI.

**Spec:** `docs/superpowers/specs/2026-06-13-owenflow-batch-b-intelligence-design.md`

---

## Task B1: Types + config (profiles)

**Files:** `src/shared/types.ts`, `src/main/config.ts`, `tests/config.test.ts`

- [ ] **Step 1 — failing test.** Add to `tests/config.test.ts`:
```ts
describe('config app profiles', () => {
  it('defaults appProfilesEnabled false and seeds preset profiles', () => {
    expect(DEFAULT_SETTINGS.appProfilesEnabled).toBe(false)
    expect(Array.isArray(DEFAULT_SETTINGS.profiles)).toBe(true)
    expect(DEFAULT_SETTINGS.profiles.length).toBeGreaterThan(0)
    expect(DEFAULT_SETTINGS.profiles[0].match).toContain('Code')
  })
})
```
- [ ] **Step 2 — run FAIL:** `npm run test -- config`
- [ ] **Step 3 — types.** In `src/shared/types.ts`, add above `OwenFlowSettings`:
```ts
/** A per-app formatting profile, matched on focused process name. */
export interface AppProfile {
  /** Process names (no .exe), case-insensitive, e.g. ["Code","Cursor"]. */
  match: string[]
  /** Pin a flow mode while this app is focused; omitted = inherit. */
  flowMode?: FlowMode
  /** Strip a trailing sentence period from the output. */
  stripTrailingPeriod?: boolean
  /** Lowercase the first letter (don't auto-capitalize). */
  noAutoCapitalize?: boolean
  /** Collapse internal newlines to single spaces. */
  singleLine?: boolean
  /** Per-app "wrong=>right" replacement lines. */
  replacements?: string[]
  /** Extra instruction appended to the cleanup system prompt. */
  promptRule?: string
}
```
Add to `OwenFlowSettings` (after `activeSession`):
```ts
  /** Master switch for app-aware formatting profiles. */
  appProfilesEnabled: boolean
  /** Per-app formatting profiles (matched on focused process name). */
  profiles: AppProfile[]
```
- [ ] **Step 4 — config.** In `DEFAULT_SETTINGS`, after `activeSession: '',` add `appProfilesEnabled: false,` and `profiles: DEFAULT_PROFILES,`. Import `DEFAULT_PROFILES` at top: `import { DEFAULT_PROFILES } from './profiles'`. In `schema`, after the activeSession entry add:
```ts
    appProfilesEnabled: { type: 'boolean', default: false },
    profiles: { type: 'array', default: [] },
```
(Schema `profiles` is a permissive array; shape is enforced by the `AppProfile` type + pure module, not JSON-schema.)
- [ ] **Step 5 — run PASS** (after Task B2 creates `profiles.ts`/`DEFAULT_PROFILES`, this import resolves; if doing B1 first, temporarily expect the import to fail typecheck until B2 — run `npm run test -- config` which is per-file and passes once DEFAULT_PROFILES exists). **Do B2 before committing B1** so the import resolves.
- [ ] **Step 6 — commit** (after B2): `git add src/shared/types.ts src/main/config.ts tests/config.test.ts` → `feat: app profile settings + types`.

## Task B2: profiles.ts pure module

**Files:** create `src/main/profiles.ts`, `tests/profiles.test.ts`

- [ ] **Step 1 — failing tests** `tests/profiles.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { matchProfile, applyProfileTransforms, profilePromptRule, DEFAULT_PROFILES } from '../src/main/profiles'

describe('matchProfile', () => {
  it('matches a process name case-insensitively', () => {
    const p = matchProfile('code', [{ match: ['Code', 'Cursor'] }])
    expect(p).not.toBeNull()
  })
  it('returns null for no match or null app', () => {
    expect(matchProfile('chrome', [{ match: ['Code'] }])).toBeNull()
    expect(matchProfile(null, [{ match: ['Code'] }])).toBeNull()
  })
})

describe('applyProfileTransforms', () => {
  it('strips trailing period', () => {
    expect(applyProfileTransforms('hello world.', { match: [], stripTrailingPeriod: true })).toBe('hello world')
  })
  it('lowercases first letter when noAutoCapitalize', () => {
    expect(applyProfileTransforms('Hello', { match: [], noAutoCapitalize: true })).toBe('hello')
  })
  it('collapses newlines when singleLine', () => {
    expect(applyProfileTransforms('a\nb\n c', { match: [], singleLine: true })).toBe('a b c')
  })
  it('applies per-app replacements before boolean transforms', () => {
    expect(applyProfileTransforms('say cat.', { match: [], replacements: ['cat=>dog'], stripTrailingPeriod: true })).toBe('say dog')
  })
  it('no-ops when no transforms set', () => {
    expect(applyProfileTransforms('Hello world.', { match: [] })).toBe('Hello world.')
  })
})

describe('profilePromptRule + presets', () => {
  it('returns the rule or empty string', () => {
    expect(profilePromptRule({ match: [], promptRule: 'be terse' })).toBe('be terse')
    expect(profilePromptRule({ match: [] })).toBe('')
  })
  it('ships editable presets including a Code profile', () => {
    expect(DEFAULT_PROFILES.some((p) => p.match.includes('Code'))).toBe(true)
  })
})
```
- [ ] **Step 2 — run FAIL:** `npm run test -- profiles`
- [ ] **Step 3 — implement `src/main/profiles.ts`:**
```ts
/**
 * App-aware formatting profiles: match the focused process name to a profile,
 * then reshape the output (deterministic transforms + an optional prompt rule
 * fed to cleanup). Pure module (no electron) — pipeline + tests use directly.
 */

import type { AppProfile, FlowMode } from '../shared/types'
import { applyReplacements, parseDictionary } from './dictionary'

/** Editable presets, seeded into settings on first run. */
export const DEFAULT_PROFILES: AppProfile[] = [
  {
    match: ['Code', 'Cursor'],
    flowMode: 'vibe',
    stripTrailingPeriod: true,
    noAutoCapitalize: true,
    promptRule: 'Target is a code editor; keep code identifiers and casing exact.'
  },
  {
    match: ['WindowsTerminal', 'powershell', 'cmd', 'wezterm', 'alacritty'],
    stripTrailingPeriod: true,
    noAutoCapitalize: true,
    singleLine: true,
    promptRule: 'Target is a terminal; if this is a shell command, output only the command.'
  },
  { match: ['slack', 'Discord'], flowMode: 'normal' },
  { match: ['OUTLOOK', 'Mail', 'Thunderbird'], flowMode: 'formal' }
]

/** First profile whose match list contains the app (case-insensitive), or null. */
export function matchProfile(app: string | null, profiles: AppProfile[]): AppProfile | null {
  if (!app) return null
  const key = app.toLowerCase()
  for (const p of profiles) {
    if (p.match.some((m) => m.toLowerCase() === key)) return p
  }
  return null
}

/** Per-app replacements first, then boolean transforms (period/case/single-line). */
export function applyProfileTransforms(text: string, profile: AppProfile): string {
  let out = text
  if (profile.replacements?.length) {
    const { replacements } = parseDictionary(profile.replacements)
    out = applyReplacements(out, replacements)
  }
  if (profile.singleLine) out = out.replace(/\s*\n+\s*/g, ' ')
  if (profile.stripTrailingPeriod) out = out.replace(/\.\s*$/, '')
  if (profile.noAutoCapitalize && out) out = out.charAt(0).toLowerCase() + out.slice(1)
  return out
}

/** The system-prompt rule for this profile (or ''). */
export function profilePromptRule(profile: AppProfile): string {
  return profile.promptRule?.trim() || ''
}

/** Effective flow mode pinned by the profile, if any. */
export function profileMode(profile: AppProfile | null): FlowMode | null {
  return profile?.flowMode ?? null
}
```
- [ ] **Step 4 — run PASS:** `npm run test -- profiles`
- [ ] **Step 5 — commit B1+B2 together:** `git add src/shared/types.ts src/main/config.ts tests/config.test.ts src/main/profiles.ts tests/profiles.test.ts` → `feat: app profiles module + settings`. Confirm `npm run typecheck:node` clean.

## Task B3: Foreground-app detection in injector.ts + apps:detect IPC

**Files:** `src/main/injector.ts`, `src/shared/types.ts`, `src/main/index.ts`, `src/preload/index.ts`, `tests/injector.test.ts` (new, if feasible)

- [ ] **Step 1 — extend the helper Add-Type** in `injector.ts`. In `ADD_TYPE_LINE`, add to the `OwenFlowInput` C# class (alongside the SendInput import) these members (keep single-quote-free):
```
[DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr hWnd,out uint pid);
public static string GetForegroundExe(){uint pid;GetWindowThreadProcessId(GetForegroundWindow(),out pid);try{return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;}catch{return "";}}
```
- [ ] **Step 2 — add a query line + export.** Add a constant `FOREGROUND_LINE = "try{[Console]::Out.WriteLine('EXE ' + [OwenFlowInput]::GetForegroundExe())}catch{[Console]::Out.WriteLine('ERR ' + $_.Exception.Message)}"`. Export:
```ts
/** Process name of the foreground window (no .exe), or null on any failure. */
export async function getForegroundApp(): Promise<string | null> {
  try {
    await ensureHelper()
    const proc = helper
    if (!proc?.stdin) return null
    const reply = nextLine(PASTE_TIMEOUT_MS)
    proc.stdin.write(FOREGROUND_LINE + '\n')
    const line = await reply
    if (line.startsWith('EXE ')) {
      const name = line.slice(4).trim()
      return name || null
    }
    return null
  } catch {
    return null
  }
}
```
- [ ] **Step 3 — IPC.** In `src/shared/types.ts`: add `appsDetect: 'apps:detect'` to `IPC`; add `apps: { detect: () => Promise<string | null> }` to `OwenFlowApi`. In `src/preload/index.ts`: add `apps: { detect: (): Promise<string | null> => ipcRenderer.invoke(IPC.appsDetect) }`. In `src/main/index.ts`: `import { ..., getForegroundApp } from './injector'` and in `registerIpc()` add `ipcMain.handle(IPC.appsDetect, () => getForegroundApp())`.
- [ ] **Step 4 — verify.** `npm run typecheck:node`; `npm run build`. (Detection is hard to unit test without the live helper; rely on typecheck/build + the manual smoke in Task B6. If a lightweight test of the `EXE `/`ERR ` parsing is cheaply mockable, add it; otherwise skip.)
- [ ] **Step 5 — commit:** `git add src/main/injector.ts src/shared/types.ts src/main/index.ts src/preload/index.ts` → `feat: foreground-app detection (getForegroundApp + apps:detect)`.

## Task B4: cleanup.ts extraSystem param

**Files:** `src/main/cleanup.ts`, `tests/cleanup.test.ts`

- [ ] **Step 1 — failing test:**
```ts
it('appends extraSystem to the system prompt when provided', async () => {
  fetchMock.mockResolvedValue(okResponse('x'))
  await cleanup('um hello there world', settings({ cleanupProvider: 'groq', groqApiKey: 'gk' }), 'TERMINAL RULE')
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content).toContain('TERMINAL RULE')
})
```
- [ ] **Step 2 — run FAIL:** `npm run test -- cleanup`
- [ ] **Step 3 — implement.** Change `cleanup`'s signature to `export async function cleanup(raw: string, settings: OwenFlowSettings, extraSystem?: string): Promise<string>`. Where the system content is built (`systemPromptFor(mode, settings)`), set it to `extraSystem ? systemPromptFor(mode, settings) + '\n' + extraSystem : systemPromptFor(mode, settings)`. Do not change `benchmarkProvider`.
- [ ] **Step 4 — run PASS:** `npm run test -- cleanup`
- [ ] **Step 5 — commit:** `git add src/main/cleanup.ts tests/cleanup.test.ts` → `feat: cleanup extraSystem (profile prompt rule)`.

## Task B5: pipeline.ts profile integration

**Files:** `src/main/pipeline.ts`, `tests/pipeline.test.ts`

- [ ] **Step 1 — read** `pipeline.ts` (`startDictation`, `stopDictation`, deps) + the test helpers first. Add to the `PipelineDeps` interface a way to get the app: extend `cleanup` dep is already there; add an optional dep `getForegroundApp?: () => Promise<string | null>` and (in tests) mock it. NOTE: capturing at start requires storing per-generation; if simpler, capture in `stopDictation` via `await deps.getForegroundApp?.()` BEFORE cleanup (focus is still on the target during the brief stop). **Prefer the simpler stopDictation-time capture** unless the team wants start-time; document the choice.
- [ ] **Step 2 — failing tests** (adapt to existing helpers):
```ts
it('applies a matching app profile: pins mode, records app, transforms after dictionary', async () => {
  const deps = makeDeps(baseSettings({
    appProfilesEnabled: true,
    flowMode: 'normal', cleanupEnabled: false,
    profiles: [{ match: ['Code'], flowMode: 'vibe', stripTrailingPeriod: true }]
  }), [])
  deps.getForegroundApp = vi.fn(async () => 'Code')
  deps.transcribe.mockResolvedValue({ text: 'add a helper function.', durationMs: 10 })
  await runDictation(deps)
  expect(deps.cleanup).toHaveBeenCalled()
  expect(deps.cleanup.mock.calls[0][1].flowMode).toBe('vibe')   // profile pin
  const entry = deps.appendHistory.mock.calls.at(-1)[0]
  expect(entry.app).toBe('Code')
})

it('session pick beats an app profile mode', async () => {
  const deps = makeDeps(baseSettings({
    appProfilesEnabled: true,
    sessionTones: ['client=>formal'], activeSession: 'client',
    profiles: [{ match: ['Code'], flowMode: 'vibe' }]
  }), [])
  deps.getForegroundApp = vi.fn(async () => 'Code')
  deps.transcribe.mockResolvedValue({ text: 'please review the attached', durationMs: 10 })
  await runDictation(deps)
  expect(deps.cleanup.mock.calls[0][1].flowMode).toBe('formal')
})
```
- [ ] **Step 3 — implement** in `pipeline.ts`:
  - Import `matchProfile, applyProfileTransforms, profilePromptRule, profileMode` from `./profiles`.
  - In `stopDictation`, after `settings` is read and after the empty-check (and after the snippet short-circuit), capture the app: `const app = settings.appProfilesEnabled ? await deps.getForegroundApp?.() ?? null : null` then `if (gen !== generation) return`.
  - `const profile = settings.appProfilesEnabled ? matchProfile(app, settings.profiles) : null`.
  - Effective mode precedence: `const sessionMode = activeSessionMode(...); const effMode = sessionMode ?? profileMode(profile) ?? settings.flowMode; const effective = { ...settings, flowMode: effMode }`.
  - Cleanup call: `cleaned = (await deps.cleanup(raw, effective, profilePromptRule(profile ?? { match: [] }) || undefined)) || raw` (pass the rule only when a profile exists).
  - After global dictionary replacements: `const final = profile ? applyProfileTransforms(applyReplacements(cleaned, replacements), profile) : applyReplacements(cleaned, replacements)`.
  - Record the app: extend `appendEntry` to accept `app?: string` and include it in the history entry; pass `app ?? undefined` at the success + inject-failure sites. (Snippet path may pass the app too if captured; acceptable to leave snippet path app-less in v1 — document.)
  - Add `getForegroundApp` to the `PipelineDeps` interface (optional) and wire the real `getForegroundApp` in `index.ts`'s `initPipeline({...})`.
- [ ] **Step 4 — run PASS:** `npm run test -- pipeline`; then `npm run test`.
- [ ] **Step 5 — commit:** `git add src/main/pipeline.ts tests/pipeline.test.ts src/main/index.ts` → `feat: pipeline app-profile integration`.

## Task B6: Settings "Apps" section UI

**Files:** `src/renderer/settings.html`, `src/renderer/src/settings.ts`

- [ ] Add an "Apps" nav item + page. Master toggle `#f-app-profiles-enabled`. A profile-card list rendered from `settings.profiles` (each: match input, flow-mode select incl. "inherit", three checkboxes, prompt-rule input, replacements textarea, Delete) + "+ Add profile". A "Detect current app" button calling `window.owenflow.apps.detect()` → shows the process name. `readForm` serializes the cards back to `profiles: AppProfile[]` and `appProfilesEnabled`. Follow the existing folder/tag dynamic-DOM patterns in `settings.ts` for add/remove rows. Verify `npm run typecheck` + `npm run build`. Manual smoke (human). Commit → `feat: Apps settings section for profiles`.

## Task B7: learn.ts pure module (#4)

**Files:** create `src/main/learn.ts`, `tests/learn.test.ts`

- [ ] **Step 1 — failing tests:**
```ts
import { describe, expect, it } from 'vitest'
import { proposeReplacements } from '../src/main/learn'

describe('proposeReplacements', () => {
  it('proposes a single substitution, trimming common prefix/suffix', () => {
    expect(proposeReplacements('deploy to zeal vps now', 'deploy to ZEAL VPS now')).toEqual(['zeal vps=>ZEAL VPS'])
  })
  it('returns [] when identical', () => {
    expect(proposeReplacements('same text here', 'same text here')).toEqual([])
  })
  it('returns [] for a whole-sentence rewrite (too divergent)', () => {
    expect(proposeReplacements('a b c d', 'totally different words entirely')).toEqual([])
  })
})
```
- [ ] **Step 2 — run FAIL**; **Step 3 — implement** a word-level common-prefix/suffix diff: split both on whitespace; strip equal leading + trailing words; if the remaining "changed span" on each side is non-empty and the changed length is a minority of the corrected length (e.g. ≤ half the words changed), return `["<rawSpan.toLowerCase()>=><correctedSpan>"]`; else `[]`. Pure/total. **Step 4 — run PASS**; **Step 5 — commit** → `feat: learn.ts correction-diff module`.

## Task B8: History edit + Learn UI (#4)

**Files:** `src/renderer/src/settings.ts`, `src/renderer/settings.html`

- [ ] In `renderEntry`, add an "Edit" affordance that swaps the `.text` for a textarea seeded with `entry.final`, plus a **Learn** button. Learn calls `proposeReplacements(entry.raw, edited)` (import from a renderer-safe path — `learn.ts` is pure, import it directly) and renders the proposed `wrong=>right` line(s) with **Add** (appends to `settings.dictionary` via `window.owenflow.settings.set`, dedup) and dismiss; toast on add. Verify typecheck + build. Manual smoke. Commit → `feat: auto-learning dictionary (edit + Learn in history)`.

## Task B9: Docs + full verification + push

- [ ] README: document app profiles + auto-learning dictionary. `npm run test` (all green, counts). `npm run build`. Commit → `docs: app profiles + auto-learning dictionary`. Then `git push`.

---

## Self-Review Notes

- **Ordering:** B1 imports `DEFAULT_PROFILES` from B2 → commit B1+B2 together (Step B2.5). FlowMode already includes translate (Batch A).
- **Precedence:** session (Batch A) > profile pin > global, implemented in B5.
- **Transform order:** cleanup(extraSystem) → global dictionary → per-app replacements → boolean transforms (B5 + profiles.ts).
- **Safety:** `getForegroundApp` returns null on any failure (no profile path = today's behavior); all new modules pure/total; `appProfilesEnabled` defaults off.
- **Fixtures:** `config.test`, `pipeline.test`, `cleanup.test` + `DEFAULT_SETTINGS` gain the new fields. `PipelineDeps.getForegroundApp` optional so existing pipeline tests still construct deps without it.
