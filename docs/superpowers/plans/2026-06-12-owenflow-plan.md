# OwenFlow Implementation Plan

Spec: `docs/superpowers/specs/2026-06-12-owenflow-design.md`

## Task breakdown (agent assignments)

### Wave 1 — parallel
**Task A — Python STT sidecar** (`sidecar/`)
- FastAPI server: `POST /transcribe` (multipart wav + optional prompt/language) → `{text, duration_ms, model}`; `GET /health`.
- faster-whisper, model from `OWENFLOW_MODEL` env (default `small`), cuda-if-available else cpu/int8, model loaded once at startup.
- `requirements.txt`, `run.bat`, `test_sidecar.py` (edge-tts generates known speech → assert transcript contains expected words).
- Done when: `python test_sidecar.py` passes locally.

**Task B — Electron scaffold + UI** (`app/`)
- electron-vite + TypeScript. Windows: hidden recorder (getUserMedia → 16kHz mono WAV encode), pill overlay (frameless/transparent/always-on-top/click-through, bottom-center, states: idle/recording/transcribing/done/error), settings+history window (two tabs).
- main: `config.ts` (electron-store, schema per spec), `history.ts` (JSONL), `tray.ts`, IPC handlers per spec contracts. Stub `pipeline.ts` so app boots without sidecar.
- Done when: `npm run build` green, app launches showing tray + overlay reacts to test IPC.

### Wave 2 — after A & B
**Task C — Core pipeline wiring** (in `app/`)
- `hotkey.ts` (uiohook-napi hold + toggle modes, configurable keycode), `sidecar.ts` (spawn python server, health poll, 3-retry backoff), `injector.ts` (clipboard save → set → Ctrl+V via persistent PowerShell SendInput helper → restore in finally), `cleanup.ts` (MiniMax, 6s timeout, raw fallback), full `pipeline.ts` (record→transcribe→cleanup→dictionary replacements→inject→history), wire settings live-reload.
- Tests: pipeline integration with mocked sidecar+injector; injector clipboard restore unit test.

### Wave 3 — integration (orchestrator)
- End-to-end smoke: start sidecar, run app, scripted IPC dictation pass.
- Root `README.md` (setup, first-run model download note, usage, customization map), `start.bat` / `npm start` convenience.
- Commit (scoped paths only — repo is the shared Projects mega-repo).
