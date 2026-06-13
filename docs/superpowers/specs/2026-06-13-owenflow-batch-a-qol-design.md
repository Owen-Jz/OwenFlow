# OwenFlow Batch A — Quick-Win QoL Features — Design Spec

- **Date:** 2026-06-13
- **Status:** Locked (design approved); → implementation plan
- **Repo:** `OwenFlow` (standalone, `github.com/Owen-Jz/OwenFlow`)

Three independent, pipeline-level features. Each degrades gracefully and preserves the existing "dictation never blocks / never throws" contract.

---

## #5 Voice snippets/macros

**Goal:** Say a short trigger ("sign off email") → paste a canned expansion (signature, address, boilerplate) verbatim.

- New setting **`snippets: string[]`** — one `trigger => expansion` per line (same `=>` syntax as the dictionary, but a separate list/field). `\n` in an expansion becomes a real newline.
- New pure module **`snippets.ts`**:
  - `parseSnippets(lines): Snippet[]` where `Snippet = { trigger: string; expansion: string }` (skips malformed/empty; converts `\n`).
  - `matchSnippet(transcript, snippets): string | null` — **whole-utterance, case-insensitive** match; the transcript is trimmed and trailing sentence punctuation (`. ! ?`) stripped before comparison (Whisper often adds a period). Returns the expansion (newlines applied) or `null`.
- **Pipeline:** in `stopDictation`, after `raw` is obtained and the empty-check, **before cleanup**: if `matchSnippet(raw, …)` returns an expansion, set the final text to it and **skip cleanup AND dictionary replacements** (canned text must paste verbatim) → inject → history (records `raw` transcript + the expansion as `final`).
- **Settings UI:** a "Snippets" card on the Dictionary page with a `#f-snippets` textarea (placeholder showing `sign off email=>Best,\nOwen`).

## #10 Local translation mode

**Goal:** Speak in any language → paste a translation (e.g. Pidgin/Spanish → English, or English → a target).

- Add **`translate`** to the `FlowMode` union (`'normal' | 'vibe' | 'formal' | 'translate'`).
- New setting **`translateTarget: string`** (default `'English'`).
- **`cleanup.ts`:** the system prompt becomes dynamic for translate — a helper `systemPromptFor(mode, settings)` returns, for `translate`: `Translate the following dictation into <translateTarget||English>. Output ONLY the translation — no quotes, labels, or commentary. Preserve meaning and tone.` For all other modes it returns the existing static `SYSTEM_PROMPTS[mode]`. (Benchmark keeps using `SYSTEM_PROMPTS.normal`.)
- **Gating:** translate behaves like vibe/formal — always runs when the active provider has a key (ignores `cleanupEnabled`), and is NOT subject to the ≤3-word normal-mode skip. Whisper still auto-detects the spoken language (no language pinning needed).
- **UI:** a 4th mode card "Translate" (Modes page) + a `#f-translate-target` text row shown only when Translate is selected (same show/hide pattern as the Groq rows). Tray **Mode** submenu gains "Translate".

## #9 Speaker-tone per session

**Goal:** Pick an active "session" (client / notes / …) → dictations use that session's tone and are auto-tagged with its label.

- New settings:
  - **`sessionTones: string[]`** — one `label => mode` per line (mode ∈ normal|vibe|formal|translate), e.g. `client => formal`, `notes => normal`.
  - **`activeSession: string`** — the currently selected session label (`''` = none). Persisted.
- New pure module **`sessions.ts`**:
  - `parseSessionTones(lines): SessionTone[]` where `SessionTone = { label: string; mode: FlowMode }` (drops entries whose mode isn't a valid FlowMode).
  - `activeSessionMode(activeLabel, tones): FlowMode | null` — case-insensitive label lookup; `null` if none/unmapped.
- **Pipeline (`stopDictation`):**
  - Effective mode = `activeSessionMode(settings.activeSession, parseSessionTones(settings.sessionTones)) ?? settings.flowMode`. Pass a `{ ...settings, flowMode: effectiveMode }` to `cleanup()`.
  - Auto-tag: when `activeSession` is non-empty, include it (normalized like a tag) in the history entry's `tags`.
- **Tray:** a **Session** submenu — "None" + each configured label as radio items, checked = `activeSession`; clicking sets it (→ `setSettings`, refresh tray). New `TrayCallbacks`: `getSessions()`, `getActiveSession()`, `onSetActiveSession(label)`.
- **Settings UI:** a "Sessions" card — a `#f-session-tones` textarea (`label => mode` lines) + a read-only note of the active session (the live picker lives in the tray).

---

## Cross-cutting

- **Types/config:** add `snippets`, `translateTarget`, `sessionTones`, `activeSession` to `OwenFlowSettings` (+ electron-store schema + `DEFAULT_SETTINGS`); extend the `flowMode` schema enum with `translate`.
- **Order in `stopDictation`:** snippet short-circuit → (else) resolve effective mode → cleanup (with effective mode) → dictionary replacements → inject → history (with session auto-tag).
- **Failure/safety:** all new modules are pure and total (never throw); a malformed snippet/session line is skipped; unknown `activeSession`/`translateTarget` fall back (global mode / "English").

## Testing

- `snippets.test.ts` — parse (incl. `\n`, malformed skip), whole-utterance match (case-insensitive, trailing-punctuation-tolerant), no-match → null.
- `sessions.test.ts` — parse (invalid mode dropped), `activeSessionMode` lookup + none/unmapped → null.
- `cleanup.test.ts` (extend) — translate prompt contains the target language; routes to the selected provider; short transcript still translated; non-translate modes unchanged.
- `pipeline.test.ts` (extend) — snippet match short-circuits (no cleanup/dictionary, injects expansion, history recorded); session mode overrides global flowMode and auto-tags; no active session → unchanged.

## Out of scope (v1)

- Fuzzy/partial snippet triggers (whole-utterance only).
- Per-snippet "run through cleanup anyway" flag.
- Auto-detecting translation direction beyond the single configurable target.
- A settings-window live session picker (tray owns the live switch; settings configures the map).
