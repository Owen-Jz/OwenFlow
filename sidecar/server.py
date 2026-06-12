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

from fastapi import FastAPI, File, Form, UploadFile

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("owenflow.sidecar")

MODEL_SIZE = os.environ.get("OWENFLOW_MODEL", "small")

app = FastAPI(title="OwenFlow STT Sidecar")

_model = None
_device = "unloaded"


def _load_model():
    global _model, _device
    from faster_whisper import WhisperModel

    try:
        log.info("Loading whisper model '%s' on cuda/float16...", MODEL_SIZE)
        model = WhisperModel(MODEL_SIZE, device="cuda", compute_type="float16")
        # CUDA errors surface lazily at inference (e.g. missing cuBLAS/cuDNN
        # DLLs), so validate with a tiny warmup before committing to the GPU.
        import numpy as np

        segments, _ = model.transcribe(np.zeros(16000, dtype=np.float32))
        list(segments)
        _model = model
        _device = "cuda"
        log.info("Model '%s' loaded on CUDA (float16).", MODEL_SIZE)
    except Exception as e:
        log.warning("CUDA load failed (%s); falling back to CPU int8.", e)
        _model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
        _device = "cpu"
        log.info("Model '%s' loaded on CPU (int8).", MODEL_SIZE)


@app.on_event("startup")
def startup() -> None:
    _load_model()


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_SIZE, "loaded": _model is not None}


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
            vad_filter=True,
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
    return {"text": text, "duration_ms": duration_ms, "model": MODEL_SIZE}


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("OWENFLOW_PORT", "8484"))
    uvicorn.run(app, host="127.0.0.1", port=port)
