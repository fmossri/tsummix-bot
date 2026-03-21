"""Prometheus metrics for the STT wrapper (GET /metrics). Unauthenticated scrape endpoint."""

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest
from starlette.responses import Response

# Histogram buckets in seconds (inference wall time inside the wrapper).
_PROCESSING_BUCKETS = (
    0.01,
    0.025,
    0.05,
    0.1,
    0.25,
    0.5,
    1.0,
    2.5,
    5.0,
    10.0,
    30.0,
    60.0,
    float("inf"),
)

stt_wrapper_ready = Gauge(
    "stt_wrapper_ready",
    "Whether the Whisper model finished loading (1) or not (0)",
)
stt_wrapper_transcribes_total = Counter(
    "stt_wrapper_transcribes_total",
    "Successful /transcribe completions",
)
stt_wrapper_transcribe_errors_total = Counter(
    "stt_wrapper_transcribe_errors_total",
    "Failed /transcribe requests (exceptions after model loaded)",
)
stt_wrapper_processing_seconds = Histogram(
    "stt_wrapper_processing_seconds",
    "Inference time inside the wrapper (seconds)",
    buckets=_PROCESSING_BUCKETS,
)


def observe_transcribe_success(processing_ms: int) -> None:
    stt_wrapper_transcribes_total.inc()
    stt_wrapper_processing_seconds.observe(processing_ms / 1000.0)


def observe_transcribe_error() -> None:
    stt_wrapper_transcribe_errors_total.inc()


def metrics_response() -> Response:
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)
