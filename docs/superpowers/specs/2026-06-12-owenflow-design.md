# OwenFlow — Local Wispr Flow Clone (Design Spec)

**Date:** 2026-06-12 · **Owner:** Owen · **Status:** Approved for build (Owen pre-approved full pipeline)

## Why

Wispr Flow's usage limits keep interrupting Owen's dictation workflow. OwenFlow replicates the core experience — hold a hotkey, speak, release, and the text appears in whatever app has focus — but runs **100% locally** for transcription (free, unlimited) and is fully customizable.

## Core User Flow

1. Owen holds the push-to-talk hotkey (default: **Right Ctrl**; configurable).
2. A small floating "pill" overlay appears bottom-center showing live recording state.
3. He speaks; on key release the recording stops.
4. Audio → local Whisper sidecar → transcript.
5. (Optional, toggleable) AI cleanup pass: remove fillers ("um", "like"), fix punctuation/casing, apply custom dictionary.
6. Final text is injected into the currently focused app via clipboard-paste (original clipboard restored).
7. Transcript saved to history; pill shows brief "done" state then hides.

Toggle mode (press once to start, again to stop) is also supported as a setting.

## Architecture

```
┌──────────────────────────── Electron (TypeScript) ────────────────────────────┐
│ main process                                                                  │
│  ├─ hotkey.ts        uiohook-napi global keydown/keyup (push-to-talk)         │
│  ├─ sidecar.ts       spawn/health-check Python sidecar (port 8484)            │
│  ├─ pipeline.ts      record → transcribe → cleanup → inject → history         │
│  ├─ injector.ts      clipboard swap + Ctrl+V via persistent PowerShell helper │
│  ├─ cleanup.ts       MiniMax formatting pass (optional, 6s timeout, raw       │
│  │                   fallback on any error)                                   │
│  ├─ config.ts        electron-store JSON settings                             │
│  ├─ history.ts       JSONL append log + read API                              │
│  └─ tray.ts          tray icon/menu (toggle enable, settings, history, quit)  │
│ renderer windows                                                              │
│  ├─ recorder (hidden)  getUserMedia → WAV 16kHz mono → temp file              │
│  ├─ pill overlay       frameless, transparent, always-on-top, click-through   │
│  └─ settings/history   single window, two tabs                                │
└────────────────────────────────────────────────────────────────────────────────┘
                       │ HTTP localhost:8484
┌──────────────────────▼─────────────────────────┐
│ Python sidecar (FastAPI + faster-whisper)       │
│  POST /transcribe  (wav upload + initial_prompt)│
│  GET  /health      (model loaded? model name)   │
│  Model: small / int8 / CPU by default;          │
│  configurable (tiny→large-v3) via env/query.    │
│  Model stays loaded between requests.           │
└─────────────────────────────────────────────────┘
```

### Why these choices
- **Electron + TS:** Owen's primary stack; trivial to customize. Frameless overlay + tray + settings UI come nearly free.
- **Python sidecar with faster-whisper:** most reliable local STT on Windows; Owen already runs faster-whisper on his VPS. Sidecar keeps the model warm so latency ≈ audio_len × ~0.3 on CPU for `small`.
- **uiohook-napi:** only practical way to get global key-*release* events (push-to-talk) in Electron on Windows.
- **Clipboard-paste injection:** what real dictation apps do — works in every app (editors, browsers, Slack), unlike SendKeys character typing which mangles unicode and is slow. PowerShell SendInput helper avoids flaky native npm modules (robotjs/nut-js).
- **MiniMax cleanup optional:** local raw transcript always works even offline/no key; cleanup is an enhancement, never a dependency.

## Components & Contracts

### Sidecar (`sidecar/`)
- `server.py` — FastAPI. `POST /transcribe` multipart (`file`: wav, `prompt`: optional str, `language`: optional) → `{ "text": str, "duration_ms": int, "model": str }`. `GET /health` → `{ "ok": true, "model": "small", "loaded": true }`.
- Model size from `OWENFLOW_MODEL` env (default `small`), device auto (`cuda` if available else `cpu` int8).
- `requirements.txt`, `run.bat` for standalone debugging.

### IPC contracts (renderer ↔ main)
- `recorder:start` / `recorder:stop` → main tells hidden recorder window; recorder replies `recorder:data` with ArrayBuffer WAV.
- `pill:state` → `idle | recording | transcribing | done | error` pushed to overlay.
- `settings:get` / `settings:set` / `history:list` / `history:clear` via `ipcMain.handle`.

### Settings (electron-store)
`hotkey` (keycode, default Right Ctrl), `mode` (`hold`|`toggle`), `model` (whisper size), `language` (auto default), `cleanupEnabled` (bool), `minimaxApiKey`, `minimaxGroupId`, `dictionary` (string[] — fed as whisper initial_prompt AND post-replacement map "wrong=>right"), `launchOnStartup` (bool).

### History
`%APPDATA%/owenflow/history.jsonl` — `{ts, raw, final, durationMs, app?}`. History tab lists newest-first with copy buttons and clear-all.

## Error Handling
- Sidecar down → pill shows error state; main auto-restarts sidecar (max 3 retries, backoff); tray shows status.
- Cleanup failure/timeout (6s) → inject raw transcript silently (never block on AI).
- Empty/silence transcript → pill flashes "—" and injects nothing.
- Injection: clipboard always restored in `finally`; if paste fails, text stays on clipboard and pill says "Copied — paste manually".

## Testing
- Sidecar: e2e script generates speech via `edge-tts` → posts WAV → asserts expected words in transcript.
- Injector: unit-test clipboard swap/restore; manual smoke for paste.
- Pipeline: integration test with mocked sidecar + mocked injector.
- `npm run build` + `npm test` green = ship gate.

## Out of Scope (v1)
Streaming/live partial transcripts, per-app tone profiles, auto-edit commands ("scratch that"), macOS/Linux, installer/auto-update (run via `npm start`; packaging later), voice activity auto-stop.
