# OwenFlow

A local, unlimited [Wispr Flow](https://wisprflow.ai) clone for Windows. Hold a hotkey, speak, release — your words are transcribed **locally with Whisper** (no usage limits, no cloud STT) and typed into whatever app has focus.

## How it works

```
Hold Right Ctrl ──► mic records ──► release ──► faster-whisper (local sidecar)
        ──► optional MiniMax cleanup (fillers/punctuation) ──► pasted into focused app
```

- **Electron app** (`app/`) — tray icon, floating recording pill, settings + history UI, global push-to-talk hook, clipboard-paste injection.
- **Python sidecar** (`sidecar/`) — FastAPI + faster-whisper on `127.0.0.1:8484`, model stays warm between dictations.

## Setup

```powershell
# 1. Sidecar (one-time; first run downloads the Whisper model ~460MB)
cd sidecar
pip install -r requirements.txt
python test_sidecar.py   # optional sanity check

# 2. App
cd ..\app
npm install
npm run dev              # or: npm run build && npm start
```

The app spawns the sidecar automatically on launch. Tray icon → Settings to configure.

## Usage

- **Hold Right Ctrl** (default) and speak; release to transcribe and paste. Configurable hotkey + a press-to-toggle mode in Settings.
- **Cleanup (optional):** add your MiniMax API key in Settings to strip filler words and fix punctuation. If it's off, slow, or fails, the raw transcript is pasted — dictation never blocks on AI.
- **Dictionary:** one entry per line in Settings. Plain words bias recognition (e.g. `Cresio, Fluxboard, ZEAL`); `wrong=>right` entries are find/replace fixes.
- **History:** tray → History for recent transcripts with copy buttons.

## Customizing

| Want to change… | Look in |
|---|---|
| Whisper model size / language | Settings UI, or `OWENFLOW_MODEL` env for the sidecar |
| Pill look & feel | `app/src/renderer/pill/` |
| Cleanup prompt / provider | `app/src/main/cleanup.ts` |
| Injection method | `app/src/main/injector.ts` |
| Hotkey behavior | `app/src/main/hotkey.ts` |

Design spec: `docs/superpowers/specs/2026-06-12-owenflow-design.md`.
