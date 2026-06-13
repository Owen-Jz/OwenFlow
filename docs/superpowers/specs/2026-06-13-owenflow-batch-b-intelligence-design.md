# OwenFlow Batch B — "It Gets Me" Intelligence — Design Spec

- **Date:** 2026-06-13
- **Status:** Locked (design approved); → implementation plan
- **Repo:** `OwenFlow` (standalone, `github.com/Owen-Jz/OwenFlow`)

Two features. #1 is built first (it adds a new capability); #4 second.

---

## #1 App-aware formatting profiles

**Goal:** Detect the focused app and reshape output before pasting — code-friendly in editors/terminals, prose in browsers, formal in mail, with per-app overrides.

### Foreground-app detection (new capability)
`injector.ts` owns a persistent, pre-warmed PowerShell helper (it P/Invokes `SendInput` for paste). Extend its `Add-Type` C# class with `GetForegroundWindow` + `GetWindowThreadProcessId` and a `GetForegroundExe()` that returns `System.Diagnostics.Process.GetProcessById(pid).ProcessName` (no `.exe`). Export `getForegroundApp(): Promise<string | null>` (one stdin line to the warm helper; ~no latency; returns `null` on any failure — never throws).

- Captured at **`startDictation`** (target app has focus; the pill is a non-activating overlay): kick off `getForegroundApp()` and store `{ gen, app }`; `stopDictation` reads the value for the current generation.

### Profile model (pure module `profiles.ts`)
```ts
interface AppProfile {
  match: string[]            // process names, case-insensitive (e.g. ["Code","Cursor"])
  flowMode?: FlowMode        // pin a mode while this app is focused; omitted = inherit
  stripTrailingPeriod?: boolean
  noAutoCapitalize?: boolean // lowercase the first letter
  singleLine?: boolean       // collapse newlines to spaces
  replacements?: string[]    // per-app "wrong=>right" lines (reuses dictionary parser)
  promptRule?: string        // appended to the cleanup system prompt
}
```
- `matchProfile(app, profiles): AppProfile | null` — first profile whose `match` contains `app` (case-insensitive).
- `applyProfileTransforms(text, profile): string` — applies per-app replacements then the boolean transforms, in that order.
- `profilePromptRule(profile): string` — the rule (or `''`).
- `DEFAULT_PROFILES` — editable presets: `{match:["Code","Cursor"], flowMode:"vibe", stripTrailingPeriod:true, noAutoCapitalize:true, promptRule:"Target is a code editor; keep code identifiers and casing exact."}`, `{match:["WindowsTerminal","powershell","cmd","wezterm","alacritty"], stripTrailingPeriod:true, noAutoCapitalize:true, singleLine:true, promptRule:"Target is a terminal; if this is a shell command, output only the command."}`, `{match:["slack","Discord"], flowMode:"normal"}`, `{match:["OUTLOOK","Mail"], flowMode:"formal"}`.

### Settings
- `appProfilesEnabled: boolean` (default `false` — off = exactly today's behavior; presets seeded but inert until on).
- `profiles: AppProfile[]` (default = `DEFAULT_PROFILES`).
- electron-store schema: `profiles` is an array of objects (match: string[]; the rest optional).

### Pipeline integration (`stopDictation`)
- If `appProfilesEnabled`: `profile = matchProfile(foregroundApp, settings.profiles)`.
- **Effective mode precedence:** session (user-picked, Batch A) → profile.flowMode → global `settings.flowMode`. (A deliberate session pick beats an app default.)
- Pass `profile.promptRule` into `cleanup()` (new optional 3rd arg `extraSystem?: string`, appended to the system prompt; backward compatible; benchmark unaffected).
- Order: cleanup → **global** dictionary replacements → `applyProfileTransforms` (per-app replacements + boolean transforms). Deterministic profile rules get the last word.
- Record `app` on the history entry (fills the existing `HistoryEntry.app` field).

### Settings UI — new "Apps" section
New sidebar nav item. Master enable toggle. A profile-card list: each card has match (text), flow-mode `<select>` (inherit/normal/vibe/formal/translate), three transform checkboxes, a prompt-rule input, a per-app replacements textarea, and Delete. "+ Add profile". A **"Detect current app"** button that calls `getForegroundApp()` (via a new `apps:detect` IPC) and shows the focused process name so you can fill `match` without guessing.

---

## #4 Auto-learning dictionary

**Goal:** Fix a pasted transcript in History → OwenFlow proposes a `wrong=>right` dictionary entry so the same mistake self-corrects next time.

- Pure module **`learn.ts`**: `proposeReplacements(raw, corrected): string[]` — word-level diff between the original transcript and the corrected text; trims the common prefix/suffix and proposes a single `oldspan=>newspan` (lowercased trigger) when there's a clean substitution; returns `[]` when the diff is empty or too divergent (whole-sentence rewrite → no proposal). Pure/total, never throws.
- **History UI:** each entry's final text becomes editable (an "Edit" affordance → textarea seeded with `final`). A **"Learn"** button runs `proposeReplacements(entry.raw, edited)` and shows the proposed `wrong=>right` line(s) with **Add** / dismiss. Adding appends to `settings.dictionary` (dedup) via `settings.set` and toasts confirmation. (v1 does not persist the edited final back to history — learning is the point.)
- No new capability beyond a renderer-side diff + the existing `settings.get/set`.

---

## Testing

- `profiles.test.ts` — match (case-insensitive, no-match→null), each transform + order (replacements before booleans), prompt-rule assembly, presets shape.
- `injector` foreground — `getForegroundApp` parses the helper's `EXE <name>` line; returns null on `ERR`/timeout (mock the helper I/O).
- `cleanup.test.ts` (extend) — `extraSystem` appended to the system prompt; omitted = unchanged.
- `pipeline.test.ts` (extend) — profile pins mode (precedence: session > profile > global); transforms applied after dictionary; `app` recorded; detection-null → no profile path unchanged.
- `learn.test.ts` — single-substitution proposal, common prefix/suffix trim, no-op (identical) → [], whole-rewrite → [].

## Out of scope (v1)

- Window-title matching (exe/process-name only).
- Multi-substitution learning (one proposal per correction).
- Persisting the corrected final back to history.
- Auto-applying learned entries without confirmation.
