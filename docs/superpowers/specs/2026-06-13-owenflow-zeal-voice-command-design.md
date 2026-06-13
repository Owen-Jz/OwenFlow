# OwenFlow → ZEAL Voice Command — Design Spec

- **Date:** 2026-06-13
- **Status:** Locked (design approved); awaiting spec review → implementation plan
- **Author:** Owen + Claude
- **Repo (client):** `owenflow` (this repo)
- **Repo (server companion):** `Owen-Jz/zeal-command` (one new route)

## 1. Goal

Add a second, fully independent voice channel to OwenFlow that lets Owen **speak a command to ZEAL** (the autonomous VPS agent) from anywhere on his PC and get a **spoken + text reply back** — without opening the dashboard or Telegram. Dictation (speech → paste) is untouched and must never cross wires with this new flow.

Sub-agents are **not** built here: ZEAL already orchestrates 5 departments + the swarm + kanban missions. OwenFlow becomes the always-on mic that *triggers* ZEAL's existing sub-agents; ZEAL fans out server-side.

## 2. Core principle — two flows, never crossed

Same mic + Whisper sidecar, but two independent hotkeys and two independent state machines. The instant audio is transcribed, the path forks and shares **no mutable state**.

| | Dictation (existing) | ZEAL command (new) |
|---|---|---|
| Hotkey | Right Ctrl (existing) | Right Alt (new default, configurable) |
| Hold/toggle | honors global `mode` | honors global `mode` |
| After transcribe | cleanup → dictionary → paste | send to ZEAL → surface reply (text + spoken) |
| Terminal action | `inject()` | `zeal.sendCommand()` — **never `inject()`** unless `zealPasteReply` is on |
| Pill accent | red (brand) | distinct accent (e.g. violet) so the live flow is visually obvious |
| Logged to | `history.jsonl` | `commands.jsonl` (separate) |

**Capture lock (the only shared thing):** only one channel can hold the mic at a time. If dictation is recording/processing, the ZEAL hotkey is ignored, and vice versa. A single shared guard enforces this; no other state is shared.

## 3. Architecture (client / OwenFlow side)

### New modules
- **`app/src/main/zeal.ts`** — HTTP client. `sendCommand(transcript, settings): Promise<ZealReply>`.
  - POST `settings.zealEndpoint` with header `Authorization: Bearer <settings.zealApiKey>`.
  - Body: `{ text, source: 'owenflow', ts }`.
  - Response: `{ reply: string, queued?: boolean, actions?: ZealAction[] }`.
  - ~20s timeout (AbortController). Never throws into the flow — returns a typed error result instead.
- **`app/src/main/command.ts`** — the ZEAL flow state machine: `startCommand` / `stopCommand` / `cancelCommand`. Mirrors the dictation half of `pipeline.ts` (record → transcribe) but its terminal action is `zeal.sendCommand` + surface reply. Own `generation` counter; isolated from `pipeline.ts`.
- **`app/src/main/tts.ts`** (or a method on the sidecar client) — request spoken audio for a reply (see §6).

### Changed modules
- **`hotkey.ts`** — register both hotkeys; route dictation hotkey → `pipeline` flow, command hotkey → `command` flow. Enforce the capture lock.
- **`sidecar` (`server.py`)** — add a `/tts` endpoint (see §6).
- **`shared/types.ts`** — new settings fields, `ZealReply`/`ZealAction` types, new IPC channels, new pill states.
- **`config.ts`** — new settings + electron-store schema/defaults.
- **Settings renderer** — new "ZEAL" section.
- **Pill renderer** — command-channel states + audio playback element.

### Capture coordination
A shared `captureChannel: 'dictate' | 'command' | null`. `startDictation`/`startCommand` only proceed when it is `null`; they set it on start and clear it when their flow ends (success, error, or cancel). This is the single point of contact between the two flows.

## 4. Result model — "both, routed by intent"

ZEAL **always returns an immediate reply**, so nothing blocks:
- Quick question → the answer (e.g. "Pipeline today: 3 hot leads, 1 reply pending").
- Action / long work → a confirmation (e.g. "Queued a mission for Forge — on it").

OwenFlow surfaces the reply via:
1. **Pill** — shows the reply text briefly.
2. **Desktop notification** — same text, glanceable on the go.
3. **Spoken aloud (TTS)** — on by default (§6).
4. **Optional paste** — `zealPasteReply` toggle (default off) drops the reply into the focused app.

Long mission *results* land later in ZEAL's **Activity Center** / dashboard, exactly as today. The immediate reply is always an acknowledgement that ZEAL heard the command and what it's doing.

## 5. Failure contract (preserves OwenFlow's philosophy)

- ZEAL unreachable / timeout / non-200 / malformed reply → pill error state + notification ("ZEAL unreachable"), and **the transcript is copied to the clipboard** so the command is never lost.
- The command flow **never** falls back into the dictation paste path.
- Empty/silent transcript → no send (flash "—", like dictation).
- Cancel (Escape) at any stage invalidates the in-flight request via the generation counter; a late reply is discarded and never spoken/pasted.

## 6. Spoken replies (TTS)

- **Voice/engine:** `edge-tts` voice `en-US-AvaNeural` at rate `-5%` (Owen's standard voice-note voice; never robotic SAPI).
- **Where:** new `POST /tts` on the existing Python sidecar (already hosts Whisper). Body `{ text }` → returns MP3 bytes (or a temp file path). Adds `edge-tts` to `sidecar/requirements.txt`.
- **Playback:** sidecar audio → main → pill renderer plays via an `<audio>` element.
- **Interrupt:** Escape (or starting another command) stops playback immediately.
- **Connectivity:** edge-tts needs internet — already required to reach ZEAL, so no new constraint. (Future offline option: local Piper — out of scope for v1.)
- **Setting:** `zealSpeakReplies` — on by default; toggle to mute (meetings).

## 7. Settings & schema additions

Add to `OwenFlowSettings` (with electron-store schema entries + defaults):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `zealEnabled` | boolean | `false` | Master switch for the ZEAL command channel |
| `zealHotkey` | string | `'RightAlt'` | uiohook keycode name for the command hotkey |
| `zealEndpoint` | string | `''` | e.g. `https://173-212-225-7.sslip.io/api/voice` |
| `zealApiKey` | string | `''` | Bearer token (`VOICE_API_KEY`) |
| `zealSpeakReplies` | boolean | `true` | Speak ZEAL replies aloud via TTS |
| `zealPasteReply` | boolean | `false` | Also paste the reply into the focused app |

**Settings UI — new "ZEAL" section:** enable toggle, hotkey capture, endpoint, masked API key, speak-replies toggle, paste-reply toggle, a **"Test connection"** button (pings the endpoint), and a recent-commands log (from `commands.jsonl`).

Nothing changes for existing installs until `zealEnabled` is turned on.

## 8. Server companion (in `zeal-command`, separate task)

One new authenticated route — **`POST /api/voice`**:
- Auth: `Authorization: Bearer <VOICE_API_KEY>` (new env var; mirrors the existing `GOVERNOR_API_KEY` pattern).
- Hands the transcript to the **existing dream-chat tool executor** (the 6-tool one: task / mission / kanban / execute / directive / reaction) with a synthetic "voice" context/session.
- Returns `{ reply: string, queued: boolean, actions: ZealAction[] }`.
- Because the executor already exists, this route is thin (validate → execute → shape response).

This is the only work outside the OwenFlow repo.

## 9. Command log (`commands.jsonl`)

Separate from dictation history (different shape, keeps flows separate). Each line:
`{ ts, text, reply, queued, actions, durationMs, error? }`. Surfaced in the Settings "ZEAL" section as a recent-commands list. Reuses `history.ts` append/list patterns.

## 10. Security

- `zealApiKey` is stored in the local electron-store config; it is a powerful key (can command the agent). Acceptable for a personal single-user desktop tool; documented as such. Masked in the UI.
- Endpoint is HTTPS only.

## 11. Testing

- **`zeal.test.ts`** — request shape + bearer header; success parse; timeout → error result; non-200 → error result; malformed body → error result.
- **`command.test.ts`** — happy path (record → transcribe → send → surface); cancel via generation counter discards late reply; empty transcript → no send; ZEAL error → transcript copied + error pill; capture-lock guard blocks command while dictation active and vice versa.
- **`hotkey` test** — both hotkeys map to their own flows; no overlap.
- **sidecar `/tts`** — returns audio for text; bad/empty input handled.

## 12. Prerequisites / open items

1. Confirm public base URL (`https://173-212-225-7.sslip.io`) is reachable off-tailnet; route = `…/api/voice`.
2. Generate `VOICE_API_KEY`, add to `zeal-command` env (done at server-route implementation time).
3. Default command hotkey = **Right Alt** (locked; configurable in Settings).

## 13. Out of scope (v1)

- Department picker in OwenFlow (ZEAL routes departments itself).
- Offline TTS (Piper).
- Push-back of finished long-mission results to OwenFlow (they appear in Activity Center; a future enhancement could push them to the pill/notification).
- Conversational multi-turn memory in the voice channel (each command is one-shot for v1).

## 14. Related / separate work

Refinement-speed improvement for the **dictation** pipeline (turn off / speed up MiniMax cleanup) is tracked as a **separate spec** — it touches `cleanup.ts`, not this channel. Decision pending (off-switch + local/cloud fast model).
