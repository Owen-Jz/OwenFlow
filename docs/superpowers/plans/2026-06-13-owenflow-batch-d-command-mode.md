# OwenFlow Batch D (slice 1) — Command Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps. All commands from `app/` (`C:\Users\owen\Downloads\OwenFlow\app`).

**Goal:** A second "command" hotkey for speak-to-act. Transcript routed by intent: `zeal`/`note` prefixes → deferred stub notifications; everything else → local text-edit (apply instruction to the current selection via the LLM, paste result).

**Spec:** `docs/superpowers/specs/2026-06-13-owenflow-batch-d-command-mode-design.md`

**Key architecture:** dictation (`pipeline.ts`) is untouched except a cross-channel guard. The command channel is a parallel state machine (`command-channel.ts`) driven by a separate, simple hold/toggle hotkey module (`command-hotkey.ts`) that shares the already-running uIOhook. They never record simultaneously (mutual `isActive` checks).

---

## Task D1: Settings + types (command channel)

**Files:** `src/shared/types.ts`, `src/main/config.ts`, `tests/config.test.ts`

- [ ] Test: `DEFAULT_SETTINGS.commandEnabled === false`, `DEFAULT_SETTINGS.commandHotkey === 'RightAlt'`.
- [ ] `types.ts` — add to `OwenFlowSettings` (after `digestThemes`):
```ts
  /** Enable the speak-to-act command channel (second hotkey). */
  commandEnabled: boolean
  /** uiohook keycode name for the command hotkey. */
  commandHotkey: string
```
- [ ] `config.ts` — `DEFAULT_SETTINGS`: `commandEnabled: false, commandHotkey: 'RightAlt',`. schema: `commandEnabled: { type: 'boolean', default: false }, commandHotkey: { type: 'string', default: 'RightAlt' },`.
- [ ] `npm run test -- config` PASS; `npm run typecheck:node`. Commit → `feat: command channel settings`.

## Task D2: command.ts (classifyCommand, pure)

**Files:** create `src/main/command.ts`, `tests/command.test.ts`

- [ ] Tests:
```ts
import { describe, expect, it } from 'vitest'
import { classifyCommand } from '../src/main/command'

describe('classifyCommand', () => {
  it('routes a zeal prefix', () => {
    expect(classifyCommand('ZEAL, launch a mission for Forge')).toEqual({ sink: 'zeal', instruction: 'launch a mission for Forge' })
    expect(classifyCommand('hey zeal what is my pipeline')).toEqual({ sink: 'zeal', instruction: 'what is my pipeline' })
  })
  it('routes note/vault prefixes', () => {
    expect(classifyCommand('note: buy milk')).toEqual({ sink: 'vault', instruction: 'buy milk' })
    expect(classifyCommand('vault remember the API idea')).toEqual({ sink: 'vault', instruction: 'remember the API idea' })
  })
  it('defaults to local with the full text', () => {
    expect(classifyCommand('make this a bullet list')).toEqual({ sink: 'local', instruction: 'make this a bullet list' })
  })
  it('is case-insensitive and tolerates empty', () => {
    expect(classifyCommand('  ').sink).toBe('local')
  })
})
```
- [ ] Implement `src/main/command.ts`:
```ts
/**
 * Command-channel intent routing. Pure (no electron). A leading keyword routes
 * the spoken instruction to a sink; the keyword (and an optional comma/colon)
 * is stripped from the instruction. Everything else is a local text-edit.
 */
export type CommandSink = 'zeal' | 'vault' | 'local'
export interface CommandRoute {
  sink: CommandSink
  instruction: string
}

const PREFIXES: Array<{ re: RegExp; sink: CommandSink }> = [
  { re: /^(?:hey\s+)?zeal[\s,:]+/i, sink: 'zeal' },
  { re: /^(?:note|vault)[\s,:]+/i, sink: 'vault' }
]

export function classifyCommand(transcript: string): CommandRoute {
  const text = transcript.trim()
  for (const { re, sink } of PREFIXES) {
    const m = text.match(re)
    if (m) return { sink, instruction: text.slice(m[0].length).trim() }
  }
  return { sink: 'local', instruction: text }
}
```
- [ ] `npm run test -- command` PASS. Commit → `feat: command intent routing module`.

## Task D3: cleanup.runCommand

**Files:** `src/main/cleanup.ts`, `tests/cleanup.test.ts`

- [ ] Tests (import `runCommand`):
```ts
describe('runCommand', () => {
  it('sends instruction + target text to the provider', async () => {
    fetchMock.mockResolvedValue(okResponse('- one\n- two'))
    const out = await runCommand('make a bullet list', 'one two', settings({ cleanupProvider: 'groq', groqApiKey: 'gk' }))
    expect(out).toBe('- one\n- two')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[1].content).toContain('one two')
    expect(body.messages[1].content.toLowerCase()).toContain('make a bullet list')
  })
  it('works with no target (generation)', async () => {
    fetchMock.mockResolvedValue(okResponse('haiku here'))
    expect(await runCommand('write a haiku', '', settings({ cleanupProvider: 'groq', groqApiKey: 'gk' }))).toBe('haiku here')
  })
  it('returns empty string with no key', async () => {
    expect(await runCommand('x', 'y', settings({ groqApiKey: '', cleanupProvider: 'groq' }))).toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
```
- [ ] Implement `runCommand(instruction, target, settings)` in `cleanup.ts` — reuses `resolveProvider`, returns '' on no key/error; system prompt: `'You apply a spoken editing instruction to the user's text. If TEXT is provided, return only the edited text. If no TEXT, fulfill the instruction directly. Output ONLY the resulting text — no preamble, labels, or commentary.'` (mind the apostrophe — use a different phrasing or escape); user content = target.trim() ? `INSTRUCTION: ${instruction}\n\nTEXT:\n${target}` : `INSTRUCTION: ${instruction}`. temperature 0, max_tokens 1500. Never throws.
- [ ] `npm run test -- cleanup` PASS; `npm run typecheck:node`. Commit → `feat: cleanup.runCommand for command mode`.

## Task D4: injector.copySelection

**Files:** `src/main/injector.ts`

- [ ] Extend the helper C# (`ADD_TYPE_LINE`) with a Ctrl+C method, mirroring `PasteCtrlV`. Add inside `OwenFlowInput` (single-quote-free, double quotes only):
```
'public static void CopyCtrlC(){' +
'INPUT[] inputs=new INPUT[4];' +
'inputs[0].type=1;inputs[0].ki.wVk=0x11;' +
'inputs[1].type=1;inputs[1].ki.wVk=0x43;' +
'inputs[2].type=1;inputs[2].ki.wVk=0x43;inputs[2].ki.dwFlags=2;' +
'inputs[3].type=1;inputs[3].ki.wVk=0x11;inputs[3].ki.dwFlags=2;' +
'uint sent=SendInput(4u,inputs,Marshal.SizeOf(typeof(INPUT)));' +
'if(sent!=4u){throw new Exception("SendInput failed: "+Marshal.GetLastWin32Error());}' +
'}' +
```
(0x43 = VK_C. Place it inside the class, before the class-closing `}` fragment.)
- [ ] Add `COPY_SETTLE_MS = 140` and a `COPY_LINE = "try{[OwenFlowInput]::CopyCtrlC();[Console]::Out.WriteLine('OK')}catch{[Console]::Out.WriteLine('ERR ' + $_.Exception.Message)}"`.
- [ ] Export:
```ts
/** Copy the current selection (Ctrl+C) and return the clipboard text. '' on failure. */
export async function copySelection(): Promise<string> {
  try {
    await ensureHelper()
    const proc = helper
    if (!proc?.stdin) return ''
    const reply = nextLine(PASTE_TIMEOUT_MS)
    proc.stdin.write(COPY_LINE + '\n')
    const line = await reply
    if (line !== 'OK') return ''
    await delay(COPY_SETTLE_MS)
    return clipboard.readText()
  } catch {
    return ''
  }
}
```
- [ ] `npm run typecheck:node` + `npm run build`. Manually re-read the final `ADD_TYPE_LINE`: braces balanced, no single quotes, class closes correctly. Commit → `feat: injector.copySelection (Ctrl+C grab)`.

## Task D5: command-channel.ts

**Files:** create `src/main/command-channel.ts`, `tests/command-channel.test.ts`

- [ ] DI-based state machine mirroring the dictation half of `pipeline.ts`. Deps:
```ts
interface CommandDeps {
  setPillState: (s: PillState) => void
  recorderStart: () => void
  recorderStop: () => Promise<ArrayBuffer>
  getSettings: () => OwenFlowSettings
  appendHistory: (e: HistoryEntry) => void
  transcribe: (wav: ArrayBuffer, settings: OwenFlowSettings) => Promise<{ text: string; durationMs: number }>
  copySelection: () => Promise<string>
  runCommand: (instruction: string, target: string, settings: OwenFlowSettings) => Promise<string>
  inject: (text: string) => Promise<void>
  notify: (title: string, body: string) => void
}
```
Exports `initCommandChannel(deps)`, `startCommand()`, `stopCommand()`, `cancelCommand()`, `isCommandActive()`. Own `generation` counter + `recording`/`processing` flags (same cancellation pattern as pipeline). `startCommand`: bail if already active; grab `target = await copySelection()` BEFORE recording; set pill recording; recorderStart. `stopCommand`: recorderStop → transcribe → `classifyCommand`:
  - `local`: `result = await runCommand(instruction, target, settings)`; if result → inject + appendHistory({raw: instruction, final: result, mode: 'command', ...}); else error pill.
  - `zeal`/`vault`: `notify('Command channel', 'ZEAL/vault voice commands aren't set up yet.')` (mind apostrophe), no inject. (Stub until the VPS slice.)
  Honor the generation guard after every await; empty transcript → flash '—'.
- [ ] Tests (`command-channel.test.ts`) with mocked deps: local path injects the runCommand result + records history (mode 'command'); zeal/vault → notify called, inject NOT called; empty transcript → no inject; classify uses the transcript. Mirror `pipeline.test.ts`'s `makeDeps`/`runDictation` harness style.
- [ ] `npm run test -- command-channel` PASS. Commit → `feat: command channel orchestration`.

## Task D6: command-hotkey.ts + pipeline guard

**Files:** create `src/main/command-hotkey.ts`, `src/main/pipeline.ts`

- [ ] `command-hotkey.ts`: a SIMPLE second hotkey (hold + toggle, no combo/tap-lock). Attaches its OWN `uIOhook.on('keydown'|'keyup', …)` listeners (uIOhook is already started by `hotkey.ts` — do NOT call start/stop here). Reuse `resolveHotkeyKeycode`/`KEY_MAP` from `hotkey.ts` (export them if needed). API:
```ts
interface CommandHotkeyOptions {
  hotkey: string
  mode: DictationMode
  isEnabled: () => boolean        // commandEnabled && tray enabled
  onStart: () => void
  onStop: () => void
  isActive: () => boolean         // isCommandActive()
  onCancel: () => void
}
export function startCommandHotkey(opts): void  // registers listeners
export function reconfigureCommandHotkey(hotkey, mode, enabled): void
export function stopCommandHotkey(): void        // removes its listeners
```
Hold mode: keydown (its keycode, repeat-guarded) → if enabled & not active → onStart; keyup → onStop. Toggle: keydown flips. Escape while `isActive()` → onCancel. Keep it small; no combo support (command hotkey is a single key).
- [ ] `pipeline.ts`: in `startDictation`, bail early if `isCommandActive()` (import from `./command-channel`). And `command-channel.startCommand` already bails if dictation active via an injected `isDictationActive` check OR import `isDictationActive` from `./pipeline`. Wire both guards.
- [ ] `npm run typecheck:node` + `npm run build`. (Hotkey is hard to unit-test; build-verified.) Commit → `feat: command hotkey + cross-channel guards`.

## Task D7: index.ts wiring

**Files:** `src/main/index.ts`

- [ ] `initCommandChannel({ setPillState, recorderStart, recorderStop, getSettings, appendHistory: history.append, transcribe: (wav, s) => transcribe(wav, parseDictionary(s.dictionary).promptWords.join(', ') || undefined, s.language || undefined), copySelection, runCommand, inject, notify })`.
- [ ] Register the command hotkey after `startHotkey(...)`:
```ts
startCommandHotkey({
  hotkey: initial.commandHotkey,
  mode: initial.mode,
  isEnabled: () => dictationEnabled && getSettings().commandEnabled,
  onStart: () => void startCommand(),
  onStop: () => void stopCommand(),
  isActive: () => isCommandActive(),
  onCancel: () => cancelCommand()
})
```
- [ ] In `onSettingsChange`, when `commandHotkey`/`commandEnabled`/`mode` change → `reconfigureCommandHotkey(next.commandHotkey, next.mode, next.commandEnabled)`.
- [ ] On quit (where `stopHotkey()` is called), also `stopCommandHotkey()`.
- [ ] Import `copySelection` from `./injector`, `runCommand` from `./cleanup`, `initCommandChannel`/`startCommand`/`stopCommand`/`cancelCommand`/`isCommandActive` from `./command-channel`, `startCommandHotkey`/`reconfigureCommandHotkey`/`stopCommandHotkey` from `./command-hotkey`. Reuse the existing `notify` helper (from Batch C).
- [ ] `npm run typecheck:node` + `npm run build`. Commit → `feat: wire command channel + hotkey`.

## Task D8: Settings UI (Command mode card)

**Files:** `src/renderer/settings.html`, `src/renderer/src/settings.ts`

- [ ] A "Command mode" card (General page): `#f-command-enabled` checkbox, `#f-command-hotkey` text input (hint: "uiohook keycode, e.g. RightAlt"), and a `.hint` line: 'Say "ZEAL …" or "note …" to route; anything else edits your selection.' Wire refs + `fillForm` (`fCommandEnabled.checked = s.commandEnabled; fCommandHotkey.value = s.commandHotkey`) + `readForm` (`commandEnabled: fCommandEnabled.checked, commandHotkey: fCommandHotkey.value.trim() || 'RightAlt'`). `npm run typecheck` + `npm run build`. Commit → `feat: command mode settings UI`.

## Task D9: Docs + verify + push

- [ ] README: document command mode (second hotkey, zeal/note routing deferred, local text-edit). `npm run test` (all green, counts), `npm run build`. Commit → `docs: command mode`. `git push`.

---

## Self-Review Notes
- Pure modules (`command.ts`) + `runCommand` + `command-channel` (DI) are unit-tested; hotkey/injector/wiring are build-verified + need a human GUI smoke.
- Cross-channel safety: dictation and command never record together (mutual `isActive` guards + hotkey `isEnabled`).
- ZEAL/vault sinks are deferred stubs (notify) — framework ready for the VPS slice.
- Watch the embedded-C# apostrophe/brace rules in D4 (same discipline as the Batch B foreground-detection edit), and apostrophes in D3/D5 system-prompt/notify strings.
- Fixtures: config/cleanup + DEFAULT_SETTINGS gain command fields. New pill usage reuses existing states.
