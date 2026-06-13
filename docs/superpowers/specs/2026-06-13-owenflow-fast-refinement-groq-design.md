# OwenFlow → Fast Refinement (Groq provider) — Design Spec

- **Date:** 2026-06-13
- **Status:** Locked (design approved); awaiting spec review → implementation plan
- **Repo:** `owenflow` (this repo)
- **Relation:** Separate from the ZEAL voice-command spec; this touches `cleanup.ts` only.

## 1. Problem

The MiniMax cleanup/refinement pass is slow. Root cause (per `cleanup.ts` comments): it uses **MiniMax-M2.5, a reasoning model whose "thinking" can't be disabled** — measured p50 ~2.5s/3.9s (short/long), worst case ~8s. Faster MiniMax variants aren't available on the current key. No prompt-tuning fixes this; the model choice is the bottleneck.

## 2. Goal

Make refinement **fast** while keeping the existing instant off-switch:
- Add **Groq** as a cleanup provider (non-reasoning, sub-second), default it on.
- Keep **MiniMax** selectable as a "max polish" fallback.
- Keep the existing **off** path (raw transcript pastes instantly).

## 3. Design

### Provider abstraction in `cleanup.ts`
MiniMax (`chatcompletion_v2`) and Groq (`/openai/v1/chat/completions`) are both OpenAI-shaped: `messages` in, `choices[0].message.content` out. A small provider table unifies them:

```
PROVIDERS = {
  groq:    { url: 'https://api.groq.com/openai/v1/chat/completions', defaultModel: 'llama-3.3-70b-versatile', keyField: 'groqApiKey' },
  minimax: { url: 'https://api.minimax.io/v1/text/chatcompletion_v2', defaultModel: 'MiniMax-M2.5',           keyField: 'minimaxApiKey' },
}
```

`cleanup()` resolves the active provider from `settings.cleanupProvider`, builds the request with that provider's url/model/key, and parses the (identical-shape) response. **The normal/vibe/formal system prompts are unchanged** — they route to whichever provider is selected.

### Settings additions
| Field | Type | Default | Meaning |
|---|---|---|---|
| `cleanupProvider` | `'groq' \| 'minimax'` | `'groq'` | Which LLM provider runs the refinement pass |
| `groqApiKey` | string | `''` | Groq bearer key (stored locally; never in repo) |
| `groqModel` | string | `'llama-3.3-70b-versatile'` | Groq model; dropdown offers `llama-3.3-70b-versatile` + `llama-3.1-8b-instant` |

`minimaxApiKey` / `minimaxGroupId` remain for the MiniMax provider. Existing `cleanupEnabled` remains the on/off switch (unchanged semantics: normal mode respects it; vibe/formal always run when a key for the active provider exists).

### Timeouts
Groq is fast; keep a generous ceiling (e.g. 15s) but it will typically resolve <1s. Per-provider timeout is fine if needed; not required for v1.

### Behavior preserved
- Off / no key for active provider → raw transcript (existing graceful fallback).
- Short normal-mode dictations (≤3 words) still skip the LLM.
- `cleanup()` still **never throws / never blocks** — any error returns raw.

### Speed comparison ("Test & compare")
A button in Settings that times **both** providers head-to-head so the user can choose with real numbers from their own key + network.

- `cleanup.ts` exports `benchmarkProvider(provider, settings)` — forces a given provider (regardless of `cleanupProvider`), sends a fixed sample sentence with the normal-mode prompt, and returns `{ provider, ok, ms, error? }`. Never throws; missing key → `{ ok: false, error: 'no API key' }`, non-200/timeout → `{ ok: false, error }`.
- `benchmarkProviders(settings)` runs both concurrently (`Promise.all`).
- Exposed to the renderer via a new IPC channel `cleanup:benchmark` → `window.owenflow.cleanup.benchmark()`.
- Uses the **saved** settings (keys), so the UI hint tells the user to Save first.
- Result rendered like `groq: 0.7s  ·  minimax: 4.2s` (or the per-provider error / "no API key").

## 4. Settings UI

In the existing settings form (near the current MiniMax fields):
- **Provider** select: Groq (default) / MiniMax.
- When Groq selected: show `groqApiKey` (masked) + `groqModel` dropdown.
- When MiniMax selected: show existing MiniMax key + group fields.
- Keep the existing "AI refinement (cleanup)" on/off toggle as-is.
- **Test & compare** button + a result line that shows each provider's round-trip time (or error). Hint: "Times both providers with your saved keys — Save first."

## 5. Testing

- `cleanup.test.ts` (extend): provider resolution (groq vs minimax → correct url/model/key/header); Groq success parse; off / missing-key → raw; non-200 → raw; timeout → raw; vibe/formal route to the selected provider.
- `benchmarkProvider`/`benchmarkProviders`: ok timing with a key; forces the requested provider regardless of `cleanupProvider`; `ok:false` + "no API key" when key missing (no fetch); `ok:false` on non-200 (never throws); both providers timed.
- No regression to the normal/vibe/formal prompt content.

## 6. Security

- `groqApiKey` lives in local electron-store config, masked in the UI, never committed. (The key shared during design must be rotated before use.)

## 7. Out of scope (v1)

- Local provider (Ollama/Piper).
- Per-mode provider routing (e.g. Groq for normal, MiniMax for formal) — single global provider for v1.
- Streaming responses.
