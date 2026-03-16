import base64
import io
import wave

import numpy as np
from fastapi.testclient import TestClient

from stt_wrapper.app import app


def _make_silent_wav_bytes(duration_seconds: float = 0.1, sample_rate: int = 16000) -> bytes:
    """Create a tiny 16‑bit mono WAV buffer of silence."""
    n_samples = int(duration_seconds * sample_rate)
    pcm = (np.zeros(n_samples, dtype=np.int16)).tobytes()

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm)
    return buf.getvalue()


def test_health_includes_ready_and_metadata():
    client = TestClient(app)

    # Force a known state
    app.state.ready = False
    app.state.model_id = "dummy-model"
    app.state.device = "cpu"

    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert "ready" in data
    assert data["ready"] is False
    assert data["model_id"] == "dummy-model"
    assert data["device"] == "cpu"


def test_transcribe_returns_503_when_model_not_ready():
    client = TestClient(app)

    app.state.ready = False
    app.state.model = None

    payload = {
        "transcriptId": "t1",
        "chunkId": 1,
        "chunkStartTimeMs": 0,
        "audio": base64.b64encode(_make_silent_wav_bytes()).decode("ascii"),
    }

    resp = client.post("/transcribe", json=payload)
    assert resp.status_code == 503


def test_transcribe_uses_model_and_returns_segments():
    client = TestClient(app)

    # Fake model that pretends to transcribe and returns a single segment.
    class FakeSegment:
        def __init__(self, start: float, end: float, text: str):
            self.start = start
            self.end = end
            self.text = text

    class FakeInfo:
        def __init__(self, duration: float):
            self.duration = duration

    class FakeModel:
        def __init__(self):
            self.calls = []

        def transcribe(self, audio_float32, language: str):
            # Record that we were called with some audio and a language.
            self.calls.append((audio_float32, language))
            # Return one segment from 0.0s to 0.5s and total duration 0.5s.
            return [FakeSegment(0.0, 0.5, "hello")], FakeInfo(duration=0.5)

    fake_model = FakeModel()
    app.state.model = fake_model
    app.state.ready = True

    payload = {
        "transcriptId": "t1",
        "chunkId": 42,
        "chunkStartTimeMs": 1000,
        "audio": base64.b64encode(_make_silent_wav_bytes()).decode("ascii"),
    }

    resp = client.post("/transcribe", json=payload)
    assert resp.status_code == 200

    data = resp.json()
    assert data["transcriptId"] == "t1"
    assert data["chunkId"] == 42
    assert isinstance(data["segments"], list)
    assert len(data["segments"]) == 1

    segment = data["segments"][0]
    # Start/end in ms should be offset by chunkStartTimeMs.
    assert segment["segmentIndex"] == 0
    assert segment["startMs"] == 1000  # 0.0s + 1000ms
    assert segment["endMs"] == 1500    # 0.5s + 1000ms
    assert segment["text"] == "hello"

    metrics = data["metrics"]
    assert metrics["chunkDurationMs"] == 500
    assert metrics["processingMs"] >= 0
    # Real‑time factor is processing / duration; non‑negative and finite.
    assert metrics["realTimeFactor"] >= 0

    # Ensure the fake model was actually invoked.
    assert fake_model.calls

