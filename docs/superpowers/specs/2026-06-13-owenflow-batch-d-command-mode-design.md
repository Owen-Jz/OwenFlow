# OwenFlow Batch D (slice 1) — Command Mode — Design Spec

- **Date:** 2026-06-13
- **Status:** Locked (design approved); → implementation plan
- **Repo:** `OwenFlow` (standalone)
- **Scope:** The **local command channel** + the intent-routing framework. Vault (#3) and ZEAL (#2-as-agent) sinks are wired as **deferred stubs** here; they light up in the VPS slice (which builds `zeal-command`'s `/api/voice` route + the brain-dump pipe). Continuous mode (#6) is a separate later slice.

---

## Goal

A second hotkey for **speak-to-act**: hold it, speak an instruction, release. The transcript is routed by intent:
- `"zeal …"` / `"hey zeal …"` → **ZEAL sink** (deferred — notifies "ZEAL channel not set up yet")
- `"note …"` / `"vault …"` → **vault sink** (deferred — same)
- otherwise → **local text-edit**: apply the instruction to the current selection via the LLM and paste the result.

Dictation (the existing channel) is untouched and never collides with command mode.

## Channels never collide

The command channel and the dictation channel share the one mic/recorder. They coordinate by mutual active-checks (no new shared lock module):
- `command-channel.ts` exports `isCommandActive()`; `pipeline.ts` already exports `isDictationActive()`.
- `startDictation` bails if `isCommandActive()`; `startCommand` bails if `isDictationActive()`. The hotkey layer also won't fire one while the other runs.

## Flow (local sink)

1. **Command hotkey pressed:** acquire (bail if dictation active) → `injector.copySelection()` sends Ctrl+C and reads the clipboard → `target` (the text to edit; may be empty) → save the original clipboard → pill shows recording → recorder starts.
2. **Released:** recorder stops → Whisper transcribes the spoken instruction → `classifyCommand(transcript)` → route.
3. **Local:** `runCommand(instruction, target, settings)` asks the provider to apply the instruction to `target` (or generate from the instruction if `target` is empty) → `injector.inject(result)` pastes (replacing the still-selected text). History records it (`mode: 'command'`).
4. **Failure / empty:** never throws; empty transcript → flash "—"; LLM/inject failure → error pill, original clipboard restored.

## New / changed modules

- **`command.ts` (pure):** `classifyCommand(transcript): { sink: 'zeal' | 'vault' | 'local'; instruction: string }` — case-insensitive leading-keyword match (`zeal`, `hey zeal`, `note`, `vault`), strips the keyword + optional comma from the instruction; everything else → `local` with the full transcript.
- **`cleanup.ts`:** add `runCommand(instruction, target, settings): Promise<string>` — reuses `resolveProvider`; system prompt: *"You apply a spoken editing instruction to the user's text. If text is provided, return the edited text; if no text, fulfill the instruction directly. Output ONLY the resulting text — no preamble or commentary."* user content = `target ? "INSTRUCTION: …\n\nTEXT:\n…" : "INSTRUCTION: …"`. Returns `''` on no key / error (never throws). temperature 0, max_tokens 1500.
- **`injector.ts`:** add `copySelection(): Promise<string>` — extend the warm helper's C# with a `CopyCtrlC()` (SendInput Ctrl+C), send it, wait `COPY_SETTLE_MS` (~120ms), return `clipboard.readText()`. Never throws (returns '' on failure).
- **`command-channel.ts` (main):** `initCommandChannel(deps)`, `startCommand()`, `stopCommand()`, `cancelCommand()`, `isCommandActive()`. Mirrors the dictation half of the pipeline (own generation counter); terminal action routes per `classifyCommand`. Deps injected (recorderStart/Stop, transcribe, copySelection, runCommand, inject, appendHistory, setPillState, getSettings, notify).
- **`hotkey.ts`:** register a SECOND global hotkey (`commandHotkey`) when `commandEnabled`; hold/toggle per the same `mode` setting; routes to start/stopCommand; respects the cross-channel active-checks.
- **`pipeline.ts`:** `startDictation` bails if `isCommandActive()`.
- **`index.ts`:** wire `initCommandChannel` deps (notify, runCommand, copySelection); register the command hotkey; route ZEAL/vault sinks to a `notify("… not set up yet")` stub for now.

## Settings

- `commandEnabled: boolean` (default `false` — opt-in; avoids registering a second global hotkey unexpectedly).
- `commandHotkey: string` (default `'RightAlt'`, uiohook keycode name).
- Settings UI: a "Command mode" card (General or a new section) — enable toggle + hotkey capture + a one-line help of the `zeal/note` prefixes.

## History

Command results are recorded with `mode: 'command'` (raw = spoken instruction, final = pasted result) so they show in History alongside dictations.

## Testing

- `command.test.ts` — `classifyCommand`: zeal/hey-zeal/note/vault prefixes (case-insensitive, comma-tolerant) → correct sink + stripped instruction; no prefix → local with full text; empty → local empty.
- `cleanup.test.ts` (extend) — `runCommand`: posts instruction (+ target) to the provider; no key → ''; includes the target text when provided.
- `command-channel.test.ts` — local path: transcribe → classify → runCommand → inject (mocked deps); zeal/vault → notify stub, no inject; empty transcript → no action; cancel via generation; bails when dictation active.
- `injector` copySelection — parses the helper reply; '' on failure (mock helper I/O if feasible, else covered by build).

## Out of scope (this slice)

- The actual ZEAL `/api/voice` + vault pipe (next slice, needs VPS).
- Continuous/draft mode (#6, later slice).
- A distinct command-channel pill color (reuses existing pill states for v1).
- Configurable routing prefixes (fixed `zeal`/`note`/`vault` for v1).
