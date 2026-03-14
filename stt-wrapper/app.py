import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
if _here not in sys.path:
    sys.path.insert(0, _here)
import cuda_env  # noqa: E402 — set LD_LIBRARY_PATH before faster_whisper

import io
import time
import base64
import traceback
import wave

import numpy as np
from fastapi import FastAPI, HTTPException
from dotenv import load_dotenv
from faster_whisper import WhisperModel
from pydantic import BaseModel

class Segment(BaseModel):
    segmentIndex: int
    startMs: int
    endMs: int
    text: str

class Metrics(BaseModel):
    chunkDurationMs: int
    processingMs: int
    realTimeFactor: float

class TranscribeRequest(BaseModel):
    transcriptId: str
    chunkId: int
    chunkStartTimeMs: int
    audio: str

class TranscribeResponse(BaseModel):
    transcriptId: str
    chunkId: int
    segments: list[Segment]
    metrics: Metrics

load_dotenv()

model_id = os.getenv("STT_MODEL_ID")
download_path = os.getenv("STT_DOWNLOAD_PATH")
raw = os.getenv("STT_USE_LOCAL", "")
use_local = raw.strip().lower() == "true"
device_flag = os.getenv("STT_DEVICE") if os.getenv("STT_DEVICE") else "auto"
language_flag = os.getenv("STT_LANGUAGE") if os.getenv("STT_LANGUAGE") else ""

app = FastAPI(
    title="STT Wrapper",
    description="A wrapper for the STT model",
    version="0.1.0",
)
app.state.ready = False
app.state.model = None
app.state.model_id = model_id
app.state.device = device_flag

@app.on_event("startup")
async def startup():
    try:
        model = WhisperModel( 
            model_size_or_path=model_id, 
            device=device_flag,
            download_root=download_path, 
            local_files_only=use_local
        )
        app.state.model = model
        app.state.ready = True
    except Exception as e:
        traceback.print_exc()
        app.state.ready = False

@app.get("/health")
def health():
    return {"ready": bool(getattr(app.state, "ready", False)),
            "model_id": getattr(app.state, "model_id", None), 
            "device": getattr(app.state, "device", None),
    }

def _wav_bytes_to_float32_mono(audio_bytes: bytes) -> tuple[np.ndarray, int]:
    """Decode WAV bytes (16-bit mono or stereo) to float32 mono at native sample rate.
    Returns (samples_float32, sample_rate). Expects 16 kHz mono from the Node worker.
    """
    with wave.open(io.BytesIO(audio_bytes), "rb") as wav_file:
        n_channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        framerate = wav_file.getframerate()
        n_frames = wav_file.getnframes()
        raw = wav_file.readframes(n_frames)
    if sample_width != 2:
        raise ValueError(f"Unsupported WAV sample width: {sample_width} (expected 2)")
    # 16-bit signed little-endian -> float32 in [-1, 1]
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if n_channels > 1:
        samples = samples.reshape(-1, n_channels).mean(axis=1)
    return samples, framerate


@app.post("/transcribe")
async def transcribe(request: TranscribeRequest) -> TranscribeResponse:
    if not app.state.ready or app.state.model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    model = app.state.model
    try:
        t0 = time.perf_counter()
        audio_bytes = base64.b64decode(request.audio)
        audio_float32, sample_rate = _wav_bytes_to_float32_mono(audio_bytes)
        segments, info = model.transcribe(audio_float32, language="pt")
        segments = [
            Segment(
                segmentIndex=i, 
                startMs=request.chunkStartTimeMs + int(segment.start * 1000), 
                endMs=request.chunkStartTimeMs + int(segment.end * 1000), 
                text=segment.text
                ) for i, segment in enumerate(list(segments))]
        processing_ms = int((time.perf_counter() - t0) * 1000)
        duration_ms = int(info.duration * 1000)
        real_time_factor = processing_ms / duration_ms if duration_ms > 0 else 0.0
        metrics = Metrics(
            chunkDurationMs=duration_ms,
            processingMs=processing_ms, 
            realTimeFactor=real_time_factor)

        response = TranscribeResponse(
            transcriptId=request.transcriptId,
            chunkId=request.chunkId,
            segments=segments,
            metrics=metrics)
        return response

    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))