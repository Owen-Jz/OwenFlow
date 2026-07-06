# Wave A: Robustness + Meeting Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three live-pain gaps: LLM cleanup fails over to the other provider on HTTP errors (not just missing keys), OwenFlow detects when a call starts and offers to record it, and meeting action items ship to ZEAL with one click.

**Architecture:** Three independent features on the existing v1.9.1 codebase. (1) `cleanup()`'s single fetch is extracted into an `attemptChat` helper; on a null result the other provider (when keyed) gets one retry before the raw-transcript fallback. (2) A new `meeting-detect.ts` polls Windows' microphone ConsentStore registry every 20s; a non-OwenFlow app actively holding the mic with no meeting recording triggers a click-to-start notification (10-min cooldown). (3) `meeting-summary.ts` gains a fast-tier action-item extractor (strict-JSON contract + tolerant parser); a new `meeting:actions` IPC extracts + sends via the existing `sendZealCommand`, stamps `actionsSentAt`, and the detail view gets the button.

**Tech Stack:** Electron 39 main/renderer (TypeScript strict), vitest, Windows `reg query` (ConsentStore), existing Groq/MiniMax chat plumbing, ZEAL `/api/voice`.

## Global Constraints

- Repo: `C:\Users\owen\Downloads\OwenFlow`, branch `main`, baseline v1.9.1 (408 vitest green).
- Never-throw contract for all LLM/network paths: any failure degrades gracefully (raw transcript, `[]`, `{ok:false}`) — never a rejected promise into the pipeline.
- Heavily-commented "why" style; match surrounding code. TypeScript strict; `npm run typecheck` must stay clean.
- All tests via `cd C:\Users\owen\Downloads\OwenFlow\app; npx vitest run` — full suite green before every commit.
- Windows-only APIs are acceptable (app is Windows-only).
- Commit messages: conventional commits, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

---

### Task 1: Provider failover on HTTP errors in `cleanup()`

Today `resolveProvider` falls back to the other provider only when the selected one has **no key**. A 429/5xx/timeout from Groq (key shared with transcript-vault) pastes the raw transcript. Fix: one retry on the other provider when it has a key.

**Files:**
- Modify: `app/src/main/cleanup.ts` (the `resolveProvider` return type, and the `cleanup()` fetch body ~lines 270–345)
- Test: `app/tests/cleanup.test.ts`

**Interfaces:**
- Consumes: existing `resolveProvider(settings, name, allowFallback, tier)`, `wrapTranscript`, `stripEchoedDelimiters`, `driftsFromTranscript`, `systemPromptFor`, `TIMEOUT_MS`, `MAX_TOKENS`.
- Produces: `resolveProvider` now returns `{ url, apiKey, model, provider: CleanupProvider }`; private `attemptChat(target: {url; apiKey; model}, system: string, user: string, timeoutMs: number): Promise<string | null>` (null = any failure). External behavior of `cleanup()` unchanged except the new retry.

- [ ] **Step 1: Write the failing tests** (in the existing `describe('cleanup')` block, new `describe('provider failover on errors')`):

```ts
describe('provider failover on errors', () => {
  it('retries on minimax when groq returns 429, and returns its reply', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(okResponse('So raw text here.'))
    await expect(
      cleanup(RAW, settings({ cleanupProvider: 'groq', groqApiKey: 'gk' }))
    ).resolves.toBe('So raw text here.')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.minimax.io/v1/text/chatcompletion_v2')
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer test-key')
  })

  it('retries on groq when minimax network-errors', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(okResponse('So raw text here.'))
    await expect(
      cleanup(RAW, settings({ cleanupProvider: 'minimax' }))
    ).resolves.toBe('So raw text here.')
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.groq.com/openai/v1/chat/completions')
  })

  it('returns raw when BOTH providers fail', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }))
    await expect(cleanup(RAW, settings({ cleanupProvider: 'groq', groqApiKey: 'gk' }))).resolves.toBe(RAW)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry when the other provider has no key', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 429 }))
    await expect(
      cleanup(RAW, settings({ cleanupProvider: 'groq', groqApiKey: 'gk', minimaxApiKey: '' }))
    ).resolves.toBe(RAW)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('the drift guard still applies to the retry reply (normal mode)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('nope', { status: 429 }))
      .mockResolvedValueOnce(okResponse('Completely invented answer text here instead.'))
    await expect(cleanup(RAW, settings({ cleanupProvider: 'groq', groqApiKey: 'gk' }))).resolves.toBe(RAW)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd C:\Users\owen\Downloads\OwenFlow\app; npx vitest run tests/cleanup.test.ts`
Expected: the 5 new tests FAIL (single fetch call today; raw returned on 429).

- [ ] **Step 3: Implement** — in `cleanup.ts`:

3a. Extend `resolveProvider`'s return with the chosen provider name (update its return type annotation and final statement):

```ts
  return { url: provider.url, apiKey: keyFor(settings, chosen), model, provider: chosen }
```

3b. Extract the fetch body of `cleanup()` into a private helper directly above `cleanup()` (moves the existing AbortController/parse/strip logic; `null` = failed so the caller decides the fallback):

```ts
/**
 * One chat attempt against one provider. Returns the trimmed, delimiter-
 * stripped reply, or null on ANY failure (non-200, timeout, network, empty
 * body) so the caller can decide whether a second provider gets a try.
 */
async function attemptChat(
  target: { url: string; apiKey: string; model: string },
  system: string,
  user: string,
  timeoutMs: number
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${target.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: target.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: 0,
        max_tokens: MAX_TOKENS
      }),
      signal: controller.signal
    })
    if (!res.ok) {
      console.warn(`[cleanup] ${target.model} HTTP ${res.status}`)
      return null
    }
    const data = (await res.json()) as ChatResponse
    return stripEchoedDelimiters(data.choices?.[0]?.message?.content?.trim() ?? '') || null
  } catch (err) {
    console.warn(`[cleanup] ${target.model} attempt failed:`, err instanceof Error ? err.message : err)
    return null
  } finally {
    clearTimeout(timer)
  }
}
```

3c. Rewrite `cleanup()`'s tail (everything from the current `const controller = new AbortController()` down to the final `return text`) as:

```ts
  const system = [TRANSCRIPT_CONTRACT, systemPromptFor(mode, settings), extraSystem]
    .filter(Boolean)
    .join('\n')
  const user = wrapTranscript(raw)

  let text = await attemptChat(primary, system, user, TIMEOUT_MS)
  if (text === null) {
    // One retry on the OTHER provider when it's keyed — a shared-key 429 or a
    // provider outage shouldn't silently cost the user their cleanup pass.
    // Shorter timeout: the user is already waiting behind the failed attempt.
    const otherName: CleanupProvider = primary.provider === 'groq' ? 'minimax' : 'groq'
    const other = resolveProvider(settings, otherName, false, mode === 'normal' ? 'fast' : 'flagship')
    if (other.apiKey) {
      console.warn(`[cleanup] ${primary.provider} failed — retrying on ${otherName}`)
      text = await attemptChat(other, system, user, FAILOVER_TIMEOUT_MS)
    }
  }
  if (!text) return raw
  // Last line of defense: if a normal-mode reply drifted from what was said
  // (the model answered/elaborated despite the contract), paste the raw
  // transcript — wrong-but-verbatim beats fluent-but-invented.
  if (mode === 'normal' && driftsFromTranscript(raw, text)) {
    console.warn(`[cleanup] reply drifted from the transcript (${mode}) — using raw`)
    return raw
  }
  return text
```

where the existing `const { url, apiKey, model } = resolveProvider(...)` destructure becomes `const primary = resolveProvider(...)` (same args), the existing `if (!apiKey) return raw` becomes `if (!primary.apiKey) return raw`, and a new constant sits next to `TIMEOUT_MS`:

```ts
/** Retry attempt budget — the user already waited out the primary's failure. */
const FAILOVER_TIMEOUT_MS = 8_000
```

- [ ] **Step 4: Run the full cleanup suite**

Run: `npx vitest run tests/cleanup.test.ts`
Expected: ALL pass (new 5 + existing; the old single-fetch tests still pass because success paths make exactly one call).

- [ ] **Step 5: Full suite + typecheck, then commit**

Run: `npx vitest run` (expect 413) and `npm run typecheck` (clean).

```bash
git add app/src/main/cleanup.ts app/tests/cleanup.test.ts
git commit -m "fix: fail over to the other provider on HTTP errors, not just missing keys

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: ConsentStore parser (pure) — who is using the microphone

Windows tracks per-app mic usage in the registry: `HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged\<exe-path-with-#>` with `LastUsedTimeStart`/`LastUsedTimeStop` REG_QWORD values; an app is live on the mic when `Stop == 0` and `Start != 0`. This is the same signal Windows' own "mic in use" tray icon uses — it fires for Zoom, Teams, Chrome (Meet), WhatsApp, everything.

**Files:**
- Create: `app/src/main/meeting-detect.ts`
- Test: `app/tests/meeting-detect.test.ts` (new)

**Interfaces:**
- Consumes: nothing (pure string parsing).
- Produces: `parseConsentStore(regOutput: string): string[]` (exe paths, `#`→`\`, currently holding the mic); `isSelfApp(path: string): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { isSelfApp, parseConsentStore } from '../src/main/meeting-detect'

const REG = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Users#owen#AppData#Local#Programs#OwenFlow#OwenFlow.exe',
  '    LastUsedTimeStart    REG_QWORD    0x1dc4f2a8e33f2a0',
  '    LastUsedTimeStop     REG_QWORD    0x0',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Users#owen#AppData#Local#Zoom#bin#Zoom.exe',
  '    LastUsedTimeStart    REG_QWORD    0x1dc4f2a8e4411b0',
  '    LastUsedTimeStop     REG_QWORD    0x0',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Program Files#Slack#slack.exe',
  '    LastUsedTimeStart    REG_QWORD    0x1dc4f00000000000',
  '    LastUsedTimeStop     REG_QWORD    0x1dc4f11111111111'
].join('\r\n')

describe('parseConsentStore', () => {
  it('returns only apps with Start set and Stop == 0 (live on the mic)', () => {
    expect(parseConsentStore(REG)).toEqual([
      'C:\\Users\\owen\\AppData\\Local\\Programs\\OwenFlow\\OwenFlow.exe',
      'C:\\Users\\owen\\AppData\\Local\\Zoom\\bin\\Zoom.exe'
    ])
  })

  it('returns [] on empty/garbage input', () => {
    expect(parseConsentStore('')).toEqual([])
    expect(parseConsentStore('ERROR: The system was unable to find the specified registry key')).toEqual([])
  })

  it('ignores an entry whose Start is 0 even when Stop is 0 (never used)', () => {
    const never = REG.replace('0x1dc4f2a8e4411b0', '0x0')
    expect(parseConsentStore(never)).toEqual([
      'C:\\Users\\owen\\AppData\\Local\\Programs\\OwenFlow\\OwenFlow.exe'
    ])
  })
})

describe('isSelfApp', () => {
  it('flags OwenFlow and dev-mode electron binaries', () => {
    expect(isSelfApp('C:\\Users\\owen\\AppData\\Local\\Programs\\OwenFlow\\OwenFlow.exe')).toBe(true)
    expect(isSelfApp('C:\\repo\\node_modules\\electron\\dist\\electron.exe')).toBe(true)
    expect(isSelfApp('C:\\Users\\owen\\AppData\\Local\\Zoom\\bin\\Zoom.exe')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/meeting-detect.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** in `app/src/main/meeting-detect.ts`:

```ts
/**
 * Call detection via Windows' microphone ConsentStore: the OS records, per
 * exe, when it last started/stopped using the mic (this powers the tray
 * "microphone in use" indicator). An app with LastUsedTimeStart != 0 and
 * LastUsedTimeStop == 0 is holding the mic RIGHT NOW — Zoom, Teams, Chrome
 * running Meet, WhatsApp calls all show up here with zero per-app logic.
 */

const KEY_MARKER = '\\ConsentStore\\microphone\\NonPackaged\\'

/** Exe paths currently holding the mic, from `reg query <key> /s` output. */
export function parseConsentStore(regOutput: string): string[] {
  const live: string[] = []
  let app: string | null = null
  let start = 0n
  let stop = 0n
  const flush = (): void => {
    if (app && start !== 0n && stop === 0n) live.push(app)
  }
  for (const line of regOutput.split(/\r?\n/)) {
    const marker = line.indexOf(KEY_MARKER)
    if (line.startsWith('HKEY_') && marker >= 0) {
      flush()
      // exe paths are stored with '#' standing in for '\'
      app = line.slice(marker + KEY_MARKER.length).replace(/#/g, '\\')
      start = 0n
      stop = 0n
      continue
    }
    const value = /^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+(0x[0-9a-fA-F]+)/.exec(line)
    if (value) {
      if (value[1] === 'LastUsedTimeStart') start = BigInt(value[2])
      else stop = BigInt(value[2])
    }
  }
  flush()
  return live
}

/** OwenFlow's own capture (warm mic, dictation, meetings) must never self-trigger. */
export function isSelfApp(path: string): boolean {
  return /owenflow|[\\/]electron\.exe$/i.test(path)
}
```

- [ ] **Step 4: Run** — `npx vitest run tests/meeting-detect.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/meeting-detect.ts app/tests/meeting-detect.test.ts
git commit -m "feat: parse Windows mic ConsentStore for live call detection

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Detection decision + poller + notification

**Files:**
- Modify: `app/src/main/meeting-detect.ts` (add decision fn + poller)
- Modify: `app/src/shared/types.ts` (`meetingAutoDetect: boolean` on `OwenFlowSettings` — doc: "Watch for other apps using the microphone and offer to record the call. Default on.")
- Modify: `app/src/main/config.ts` (default `meetingAutoDetect: true` + schema `{ type: 'boolean', default: true }`, next to `meetingHotkey`)
- Modify: `app/src/main/index.ts` (wire poller; stop on quit)
- Test: `app/tests/meeting-detect.test.ts`, `app/tests/config.test.ts`

**Interfaces:**
- Consumes: `isMeetingActive()` from `./meeting-channel`; Electron `Notification`; `spawnSync` from `node:child_process`.
- Produces: `shouldPrompt(liveApps: string[], state: { lastPromptAt: number; now: number }): boolean` (pure); `startMeetingDetect(deps: MeetingDetectDeps): void`, `stopMeetingDetect(): void`, `notePromptShown(now: number): void` where

```ts
export interface MeetingDetectDeps {
  getSettings: () => OwenFlowSettings
  isMeetingActive: () => boolean
  /** Fires when the user clicks the notification. */
  startMeeting: () => void
  /** DI seam for tests: defaults to the real `reg query` runner. */
  queryConsentStore?: () => string
}
```

- [ ] **Step 1: Write the failing tests** (append to `tests/meeting-detect.test.ts`):

```ts
import { shouldPrompt } from '../src/main/meeting-detect'

describe('shouldPrompt', () => {
  const ZOOM = 'C:\\Users\\owen\\AppData\\Local\\Zoom\\bin\\Zoom.exe'
  const SELF = 'C:\\Users\\owen\\AppData\\Local\\Programs\\OwenFlow\\OwenFlow.exe'

  it('prompts when a non-self app holds the mic', () => {
    expect(shouldPrompt([SELF, ZOOM], { lastPromptAt: 0, now: 1_000_000 })).toBe(true)
  })

  it('never prompts on self-only usage (warm mic must not self-trigger)', () => {
    expect(shouldPrompt([SELF], { lastPromptAt: 0, now: 1_000_000 })).toBe(false)
  })

  it('honors the 10-minute cooldown after a prompt', () => {
    expect(shouldPrompt([ZOOM], { lastPromptAt: 1_000_000, now: 1_000_000 + 5 * 60_000 })).toBe(false)
    expect(shouldPrompt([ZOOM], { lastPromptAt: 1_000_000, now: 1_000_000 + 11 * 60_000 })).toBe(true)
  })
})
```

Config assertions (append to the meeting block in `tests/config.test.ts`, mirroring the `meetingHotkey` ones):

```ts
it('meetingAutoDetect defaults on and is schema-typed boolean', () => {
  expect(DEFAULT_SETTINGS.meetingAutoDetect).toBe(true)
  expect(SETTINGS_SCHEMA.meetingAutoDetect).toEqual({ type: 'boolean', default: true })
})
```

(Read `tests/config.test.ts` first — reuse its exact import names for defaults/schema; if the existing tests assert via a different shape, e.g. `schema.properties`, match that shape.)

- [ ] **Step 2: Run to verify failure** — `shouldPrompt` not exported; config assertions fail.

- [ ] **Step 3: Implement** — append to `meeting-detect.ts`:

```ts
import { spawnSync } from 'node:child_process'
import { Notification } from 'electron'
import type { OwenFlowSettings } from '../shared/types'

const POLL_MS = 20_000
/** One nag per call, roughly — re-prompting mid-meeting is worse than missing one. */
const PROMPT_COOLDOWN_MS = 10 * 60_000
const CONSENT_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged'

/** Pure gate: a foreign app on the mic + outside the cooldown window. */
export function shouldPrompt(
  liveApps: string[],
  state: { lastPromptAt: number; now: number }
): boolean {
  if (state.now - state.lastPromptAt < PROMPT_COOLDOWN_MS) return false
  return liveApps.some((app) => !isSelfApp(app))
}

function queryConsentStoreReal(): string {
  const res = spawnSync('reg', ['query', CONSENT_KEY, '/s'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000
  })
  return res.stdout ?? ''
}

export interface MeetingDetectDeps {
  getSettings: () => OwenFlowSettings
  isMeetingActive: () => boolean
  startMeeting: () => void
  queryConsentStore?: () => string
}

let timer: NodeJS.Timeout | null = null
let lastPromptAt = 0

/** Test seam + used on meeting start so an accepted prompt re-arms cleanly. */
export function notePromptShown(now: number): void {
  lastPromptAt = now
}

export function startMeetingDetect(deps: MeetingDetectDeps): void {
  stopMeetingDetect()
  const query = deps.queryConsentStore ?? queryConsentStoreReal
  timer = setInterval(() => {
    try {
      if (!deps.getSettings().meetingAutoDetect) return
      if (deps.isMeetingActive()) return
      const live = parseConsentStore(query())
      if (!shouldPrompt(live, { lastPromptAt, now: Date.now() })) return
      lastPromptAt = Date.now()
      const note = new Notification({
        title: 'Call detected',
        body: 'Another app is using your microphone. Record and transcribe this meeting?'
      })
      note.on('click', () => deps.startMeeting())
      note.show()
    } catch {
      // detection is best-effort; a registry hiccup must never surface
    }
  }, POLL_MS)
}

export function stopMeetingDetect(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
```

Wire in `index.ts` (after `initMeetingChannel`, alongside the other meeting wiring — read the file section first; `startMeeting`/`stopMeeting` and `isMeetingActive` are already imported there):

```ts
  startMeetingDetect({
    getSettings,
    isMeetingActive,
    startMeeting: () => void startMeeting()
  })
```

and `stopMeetingDetect()` in the existing `will-quit` handler next to `stopModeHotkey()`.

- [ ] **Step 4: Run full suite** — `npx vitest run` → all green; `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/meeting-detect.ts app/src/main/index.ts app/src/main/config.ts app/src/shared/types.ts app/tests/meeting-detect.test.ts app/tests/config.test.ts
git commit -m "feat: call auto-detect — offer to record when another app holds the mic

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Auto-detect toggle in the Meetings page (instant-apply)

The Meetings section has no save bar (`NO_SAVE_BAR`), so the toggle applies immediately on click, like the Home mode chips.

**Files:**
- Modify: `app/src/renderer/settings.html` (one row under the Meetings header controls)
- Modify: `app/src/renderer/src/settings.ts` (init + instant-apply)
- Modify: `docs/mockups/settings-harness-stub.js` (add `meetingAutoDetect: true` to the mocked settings object)

**Interfaces:**
- Consumes: `window.owenflow.settings.get()/set()`; the Meetings page markup (`#page-meetings`, header controls container — read `settings.html` for the exact container id/class the Start-meeting button lives in).
- Produces: checkbox `#mtg-autodetect` bound two-way to `settings.meetingAutoDetect`.

- [ ] **Step 1: Markup** — inside the Meetings page, directly under the header controls row (match the existing hint/row styling used elsewhere on the page):

```html
<label class="mtg-autodetect-row">
  <input type="checkbox" id="mtg-autodetect" />
  <span>Detect calls and offer to record</span>
  <span class="hint">Watches for other apps using your microphone (Zoom, Meet, Teams…)</span>
</label>
```

with CSS beside the other meeting styles:

```css
.mtg-autodetect-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--dim, rgba(235, 235, 240, 0.6));
  margin: 2px 0 10px;
  cursor: pointer;
  user-select: none;
}
.mtg-autodetect-row .hint {
  font-size: 11.5px;
  opacity: 0.7;
}
```

(If `--dim` isn't a defined variable in this stylesheet, use the same color token the page's existing hint text uses — check adjacent rules.)

- [ ] **Step 2: Wire in `settings.ts`** — in the meetings module init (where `refreshMeetings` is defined):

```ts
const mtgAutodetect = $<HTMLInputElement>('mtg-autodetect')
// Instant-apply: the Meetings page has no save bar, so the toggle behaves
// like the Home mode chips — one click, persisted immediately.
mtgAutodetect.addEventListener('change', () => {
  void window.owenflow.settings.set({ meetingAutoDetect: mtgAutodetect.checked })
})
```

and inside `refreshMeetings()` (which already runs on every section show), seed it:

```ts
  mtgAutodetect.checked = (await window.owenflow.settings.get()).meetingAutoDetect
```

(Place the read alongside the existing awaits so it doesn't add a serial round-trip — combine with the `meetings.state()` call region.)

- [ ] **Step 3: Verify** — `npm run build` clean; harness screenshot: serve `out/renderer` + stub over HTTP (the CSP blocks `file://` module loads), navigate to Meetings, confirm the toggle renders and clicking flips `settings.set` (stub logs it).

- [ ] **Step 4: Full suite + commit**

```bash
git add app/src/renderer/settings.html app/src/renderer/src/settings.ts docs/mockups/settings-harness-stub.js
git commit -m "feat(ui): meetings auto-detect toggle (instant apply)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Action-item extraction (strict-JSON contract, tolerant parser)

**Files:**
- Modify: `app/src/main/meeting-summary.ts`
- Test: `app/tests/meeting-summary.test.ts`

**Interfaces:**
- Consumes: `chatOnce(settings, tier, system, user, maxTokens): Promise<string>` from `./cleanup` (already imported by this module); private `renderBlock(entries)` (entries → "You:/Them:" text, already in this module).
- Produces: `parseActionItems(reply: string): string[]` (pure); `extractActionItems(entries: MeetingEntry[], settings: OwenFlowSettings, chat = chatOnce): Promise<string[]>` (never throws, `[]` on any failure); `buildZealTaskMessage(title: string, items: string[]): string`.

- [ ] **Step 1: Write the failing tests** (append; mirror this test file's existing harness style — it tests `chunkEntries`/`summarizeMeeting`, read it first):

```ts
describe('parseActionItems', () => {
  it('parses a clean JSON array', () => {
    expect(parseActionItems('["Ship the fix", "Email Dayo"]')).toEqual(['Ship the fix', 'Email Dayo'])
  })
  it('recovers the array from fenced/prefixed replies', () => {
    expect(parseActionItems('Here you go:\n```json\n["Ship the fix"]\n```')).toEqual(['Ship the fix'])
  })
  it('returns [] for garbage, non-arrays, and empty arrays', () => {
    expect(parseActionItems('no items found')).toEqual([])
    expect(parseActionItems('{"items": 1}')).toEqual([])
    expect(parseActionItems('[]')).toEqual([])
  })
  it('drops non-string members and trims', () => {
    expect(parseActionItems('["  Ship it  ", 42, ""]')).toEqual(['Ship it'])
  })
})

describe('extractActionItems', () => {
  const entries = [{ t: 1, speaker: 'you' as const, text: 'I will ship the webhook fix by Friday' }]
  it('sends the transcript to the fast tier and parses the reply', async () => {
    const chat = vi.fn().mockResolvedValue('["Ship the webhook fix by Friday"]')
    await expect(extractActionItems(entries, settings(), chat)).resolves.toEqual([
      'Ship the webhook fix by Friday'
    ])
    expect(chat).toHaveBeenCalledOnce()
    const [, tier, system, user] = chat.mock.calls[0]
    expect(tier).toBe('fast')
    expect(system).toContain('STRICT JSON')
    expect(user).toContain('webhook fix')
  })
  it('returns [] on chat failure and on empty transcripts', async () => {
    await expect(extractActionItems([], settings(), vi.fn())).resolves.toEqual([])
    const boom = vi.fn().mockRejectedValue(new Error('down'))
    await expect(extractActionItems(entries, settings(), boom)).resolves.toEqual([])
  })
})

describe('buildZealTaskMessage', () => {
  it('formats title + bulleted items', () => {
    expect(buildZealTaskMessage('Nomba sync', ['Ship it', 'Email Dayo'])).toBe(
      'Create these tasks from my meeting "Nomba sync":\n- Ship it\n- Email Dayo'
    )
  })
})
```

(`settings()` = whatever settings-factory helper this test file already uses; if it has none, build the minimal `OwenFlowSettings` literal the way `tests/cleanup.test.ts` does.)

- [ ] **Step 2: Run to verify failure** — new exports missing.

- [ ] **Step 3: Implement** — append to `meeting-summary.ts`:

```ts
/**
 * Action items ride the same never-throw contract as summaries: the model is
 * asked for STRICT JSON, but small models decorate ("Here you go: ```json…"),
 * so the parser fishes the first [...] out of the reply and validates hard.
 */
const ACTION_SYSTEM = [
  'Extract the concrete action items from this meeting transcript.',
  'Output STRICT JSON: an array of short imperative strings (who does what), [] when there are none.',
  'Only include real commitments and follow-ups actually said — never invent tasks.',
  'No commentary, no markdown fences — the array only.'
].join(' ')

export function parseActionItems(reply: string): string[] {
  const match = reply.match(/\[[\s\S]*\]/)
  if (!match) return []
  try {
    const parsed: unknown = JSON.parse(match[0])
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export async function extractActionItems(
  entries: MeetingEntry[],
  settings: OwenFlowSettings,
  chat: typeof chatOnce = chatOnce
): Promise<string[]> {
  if (entries.length === 0) return []
  try {
    return parseActionItems(await chat(settings, 'fast', ACTION_SYSTEM, renderBlock(entries), 600))
  } catch {
    return []
  }
}

/** The one-shot ZEAL instruction — its /api/voice executor files each bullet as a task. */
export function buildZealTaskMessage(title: string, items: string[]): string {
  return `Create these tasks from my meeting "${title}":\n${items.map((i) => `- ${i}`).join('\n')}`
}
```

(For 3h transcripts `renderBlock(entries)` can exceed comfortable prompt size — if `renderBlock` output for the full entries array exceeds ~24k characters, take the LAST 24k characters; commitments cluster at the end of meetings. Implement as a one-line slice with a why-comment.)

- [ ] **Step 4: Run** — `npx vitest run tests/meeting-summary.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/main/meeting-summary.ts app/tests/meeting-summary.test.ts
git commit -m "feat: extract meeting action items (fast tier, strict-JSON contract)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `meeting:actions` IPC — extract, send to ZEAL, stamp

**Files:**
- Modify: `app/src/shared/types.ts` (IPC const `meetingActions: 'meeting:actions'`; `MeetingMeta.actionsSentAt?: number` doc "epoch ms when action items were last sent to ZEAL"; `meetings.sendActions` on `OwenFlowApi`)
- Modify: `app/src/preload/index.ts`
- Modify: `app/src/main/index.ts` (handler next to `meetingSummarize`)

**Interfaces:**
- Consumes: `extractActionItems`, `buildZealTaskMessage` (Task 5); `sendZealCommand(message, settings): Promise<ZealReply>` from `./zeal` where `ZealReply = { ok: boolean; reply: string; error?: string }`; `meetingStore.getMeeting/readMeta/writeMeta`; the renderer-side `meetingDisplayTitle` logic is NOT available in main — derive the title as below.
- Produces: `meetings.sendActions(id: string): Promise<{ items: string[]; sent: boolean; reply: string }>`.

- [ ] **Step 1: types.ts** — add to the `meetings` block of `OwenFlowApi`:

```ts
    /**
     * Extract action items and send them to ZEAL as tasks ("meeting:actions").
     * items=[] means none were found; sent=false with items present means the
     * ZEAL call failed (endpoint/key missing or network) — nothing persisted.
     */
    sendActions: (id: string) => Promise<{ items: string[]; sent: boolean; reply: string }>
```

- [ ] **Step 2: preload** —

```ts
    sendActions: (id: string): Promise<{ items: string[]; sent: boolean; reply: string }> =>
      ipcRenderer.invoke(IPC.meetingActions, id)
```

- [ ] **Step 3: handler in `index.ts`** (imports: `extractActionItems`, `buildZealTaskMessage` from `./meeting-summary`; `sendZealCommand` is already imported for the command channel — verify, else add):

```ts
  ipcMain.handle(
    IPC.meetingActions,
    async (_event, id: string): Promise<{ items: string[]; sent: boolean; reply: string }> => {
      const { meta, entries } = meetingStore.getMeeting(id)
      if (!meta.startedAt) return { items: [], sent: false, reply: '' }
      const items = await extractActionItems(entries, getSettings())
      if (items.length === 0) return { items, sent: false, reply: '' }
      const title =
        meta.title?.trim() ||
        new Date(meta.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      const res = await sendZealCommand(buildZealTaskMessage(title, items), getSettings())
      if (res.ok) {
        // Re-read before writing — a words refresh may have landed meanwhile.
        const fresh = meetingStore.readMeta(id) ?? meta
        meetingStore.writeMeta(id, { ...fresh, actionsSentAt: Date.now() })
      }
      return { items, sent: res.ok, reply: res.reply }
    }
  )
```

- [ ] **Step 4: Verify** — `npm run typecheck` clean; `npx vitest run` all green (no new unit tests here: the handler is thin glue over Task-5-tested logic and the already-tested store/zeal modules).

- [ ] **Step 5: Commit**

```bash
git add app/src/shared/types.ts app/src/preload/index.ts app/src/main/index.ts
git commit -m "feat: meeting:actions IPC — action items to ZEAL, actionsSentAt stamp

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: "Action items → ZEAL" button in the meeting detail view

**Files:**
- Modify: `app/src/renderer/src/settings.ts` (`renderMeetingDetail` / `openMeeting`)
- Modify: `docs/mockups/settings-harness-stub.js` (mock `sendActions` — resolve `{items:['Ship the webhook fix'], sent:true, reply:'Filed 1 task.'}` after 700ms so the busy state is screenshotable)

**Interfaces:**
- Consumes: `window.owenflow.meetings.sendActions(id)` (Task 6); `window.owenflow.settings.get()` (ZEAL configured check); existing `meetingActionButton` pattern + `.ghost` button styling; `openMeeting(id)` re-render.
- Produces: UI only.

- [ ] **Step 1: In `openMeeting`**, fetch settings alongside the meeting so the button can hide when ZEAL isn't configured:

```ts
  const [{ meta, entries }, s] = await Promise.all([
    window.owenflow.meetings.get(id),
    window.owenflow.settings.get()
  ])
  renderMeetingDetail(meta, entries, Boolean(s.zealApiKey?.trim() && s.zealEndpoint?.trim()))
```

(update `renderMeetingDetail`'s signature to `(meta, entries, zealConfigured: boolean)`).

- [ ] **Step 2: In `renderMeetingDetail`'s actions row**, after the Summarize button:

```ts
  if (zealConfigured) {
    const zealBtn = document.createElement('button')
    zealBtn.className = 'ghost'
    zealBtn.textContent = meta.actionsSentAt ? 'Re-send action items → ZEAL' : 'Action items → ZEAL'
    zealBtn.addEventListener('click', async () => {
      zealBtn.disabled = true
      zealBtn.textContent = 'Extracting…'
      try {
        const res = await window.owenflow.meetings.sendActions(meta.id)
        if (res.items.length === 0) zealBtn.textContent = 'No action items found'
        else if (res.sent) {
          zealBtn.textContent = `Sent ${res.items.length} ✓`
          // re-open so the actionsSentAt-aware label + Updated stamp re-render
          setTimeout(() => void openMeeting(meta.id), 1200)
          return
        } else zealBtn.textContent = 'ZEAL send failed'
      } catch {
        zealBtn.textContent = 'ZEAL send failed'
      }
      setTimeout(() => {
        zealBtn.textContent = meta.actionsSentAt ? 'Re-send action items → ZEAL' : 'Action items → ZEAL'
        zealBtn.disabled = false
      }, 1600)
    })
    actions.append(zealBtn)
  }
```

- [ ] **Step 3: Verify visually** — `npm run build`, harness over HTTP, open a meeting detail, click the button, screenshot the Extracting… → Sent ✓ progression. Zero console errors.

- [ ] **Step 4: Full suite + typecheck + commit**

```bash
git add app/src/renderer/src/settings.ts docs/mockups/settings-harness-stub.js
git commit -m "feat(ui): one-click action items to ZEAL from meeting detail

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Ship v1.10.0

**Files:**
- Modify: `app/package.json` (version `1.9.1` → `1.10.0`)

- [ ] **Step 1:** Full verify: `npx vitest run` (expect ~420, zero fail), `npm run typecheck`, `npm run build`.
- [ ] **Step 2:** Bump version, commit `chore: v1.10.0`, push `main` (use `git -c credential.helper="!gh auth git-credential" push origin main` — plain push hangs on this machine).
- [ ] **Step 3:** `npm run build:win`; stop running OwenFlow + port-8484 sidecar; run `dist\owenflow-1.10.0-setup.exe /S`; relaunch; poll `http://127.0.0.1:8484/health` until `loaded:true`.
- [ ] **Step 4:** Live checks: (a) failover — no direct probe needed, covered by tests; (b) auto-detect — start an audio app that opens the mic (or Owen's next real call) and confirm the notification; (c) ZEAL button — open a past meeting with real content, click, confirm tasks appear in ZEAL.

## Self-Review (done)

- **Coverage:** failover (T1), auto-detect (T2–T4), action items → ZEAL (T5–T7), ship (T8) — all three Wave-A gaps covered.
- **Placeholders:** none; two deliberate read-the-file-first instructions exist where the current markup/test-harness shape must be matched rather than guessed (T3 config test shape, T4 container id) — these are match-existing-pattern directives with the full replacement content provided, not TBDs.
- **Type consistency:** `resolveProvider().provider` (T1) used only in T1; `shouldPrompt`/`parseConsentStore`/`isSelfApp` names consistent T2↔T3; `sendActions` return `{items, sent, reply}` identical in T6 types/preload/handler and T7 consumer; `actionsSentAt` written T6, read T7.
