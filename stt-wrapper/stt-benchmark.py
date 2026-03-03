import os
import time

from pathlib import Path
from faster_whisper import WhisperModel
from dotenv import load_dotenv

load_dotenv()

model_id = os.getenv("STT_MODEL_ID")
download_path = os.getenv("STT_DOWNLOAD_PATH")
use_local = os.getenv("STT_USE_LOCAL").strip().lower() == "true"
device_flag = os.getenv("STT_DEVICE") if os.getenv("STT_DEVICE") else "auto"

audio_path = "./tests/kutalia"
audio_files = [f for f in Path(audio_path).glob("*.wav")]

def test(audio_files: list[str]) -> None:
    model = WhisperModel( 
            model_size_or_path=model_id, 
            device=device_flag,
            download_root=download_path, 
            local_files_only=use_local)

    for audio_file in audio_files:
        t0 = time.perf_counter()
        segments, info = model.transcribe(audio_file, language="pt")
        segments = list(segments)
        processing_s = time.perf_counter() - t0
        real_time_factor = processing_s / info.duration
        text = "".join([segment.text for segment in segments])
        print("-"*100)
        print(f"Audio file: {audio_file}")
        print(f"Duration: {info.duration} seconds")
        print(f"Processing time: {processing_s} seconds")
        print(f"Real-time factor: {real_time_factor}")
        print("-"*100)
        print(f"Text: {text}")
        print("-"*100)

test(audio_files)