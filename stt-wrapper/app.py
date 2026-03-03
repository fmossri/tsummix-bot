import os

from fastapi import FastAPI 
from dotenv import load_dotenv
from faster_whisper import WhisperModel

load_dotenv()

model_id = os.getenv("STT_MODEL_ID")
download_path = os.getenv("STT_DOWNLOAD_PATH")
use_local = os.getenv("STT_USE_LOCAL").strip().lower() == "true"
device_flag = os.getenv("STT_DEVICE") if os.getenv("STT_DEVICE") else "auto"

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




