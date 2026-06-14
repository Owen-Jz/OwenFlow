"""OwenFlow STT sidecar — FastAPI + faster-whisper.

GET  /health      -> {"ok": true, "model": "<size>", "loaded": true}
POST /transcribe  -> multipart: file (audio), prompt (optional), language (optional)
                     {"text": str, "duration_ms": int, "model": str}
"""

import logging
import os
import tempfile
import time
from typing import Optional

import edge_tts
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("owenflow.sidecar")

MODEL_SIZE = os.environ.get("OWENFLOW_MODEL", "large-v3-turbo")
FALLBACK_MODEL = "small"


def _default_compute(model_size: str) -> str:
    """Empirical (RTX 3050 Laptop 4GB, 2026-06-12): large-v3-turbo float16
    needs ~1.6GB and thrashes when the GPU is shared (15s/utterance);
    int8_float16 fits in ~1GB and runs ~2s with identical transcripts."""
    if model_size.startswith("large") or model_size == "turbo":
        return "int8_float16"
    return "float16"


COMPUTE_TYPE = os.environ.get("OWENFLOW_COMPUTE", _default_compute(MODEL_SIZE))


def _register_cuda_dlls() -> None:
    """pip-installed nvidia-cublas-cu12 / nvidia-cudnn-cu12 land inside
    site-packages and are not on the Windows DLL search path; ctranslate2
    only finds them if their bin dirs are registered explicitly."""
    if os.name != "nt":
        return
    import site
    import sysconfig

    roots = {sysconfig.get_paths()["purelib"], *site.getsitepackages()}
    for root in roots:
        nvidia = os.path.join(root, "nvidia")
        if not os.path.isdir(nvidia):
            continue
        for pkg in os.listdir(nvidia):
            bin_dir = os.path.join(nvidia, pkg, "bin")
            if os.path.isdir(bin_dir):
                os.add_dll_directory(bin_dir)
                # some loaders resolve via PATH rather than the DLL dir list
                os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
                log.info("Registered CUDA DLL dir: %s", bin_dir)


_register_cuda_dlls()

app = FastAPI(title="OwenFlow STT Sidecar")

# CORS: the pill renderer runs at localhost:5173 (dev) or file:// (packaged)
# and POSTs to 127.0.0.1:8484/tts. Without this, browsers send a CORS preflight
# (OPTIONS) that returns 405 Method Not Allowed, aborting the actual POST and
# silently breaking the ZEAL voice reply ("speak ZEAL replies" toggle).
# Sidecar binds 127.0.0.1 only, so allow_origins=["*"] is safe.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_model = None
_device = "unloaded"
_loaded_model = "unloaded"


def _try_load(model_size: str, compute_type: str) -> bool:
    """Load model_size with the CUDA warmup-probe -> CPU int8 fallback.
    Returns True on success, False if neither device could load it."""
    global _model, _device, _loaded_model
    import sys

    from faster_whisper import WhisperModel

    # Apple Silicon has no CUDA — skip the probe to avoid noisy warnings.
    if sys.platform != "darwin":
        try:
            log.info("Loading whisper model '%s' on cuda/%s...", model_size, compute_type)
            model = WhisperModel(model_size, device="cuda", compute_type=compute_type)
            # CUDA errors surface lazily at inference (e.g. missing cuBLAS/cuDNN
            # DLLs, OOM), so validate with a tiny warmup before committing to GPU.
            import numpy as np

            segments, _ = model.transcribe(np.zeros(16000, dtype=np.float32))
            list(segments)
            _model = model
            _device = "cuda"
            _loaded_model = model_size
            log.info("Model '%s' loaded on CUDA (%s).", model_size, compute_type)
            return True
        except Exception as e:
            log.warning("CUDA load of '%s' failed (%s); falling back to CPU int8.", model_size, e)

    try:
        _model = WhisperModel(model_size, device="cpu", compute_type="int8")
        _device = "cpu"
        _loaded_model = model_size
        log.info("Model '%s' loaded on CPU (int8).", model_size)
        return True
    except Exception as e:
        log.error("CPU load of '%s' failed too (%s).", model_size, e)
        return False


def _load_model():
    """Graceful chain: requested model -> FALLBACK_MODEL so the app is never modelless."""
    if _try_load(MODEL_SIZE, COMPUTE_TYPE):
        return
    if MODEL_SIZE != FALLBACK_MODEL:
        log.warning("Requested model '%s' unavailable; falling back to '%s'.", MODEL_SIZE, FALLBACK_MODEL)
        if _try_load(FALLBACK_MODEL, _default_compute(FALLBACK_MODEL)):
            return
    log.error("No whisper model could be loaded; /transcribe will fail until restart.")


@app.on_event("startup")
def startup() -> None:
    _load_model()


@app.get("/health")
def health():
    return {"ok": True, "model": _loaded_model, "loaded": _model is not None}


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    prompt: Optional[str] = Form(None),
    language: Optional[str] = Form(None),
):
    start = time.perf_counter()

    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    data = await file.read()
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        segments, _info = _model.transcribe(
            tmp_path,
            initial_prompt=prompt or None,
            language=language or None,
            # accuracy: wider beam search; short dictations don't benefit from
            # cross-window conditioning (it amplifies hallucinated repeats)
            beam_size=5,
            best_of=5,
            condition_on_previous_text=False,
            # keep VAD but don't let short thinking-pauses drop words
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300},
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    duration_ms = int((time.perf_counter() - start) * 1000)
    log.info("Transcribed %d bytes in %d ms (device=%s): %r", len(data), duration_ms, _device, text[:120])
    return {"text": text, "duration_ms": duration_ms, "model": _loaded_model}


TTS_VOICE = "en-US-AvaNeural"
TTS_RATE = "-5%"


@app.post("/tts")
async def tts(payload: dict):
    text = (payload.get("text") or "").strip()
    if not text:
        return Response(status_code=400, content=b"text required")
    communicate = edge_tts.Communicate(text, TTS_VOICE, rate=TTS_RATE)
    chunks = bytearray()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            chunks.extend(chunk["data"])
    return Response(content=bytes(chunks), media_type="audio/mpeg")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("OWENFLOW_PORT", "8484"))
    uvicorn.run(app, host="127.0.0.1", port=port)
