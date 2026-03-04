import io
import os
import time
import base64

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
    meetingId: str
    chunkId: int
    chunkStartTimeMs: int
    chunkEndTimeMs: int
    audio: str

class TranscribeResponse(BaseModel):
    meetingId: str
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
        app.state.ready = False

@app.get("/health")
def health():
    return {"ready": bool(getattr(app.state, "ready", False)),
            "model_id": getattr(app.state, "model_id", None), 
            "device": getattr(app.state, "device", None),
    }

@app.post("/transcribe")
async def transcribe(request: TranscribeRequest) -> TranscribeResponse:
    model = app.state.model
    try:
        t0 = time.perf_counter()
        audio_bytes = base64.b64decode(request.audio)
        audio_stream = io.BytesIO(audio_bytes)
        segments, info = model.transcribe(audio_stream, language="pt")
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
            meetingId=request.meetingId,
            chunkId=request.chunkId,
            segments=segments,
            metrics=metrics)
        return response

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))