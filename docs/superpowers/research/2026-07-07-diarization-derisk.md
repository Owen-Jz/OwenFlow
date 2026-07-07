# Diarization De-Risk Research — 2026-07-07

## Verdict: PROVEN — sherpa-onnx + NeMo titanet_small

**Approach 1 (sherpa-onnx ONNX pipeline) confirmed working on py 3.13 Windows.**
No HF token needed. Zero VRAM. Two integration modes verified.

---

## Chosen Approach

**sherpa-onnx** (pip `sherpa-onnx==1.13.3`) with two ONNX models:

| Role | Model | Source | Size |
|------|-------|--------|------|
| Segmentation | pyannote segmentation-3.0 ONNX | GitHub release (ungated) | 5.8 MB |
| Embedding | NeMo en_titanet_small | GitHub release (ungated) | 39 MB |

**Rejected model**: `wespeaker_en_voxceleb_CAM++.onnx` (28 MB) — embedding margin too small (0.05) for reliable clustering. NeMo titanet_small has an 0.83 margin.

---

## Pip Packages / Versions

All already available in the sidecar environment or added:

```
sherpa-onnx==1.13.3          # new install — pip install sherpa-onnx
sherpa-onnx-core==1.13.3     # installed as dependency of above
soundfile==0.14.0            # new install — pip install soundfile (WAV I/O)
onnxruntime                  # already present (version confirmed working)
```

torch is NOT needed. sherpa-onnx uses onnxruntime internally.

---

## Model Files

All in `sidecar/models/`:

```
sidecar/models/
  sherpa-onnx-pyannote-segmentation-3-0/
    model.onnx          (5.8 MB — use this)
    model.int8.onnx     (1.5 MB — quantized alternative, untested)
  nemo_en_titanet_small.onnx   (39 MB)
  wespeaker_en_voxceleb_CAM++.onnx  (28 MB — keep but do not use for diarization)
```

Download URLs (GitHub releases, no auth required):

```
Segmentation tar:
  https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2

NeMo titanet_small ONNX:
  https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx
```

---

## Test Results

### Test Setup

- Test WAV 1 (`test_aba.wav`): 33.26s, 16kHz mono, ABA pattern
  - A1 = edge-tts AvaNeural, 9.43s
  - B1 = edge-tts GuyNeural, 10.46s
  - A2 = edge-tts AvaNeural, 12.77s
  - 0.3s silence gaps between segments

- Test WAV 2 (`1-two-speakers-en.wav`): 16s real human 2-speaker English audio (from sherpa-onnx test assets)

### Full-File Diarization (OfflineSpeakerDiarization)

**ABA TTS test (33.26s):**
```
Processing time: 4.05s  (RTF 0.122x)
Init time: ~1.6s (amortized for long meetings)
Speakers found: 2 / Segments: 6

  0.03s --   9.14s  speaker_0   ← Ava A1
  9.92s --  12.32s  speaker_1   ← Guy B1
 13.13s --  15.17s  speaker_1
 15.98s --  19.45s  speaker_1
 20.69s --  25.88s  speaker_0   ← Ava A2
 26.19s --  32.97s  speaker_0

Alternation correct (A != B): True
Return correct (A1 == A2): True
PASS: True
```

**Real 2-speaker English (16s):**
```
Processing time: 0.97s  (RTF 0.061x)
Speakers found: 2 / Segments: 4

  1.58s --  3.41s  speaker_0
  4.40s --  6.46s  speaker_0
  9.35s -- 11.47s  speaker_1
 12.16s -- 14.64s  speaker_1
PASS: True (2 distinct speakers correctly labelled)
```

**Device**: CPU (onnxruntime CPUExecutionProvider). Zero VRAM consumed.

### Embedding Cosine Similarity (NeMo titanet_small)

**TTS long clips (9-12s each):**
| Pair | Sim | Expected |
|------|-----|----------|
| Ava_A1 vs Ava_A2 (same) | 0.9377 | HIGH |
| Ava_A1 vs Guy_B1 (diff) | 0.0926 | LOW |
| Ava_A2 vs Guy_B1 (diff) | 0.1058 | LOW |
| **Margin** | **0.8319** | |

**Real short clips (~2s each):**
| Pair | Sim |
|------|-----|
| RealA_1 vs RealA_2 (same) | 0.7541 |
| RealB_1 vs RealB_2 (same) | 0.8162 |
| RealA_1 vs RealB_1 (diff) | 0.1660 |
| RealA_2 vs RealB_1 (diff) | 0.0377 |
| **Same-speaker avg** | **0.7852** |
| **Cross-speaker avg** | **0.1068** |
| **Margin** | **0.6784** |

Excellent separation even on 1.8-2.5s real speech clips.

### Incremental Per-Segment Embedding (OwenFlow pattern)

Simulating segments arriving one-by-one with online clustering (threshold=0.65):

```
Ava A1 (9.4s)  ->  speaker_0  [correct]  (138ms)
Guy B1 (10.5s)  ->  speaker_1  [correct]  (129ms)
Ava A2 (12.8s)  ->  speaker_0  [correct]  (158ms)

ABA incremental clustering PASS: True
Final centroid similarity: 0.0954  (near-orthogonal — excellent separation)
Avg per-segment time: 142ms (CPU, 4 threads)
```

---

## Recommended Integration Shape for the OwenFlow Sidecar

**Recommended: Per-segment embedding + online clustering** (not whole-file diarization).

Reason: OwenFlow receives segments from faster-whisper one at a time as audio streams in. Whole-file diarization requires buffering the entire audio first (impractical for 3h meetings). The per-segment approach labels each whisper chunk as it arrives.

### Exact API calls

```python
import sherpa_onnx
import numpy as np

# ---- Initialization (once per meeting) ----
emb_cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
    model="sidecar/models/nemo_en_titanet_small.onnx",
    num_threads=4,
    debug=False,
    provider="cpu",
)
extractor = sherpa_onnx.SpeakerEmbeddingExtractor(emb_cfg)
centroids = []       # list of np.ndarray, one per speaker
speaker_count = [0]  # mutable counter

def cosine_similarity(a, b):
    a, b = np.array(a), np.array(b)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))

# ---- Per-segment call (called for each whisper segment) ----
def assign_speaker(audio_float32: np.ndarray, sample_rate: int = 16000,
                   threshold: float = 0.65) -> int:
    """
    Returns integer speaker_id (0-indexed, consistent across the meeting).
    audio_float32: mono float32 array at 16kHz, minimum ~1s recommended.
    """
    stream = extractor.create_stream()
    stream.accept_waveform(sample_rate=sample_rate, waveform=audio_float32)
    stream.input_finished()
    embedding = np.array(extractor.compute(stream))

    if not centroids:
        centroids.append(embedding.copy())
        return 0

    sims = [cosine_similarity(embedding, c) for c in centroids]
    best_idx = int(np.argmax(sims))

    if sims[best_idx] > threshold:
        # Update centroid with EMA
        centroids[best_idx] = 0.85 * centroids[best_idx] + 0.15 * embedding
        centroids[best_idx] /= (np.linalg.norm(centroids[best_idx]) + 1e-9)
        return best_idx
    else:
        new_id = len(centroids)
        centroids.append(embedding.copy())
        return new_id
```

**Threshold guidance:**
- `0.65` is safe for meeting speech (segments 5-30s)
- Lower to `0.55` for very short segments (<3s) or noisy audio
- NeMo titanet_small's natural same/cross boundary lands around 0.50; 0.65 gives headroom

**For whole-file diarization** (use at end of meeting or for post-processing):

```python
import sherpa_onnx
import soundfile as sf

SEG_MODEL = "sidecar/models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx"
EMB_MODEL = "sidecar/models/nemo_en_titanet_small.onnx"

seg_cfg = sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
    pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=SEG_MODEL),
    num_threads=4, provider="cpu",
)
emb_cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
    model=EMB_MODEL, num_threads=4, provider="cpu",
)
diar_cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
    segmentation=seg_cfg,
    embedding=emb_cfg,
    clustering=sherpa_onnx.FastClusteringConfig(threshold=0.5),
    min_duration_on=0.3,
    min_duration_off=0.3,
)
diarizer = sherpa_onnx.OfflineSpeakerDiarization(diar_cfg)

audio, sr = sf.read("meeting.wav", dtype='float32')
result = diarizer.process(audio)
for seg in result.sort_by_start_time():
    print(f"{seg.start:.2f}s -- {seg.end:.2f}s  speaker_{seg.speaker}")
```

---

## Windows / py 3.13 Gotchas

1. **sherpa-onnx installs cleanly** on py 3.13 Windows (`cp313-cp313-win_amd64.whl` exists for 1.13.3). No compilation needed.

2. **soundfile needed** for WAV I/O — not in the sidecar's existing packages. `pip install soundfile` adds it (170KB).

3. **torch is CPU-only** in this environment (`2.11.0+cpu`). ctranslate2 (used by faster-whisper) does NOT show CUDA compute types — faster-whisper may be running on CPU too despite expectations. Regardless, sherpa-onnx never touches torch or VRAM.

4. **CAM++ model is a trap** — low embedding margin (0.05) for both TTS and real speech. Do not use it for diarization. The `nemo_en_titanet_small.onnx` model has 0.83 margin and works even on 2-second clips.

5. **TTS synthetic voices** (edge-tts Ava/Guy) are acoustically similar in embedding space — CAM++ cosine similarity of 0.79 cross-speaker. NeMo titanet_small correctly separates them (0.09). Use NeMo for all embedding work.

6. **Segmentation model is ungated** — converted from pyannote/segmentation-3.0 by k2-fsa, hosted as a GitHub release asset. No HuggingFace token needed. Original pyannote HF model IS gated.

7. **Model paths**: use Windows forward-slash or raw strings in Python — backslash causes issues in onnxruntime model loading on Windows paths with spaces.

8. **num_clusters vs threshold**: `FastClusteringConfig(threshold=0.5)` auto-detects speaker count and is more robust than specifying `num_clusters` when you don't know in advance. For meetings with unknown attendee count, use threshold.

---

## Summary of Numbers

| Metric | Value |
|--------|-------|
| sherpa-onnx version | 1.13.3 |
| py 3.13 Windows install | Clean |
| Segmentation model | pyannote-segmentation-3.0 ONNX (5.8 MB) |
| Embedding model | nemo_en_titanet_small.onnx (39 MB) |
| Total model size | 45 MB |
| Full-file diarization (33s audio) | 4.05s CPU (RTF 0.122x) |
| Full-file diarization (16s audio) | 0.97s CPU (RTF 0.061x) |
| Per-segment embedding | 142ms/segment (CPU, 4 threads) |
| Same-speaker cosine similarity | 0.78-0.94 |
| Cross-speaker cosine similarity | 0.09-0.11 |
| Margin | 0.68-0.83 |
| VRAM used | 0 |
| ABA diarization test | PASS |
| Real 2-speaker test | PASS |
| Incremental ABA test | PASS |
