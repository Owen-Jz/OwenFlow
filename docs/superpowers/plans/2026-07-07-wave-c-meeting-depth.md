# Wave C — Meeting Depth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Speaker diarization for the "them" meeting track (Speaker 1/2/… labels), a live floating transcript panel during meetings, and full-text search across meeting transcripts.

**Architecture:** Diarization is per-segment speaker embedding + online clustering, proven in `docs/superpowers/research/2026-07-07-diarization-derisk.md`: the Python sidecar gains a stateless `POST /embed` endpoint (sherpa-onnx + NeMo titanet_small ONNX, pure CPU, ~142ms/segment, zero VRAM); the TypeScript meeting channel keeps per-meeting speaker centroids in a pure `speaker-cluster.ts` module and stamps each 'them' entry with a `speaker` index. The live panel is a small always-on-top window fed by an IPC push per transcribed entry. Search is a main-process scan over the per-meeting JSONL transcript files.

**Tech Stack:** Electron 39 TS, vitest; sidecar: FastAPI + sherpa-onnx 1.13.3 + soundfile (already installed for py -3.13), model `sidecar/models/nemo_en_titanet_small.onnx` (39 MB, already on disk).

## Global Constraints

- **Never block the meeting queue:** embedding failure of any kind (endpoint missing, timeout, short audio) → entry gets NO `speaker` field and processing continues. Diarization is best-effort decoration.
- Clustering parameters from the de-risk research, verbatim: cosine threshold **0.65**, centroid EMA **0.85 old + 0.15 new** then re-normalize, first segment creates speaker 0. Cap at **8** speakers — past that, assign best-match centroid regardless of threshold.
- 'you' track entries are never embedded (mic is always Owen).
- Embed request timeout **3000ms**; skip embedding entirely for segments shorter than **1.0s** of audio (short clips embed poorly).
- Meeting entry JSONL format gains ONE optional field: `speaker?: number` (0-based). Meta gains `speakerCount?: number`. Both backward-compatible — old meetings render as today.
- Renderer label rule: entries with `speaker: n` display **`Speaker ${n + 1}`**; entries without it display **`Them`** ('you' stays `You`).
- Packaging: `app/electron-builder.yml` extraResources filter must additionally ship `models/nemo_en_titanet_small.onnx`; `sidecar/requirements.txt` gains `sherpa-onnx` and `soundfile`. Delete `sidecar/models/wespeaker_en_voxceleb_CAM++.onnx` (failed evaluation — margin 0.05) and the unused `sidecar/models/sherpa-onnx-pyannote-segmentation-3-0/` directory (whole-file diarization not used).
- Design B styling for all new UI (charcoal `#1b1b1d`, single red accents).
- Every task: `npx vitest run` green from `app/`, then commit. Repo root `C:\Users\owen\Downloads\OwenFlow`; never touch `app/out` / `app/dist`.
- Calendar auto-titling is **deferred** (needs local Google OAuth; rename already covers titling).

---

### Task 1: Sidecar `/embed` endpoint + packaging

**Files:**
- Modify: `sidecar/server.py`
- Modify: `sidecar/requirements.txt` (add `sherpa-onnx`, `soundfile`)
- Modify: `app/electron-builder.yml` (ship the model)
- Delete: `sidecar/models/wespeaker_en_voxceleb_CAM++.onnx`, `sidecar/models/sherpa-onnx-pyannote-segmentation-3-0/`
- Test: manual live verification via curl (Python side has no pytest harness; `sidecar/test_sidecar.py` exists — extend it if it is runnable, otherwise verify live).

**Interfaces:**
- Produces: `POST /embed` — multipart `file` (16kHz mono WAV) → `200 {"embedding": [float, ...], "duration_ms": int}`. Errors: `400 {"error": "audio too short"}` for < 1.0s of samples; `503 {"error": "embedding model unavailable"}` if the model file is missing or sherpa-onnx import fails. The endpoint must not affect `/health` or `/transcribe` in any way.
- Extractor is lazy-loaded on first `/embed` call (module-global, thread-safe enough for FastAPI's default single-worker), CPU provider, `num_threads=4`, model path resolved relative to `server.py`'s own directory: `os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "nemo_en_titanet_small.onnx")` with forward slashes passed to sherpa-onnx (`.replace(os.sep, '/')`).

- [ ] **Step 1: Implement `/embed`** in `server.py` following the de-risk research's exact API:

```python
_embed_extractor = None

def _get_embed_extractor():
    global _embed_extractor
    if _embed_extractor is None:
        import sherpa_onnx
        model = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "nemo_en_titanet_small.onnx").replace(os.sep, "/")
        if not os.path.isfile(model):
            raise FileNotFoundError(model)
        _embed_extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=model, num_threads=4, provider="cpu")
        )
    return _embed_extractor


@app.post("/embed")
async def embed(file: UploadFile = File(...)):
    t0 = time.time()
    try:
        extractor = _get_embed_extractor()
    except Exception as exc:  # model missing / import failure
        log.warning("embed unavailable: %s", exc)
        return Response(status_code=503, content='{"error": "embedding model unavailable"}', media_type="application/json")
    data = await file.read()
    import io
    import soundfile as sf
    audio, sr = sf.read(io.BytesIO(data), dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if len(audio) < sr * 1.0:
        return Response(status_code=400, content='{"error": "audio too short"}', media_type="application/json")
    stream = extractor.create_stream()
    stream.accept_waveform(sample_rate=sr, waveform=audio)
    stream.input_finished()
    emb = extractor.compute(stream)
    return {"embedding": list(emb), "duration_ms": int((time.time() - t0) * 1000)}
```

- [ ] **Step 2: requirements.txt + electron-builder.yml** — append `sherpa-onnx` and `soundfile` to `sidecar/requirements.txt`; in `app/electron-builder.yml` extraResources filter add `- models/nemo_en_titanet_small.onnx`.

- [ ] **Step 3: Delete rejected/unused models** (`git rm` the CAM++ onnx and the segmentation dir if tracked; plain delete otherwise).

- [ ] **Step 4: Live verify** against the RUNNING sidecar on port 8484 — the running process predates this change, so restart is needed OR verify by launching a second instance on a scratch port: `OWENFLOW_PORT=8485 py -3.13 server.py` from `sidecar/`, then generate a 2s+ test WAV (edge-tts or sine won't embed meaningfully but proves the pipe): POST it with `curl.exe -s -F "file=@test.wav" http://127.0.0.1:8485/embed` → expect a JSON embedding array (length 192 for titanet_small). Also verify `/health` still works on 8485, then kill the scratch instance. Record the embedding length in the report.

- [ ] **Step 5: Commit** — `feat(sidecar): /embed speaker-embedding endpoint (sherpa-onnx titanet, CPU)`.

---

### Task 2: `speaker-cluster.ts` pure module

**Files:**
- Create: `app/src/main/speaker-cluster.ts`
- Test: `app/tests/speaker-cluster.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SpeakerClusterOptions { threshold?: number; maxSpeakers?: number }  // defaults 0.65, 8

export class SpeakerCluster {
  constructor(opts?: SpeakerClusterOptions)
  /** Assign an embedding to a speaker. Returns the 0-based speaker index. */
  assign(embedding: number[]): number
  /** Number of speakers discovered so far. */
  count(): number
}
```

- Behavior (Global Constraints, verbatim): first assign → speaker 0. Subsequent: cosine similarity vs every centroid; best sim > threshold → that speaker, centroid ← normalize(0.85·old + 0.15·new); else if count < maxSpeakers → new speaker with the raw embedding as centroid; else → best-match speaker (no centroid update in the forced case). Zero-magnitude embeddings: `assign` returns best-effort 0 without dividing by zero (guard `+1e-9` in norms).

- [ ] **Step 1: Failing tests:**

```ts
it('first embedding becomes speaker 0', ...)
it('similar embedding joins the same speaker', ...)          // e.g. [1,0,0] then [0.98,0.1,0]
it('dissimilar embedding creates speaker 1', ...)            // [1,0,0] then [0,1,0]
it('ABA pattern returns 0,1,0', ...)
it('EMA moves the centroid toward new samples', ...)         // assign [1,0,0], then [0.9,0.3,0] joins; a third vector closer to the moved centroid than the original still joins speaker 0
it('caps at maxSpeakers and force-assigns best match', ...)  // maxSpeakers: 2, three orthogonal vectors → third gets 0 or 1, count() stays 2
it('handles zero vectors without NaN', ...)
```

- [ ] **Step 2: Implement, run, commit** — `feat(meeting): SpeakerCluster online cosine clustering (threshold .65, EMA .85/.15)`.

---

### Task 3: Embed client + meeting-channel integration

**Files:**
- Modify: `app/src/main/sidecar.ts` (add `embedSpeaker`)
- Modify: `app/src/main/meeting-channel.ts`
- Modify: `app/src/main/meeting-store.ts` (entry type only, if the type lives there) / `app/src/shared/types.ts` (`MeetingEntry.speaker?: number`, `MeetingMeta.speakerCount?: number`)
- Modify: `app/src/main/index.ts` (pass embed dep into `initMeetingChannel`)
- Test: `app/tests/meeting-channel.test.ts` (extend)

**Interfaces:**
- `sidecar.ts` produces: `embedSpeaker(wav: Buffer | ArrayBuffer): Promise<number[]>` — POST `/embed`, `AbortSignal.timeout(3000)`, throws on non-200/timeout. NO status-gate (unlike `transcribe`) — the meeting channel handles failure. Do not add self-heal here; a plain fetch.
- `meeting-channel.ts` consumes: new optional dep `embed?: (wav: ArrayBuffer) => Promise<number[]>`. Per-meeting session gains `cluster: SpeakerCluster` (created in `startMeeting`). In the segment task, for `source === 'them'` only, after transcription yields non-empty text AND the segment's audio is ≥ 1.0s (compute from WAV byte length: `(bytes - 44) / 2 / 16000 >= 1.0`): `try { const e = await deps.embed?.(wav); if (e) entry.speaker = sess.cluster.assign(e) } catch { /* no speaker field */ }`. Update `meta.speakerCount = sess.cluster.count()` in the same meta refreshes that already stamp words.
- `index.ts`: wire `embed: (wav) => embedSpeaker(wav)`.

- [ ] **Step 1: Failing tests** in `meeting-channel.test.ts` (follow its existing fake-deps + `_drainMeetingQueue` pattern):

```ts
it('stamps speaker on them-entries via embed + cluster', ...)   // embed returns [1,0,0] then [0,1,0] → entries speaker 0, 1; meta.speakerCount 2
it('you-entries are never embedded', ...)                        // embed spy not called for source you
it('embed failure leaves entry without speaker and does not stall the queue', ...)  // embed rejects → entry written, no speaker key, later segments still process
it('segments shorter than 1s skip embedding', ...)
```

- [ ] **Step 2: Implement** (embedSpeaker in sidecar.ts + channel changes + types + wiring). Keep the 60s/summary/stop flows untouched.

- [ ] **Step 3: Full suite + typecheck + commit** — `feat(meeting): per-segment speaker diarization on the them-track`.

---

### Task 4: Speaker labels in the meeting detail view

**Files:**
- Modify: `app/src/renderer/src/settings.ts` (meeting detail rendering)
- Modify: `app/src/renderer/settings.html` (CSS only if needed)

**Interfaces:**
- Consumes: `MeetingEntry.speaker?: number` now present in `meetings.get()` payload entries; existing detail renderer that prints `You` / `Them` per entry.
- Rule (verbatim from constraints): `speaker: n` → `Speaker ${n + 1}`; absent → `Them`; 'you' → `You`. Give each speaker index a stable tint from a fixed 8-color palette (muted hues on charcoal; red stays reserved — exclude red-family hues). Meeting cards on the list view show `· N speakers` when `meta.speakerCount >= 2`.

- [ ] **Step 1: Implement rendering + palette.**
- [ ] **Step 2: Typecheck + visual QA via the existing harness stub** (`docs/mockups/settings-harness-stub.js` — extend its meeting fixture with speaker fields, serve over HTTP per the documented harness flow, screenshot the detail view).
- [ ] **Step 3: Commit** — `feat(meetings-ui): speaker labels + speaker count`.

---

### Task 5: Live transcript panel

**Files:**
- Create: `app/src/renderer/transcript.html` + `app/src/renderer/src/transcript.ts`
- Modify: `app/src/main/windows.ts` (`createTranscriptWindow`)
- Modify: `app/src/main/meeting-channel.ts` (entry push hook)
- Modify: `app/src/main/index.ts` (wiring), `app/src/main/tray.ts` (item), `app/src/shared/types.ts`, `app/src/preload/index.ts`
- Modify: `app/electron-vite.config.ts` (new HTML input)
- Test: `app/tests/meeting-channel.test.ts` (hook emission)

**Interfaces:**
- `meeting-channel.ts` produces: `onMeetingEntry(cb: (entry: {source: 'you'|'them'; text: string; speaker?: number; ts: number}) => void): () => void` — fired after each entry is appended (both tracks). Test: subscribing receives entries in order; unsubscribe stops delivery.
- Window: `createTranscriptWindow(): Promise<BrowserWindow>` — `420×520 min 320×240`, frameless, `alwaysOnTop: true`, resizable, `skipTaskbar: false`, NOT focusable:false, positioned left edge (x = workArea.x + 24, y = workArea.y + 96), loads `transcript.html`.
- IPC: `transcriptEntry = 'transcript:entry'` (main→renderer), `transcriptBootstrap = 'transcript:bootstrap'` (handle → `{title: string, entries: [...last 200 of the active meeting]}` or `{title: 'No active meeting', entries: []}`), `uiToggleTranscript = 'ui:toggle-transcript'`.
- Preload group `transcript`: `{ bootstrap(): Promise<...>; onEntry(cb): unsub }`.
- Behavior: tray item `Live transcript` (checkbox, enabled only while a meeting is active OR always openable — choose always-openable, it just says "No active meeting"); panel auto-opens on meeting start when the new setting `liveTranscript: boolean` (default **false**, instant-apply toggle on the Meetings page next to auto-detect) is on; panel closes itself is NOT automatic on meeting end — it stays with the final text until closed. Renderer renders exactly like the detail view labels (`You` red-tinted? NO — `You` neutral bold, speakers tinted, auto-scroll to bottom unless the user scrolled up >80px from the end).

- [ ] **Step 1: Failing test for `onMeetingEntry`** (channel emits after append; unsubscribe works).
- [ ] **Step 2: Implement channel hook + window + renderer + IPC + tray + setting** (`liveTranscript` in types/config/Meetings page instant-apply).
- [ ] **Step 3: electron-vite input + `npm run build` sanity** (out/renderer/transcript.html exists).
- [ ] **Step 4: Full suite + typecheck + commit** — `feat(meetings): live floating transcript panel`.

---

### Task 6: Meeting transcript search

**Files:**
- Create: `app/src/main/meeting-search.ts`
- Modify: `app/src/main/index.ts` (IPC handler), `app/src/shared/types.ts`, `app/src/preload/index.ts` (meetings.search)
- Modify: `app/src/renderer/settings.html` + `src/settings.ts` (Meetings page search box)
- Test: `app/tests/meeting-search.test.ts`

**Interfaces:**
- `meeting-search.ts` produces:

```ts
export interface SearchHit { meetingId: string; title: string; startedAt: number; ts: number; source: 'you' | 'them'; speaker?: number; snippet: string }
export function searchEntries(
  query: string,
  meetings: { id: string; meta: MeetingMeta; entries: MeetingEntry[] }[],
  limit?: number  // default 50
): SearchHit[]
```

- Matching: case-insensitive substring over entry text; `snippet` = the entry text trimmed to ≤160 chars centered on the first match (`…` ellipses when cut); hits ordered newest-meeting-first then entry order; empty/whitespace query → `[]`. `title` = `meta.title || ''` (renderer falls back to its date-title formatter).
- IPC: `meetingsSearch = 'meetings:search'` handle `(query: string) => SearchHit[]` — main loads all meetings via the existing `listMeetings()` + `readEntries()` per meeting (fine at this scale; do NOT build an index), calls `searchEntries`.
- UI: search input at the top of the Meetings page; ≥2 chars triggers search debounced 250ms; result rows show title/date, `You`/`Speaker n` chip, snippet with the match `<mark>`-highlighted (red-accent underline styling, not filled); click opens that meeting's detail view. Clearing the input restores the normal meetings list.

- [ ] **Step 1: Failing tests for `searchEntries`** — match found across multiple meetings ordered newest-first; case-insensitive; snippet centering + ellipses; limit honored; empty query → []; speaker field carried through.
- [ ] **Step 2: Implement module + IPC + preload.**
- [ ] **Step 3: UI + harness visual QA** (extend the stub's meetings.search mock).
- [ ] **Step 4: Full suite + typecheck + commit** — `feat(meetings): full-text search across meeting transcripts`.

---

## Deferred / explicitly out of scope for Wave C
- Calendar auto-titling (Google OAuth on this machine; rename covers it).
- Whole-file re-diarization pass at meeting end (per-segment labels are sufficient; segmentation model deleted).
- Speaker naming ("Speaker 1" → "Alice") — revisit if Owen asks.
- Diarizing the 'you' track (single known speaker).
