# OwenFlow Gap-Closure Roadmap

All feature gaps identified 2026-07-06 (Wispr Flow parity audit + meeting-tool landscape + codebase review), mapped to six waves. Each wave is one self-contained implementation plan producing working, testable software. Wave plans are authored (via superpowers:writing-plans) when the wave is reached, against the then-current codebase.

| Wave | Plan file | Gaps covered | Status |
|---|---|---|---|
| **A — Robustness + meeting loop** | `2026-07-06-wave-a-robustness-meeting-loop.md` | Provider failover on HTTP errors (429/5xx → other provider, cleanup + chatOnce); meeting auto-detect (mic-in-use → offer to record); action items → ZEAL (close the meeting loop) | **SHIPPED v1.10.0 (commit e44d84b), 433 tests. SDD: 7 tasks + fix wave, all reviewed clean.** |
| **B — Accuracy / context** | `2026-07-07-wave-b-context-awareness.md` | Context awareness (Windows UIA: read focused field + browser URL → feed cleanup); editor symbol biasing (open-editor identifiers → Whisper bias prompt) | **SHIPPED v1.11.0 (commit 63499dc), 453 tests. Opt-in (default OFF, Owen's choice). SDD: 6 tasks + 1 fix, all reviewed clean. `@file` tagging deferred.** Follow-up ticket: request-id nonce to retire the FIFO desync shared by injector.ts + uia.ts helpers. |
| **C — Meeting depth** | `wave-c-meeting-depth.md` (to author) | Live floating transcript panel; multi-speaker diarization (pyannote, sidecar-side); search across meeting transcripts; calendar linkage (auto-title from Google Calendar via comms-faucet creds) | not started |
| **D — Input & feel** | `wave-d-input-feel.md` (to author) | Real-time typing (progressive paste); terminal hardening (long-prompt chunking for AI CLIs + Shift+Insert fallback); whisper-quiet-speech mode (input gain + tuned decode); Mouse Flow (side-button PTT) | not started |
| **E — QoL** | `wave-e-qol.md` (to author) | Scratchpad (floating dictation notepad); dictionary starring/priority; settings + dictionary + snippets export/import | not started |
| **F — Distribution** | `wave-f-distribution.md` (to author) | Auto-update (electron-updater, generic provider → VPS static dir behind existing traefik — private GitHub repo rules out the GitHub provider); self-contained Python sidecar bundle (no py -3.13 prerequisite) | not started |

Ordering rationale: A is hours-scale and closes live pain (shared Groq key 429s paste raw today; forgotten meetings are unrecoverable; action items die in the summary). B is the single biggest accuracy differentiator. C–E deepen what exists. F makes OwenFlow shippable to machines that aren't this one.

Explicitly deferred (revisit on demand): Wispr team features, per-conversation style pill, 100-language parity marketing claims — no daily value for a single-user local tool.

## Carry-over minors from the Wave A final review (fold into a later wave)
- ConsentStore `isSelfApp` matches the `owenflow` substring anywhere in a path (harmless in production; tighten to a path-segment match if a plugin ecosystem ever ships).
- `extractActionItems` uses maxTokens=600 + a greedy `/\[…\]/` parse — a very long action list can truncate before the closing `]` and silently yield "No action items found". Raise the budget or log the truncation.
- ZEAL task title uses the short recorded date (`meta.title || "Jul 6"`) while the detail view shows the full friendly title — main can't reach the renderer's `meetingDisplayTitle`. Cosmetic; unify if a shared formatter lands.
- `meeting:actions` handler has no outer try/catch (matches the summarize handler); a `writeMeta` throw after a successful ZEAL send would show "failed" though tasks were filed. Low-probability, cosmetic.
