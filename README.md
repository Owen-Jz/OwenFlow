# OwenFlow

A local, unlimited [Wispr Flow](https://wisprflow.ai) clone for Windows. Hold a hotkey, speak, release — your words are transcribed **locally with Whisper** (no usage limits, no cloud STT) and typed into whatever app has focus.

## How it works

```
Hold Right Ctrl ──► mic records ──► release ──► faster-whisper (local sidecar)
        ──► optional MiniMax cleanup (fillers/punctuation) ──► pasted into focused app
```

- **Electron app** (`app/`) — tray icon, floating recording pill, settings + history UI, global push-to-talk hook, clipboard-paste injection.
- **Python sidecar** (`sidecar/`) — FastAPI + faster-whisper on `127.0.0.1:8484`, model stays warm between dictations.

## Install (packaged app)

```powershell
cd app
npm run build:win        # produces dist\owenflow-<version>-setup.exe
```

Run the setup exe — it installs OwenFlow with a desktop + Start-menu shortcut and bundles the sidecar. **Python 3.13 with the sidecar deps must still be installed** (`pip install -r sidecar\requirements.txt` once via `py -3.13 -m pip`); the app launches the sidecar with `py -3.13`.

## Setup (dev mode)

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
- **Cleanup (optional):** add your MiniMax API key in Settings to strip filler words and fix punctuation. If it's off, slow, or fails, the raw transcript is pasted — dictation never blocks on AI. Refinement defaults to **Groq** (`llama-3.3-70b-versatile`, sub-second); add a Groq API key in Settings → Modes. MiniMax stays selectable as a slower max-polish option, and a **Test & compare** button times both providers head-to-head.
- **Dictionary:** one entry per line in Settings. Plain words bias recognition (e.g. `Cresio, Fluxboard, ZEAL`); `wrong=>right` entries are find/replace fixes.
- **History:** tray → History for recent transcripts with copy buttons.
- **Snippets:** say a saved trigger ("sign off email") and its expansion is pasted verbatim (skips AI cleanup) — configure in Settings → Dictionary.
- **Translate mode:** a flow mode that transcribes any spoken language and pastes a translation into your target language (set the target in Settings).
- **Sessions:** pick an active session from the tray (e.g. client / notes); its tone is applied automatically and each dictation is tagged with the session label.

## Customizing

| Want to change… | Look in |
|---|---|
| Whisper model size / language | Settings UI, or `OWENFLOW_MODEL` env for the sidecar |
| Pill look & feel | `app/src/renderer/pill/` |
| Refinement provider (Groq default / MiniMax) | Settings → Modes, or `app/src/main/cleanup.ts` |
| Injection method | `app/src/main/injector.ts` |
| Hotkey behavior | `app/src/main/hotkey.ts` |

Design spec: `docs/superpowers/specs/2026-06-12-owenflow-design.md`.
