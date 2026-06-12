"""E2E test for the OwenFlow STT sidecar.

Synthesizes "The quick brown fox jumps over the lazy dog" with edge-tts,
starts server.py as a subprocess on a test port, waits for /health,
POSTs the audio (mp3 — faster-whisper decodes it via PyAV), and asserts
the transcript contains "quick brown fox". Prints PASS/FAIL, exits 0/1.
"""

import asyncio
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

TEST_PORT = 8485
BASE = f"http://127.0.0.1:{TEST_PORT}"
SENTENCE = "The quick brown fox jumps over the lazy dog"
VOICE = "en-US-AvaNeural"
HERE = os.path.dirname(os.path.abspath(__file__))


def synthesize(path: str) -> None:
    import edge_tts

    async def _run():
        tts = edge_tts.Communicate(SENTENCE, VOICE)
        await tts.save(path)

    asyncio.run(_run())


def wait_for_health(proc: subprocess.Popen, timeout_s: int = 600) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"server exited early with code {proc.returncode}")
        try:
            with urllib.request.urlopen(BASE + "/health", timeout=2) as r:
                if r.status == 200:
                    return
        except Exception:
            pass
        time.sleep(1)
    raise TimeoutError("server did not become healthy in time")


def post_multipart(url: str, field: str, filename: str, data: bytes) -> str:
    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
        f"Content-Type: audio/mpeg\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read().decode()


def main() -> int:
    audio_path = os.path.join(tempfile.gettempdir(), "owenflow_test_fox.mp3")
    print("Synthesizing test audio with edge-tts...")
    synthesize(audio_path)
    print(f"Audio at {audio_path} ({os.path.getsize(audio_path)} bytes)")

    env = dict(os.environ, OWENFLOW_PORT=str(TEST_PORT))
    proc = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "server.py")],
        env=env,
        cwd=HERE,
    )
    try:
        print("Waiting for server health (model download may take a while on first run)...")
        wait_for_health(proc)
        print("Server healthy. Posting audio...")

        with open(audio_path, "rb") as f:
            data = f.read()
        resp = post_multipart(BASE + "/transcribe", "file", "fox.mp3", data)
        print("Response:", resp)

        import json

        text = json.loads(resp)["text"].lower()
        if "quick brown fox" in text:
            print(f"PASS: transcript contains 'quick brown fox' -> {text!r}")
            return 0
        print(f"FAIL: 'quick brown fox' not in transcript -> {text!r}")
        return 1
    except Exception as e:
        print(f"FAIL: {e}")
        return 1
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        try:
            os.unlink(audio_path)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
