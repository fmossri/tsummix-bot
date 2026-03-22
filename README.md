# Tsummix

**Status:** Early (v0.4). Core flow works: start → disclaimer → accept → capture → close → transcript, report, and summary in Discord. Pause and resume supported. Auto-close when the room is empty for too long. Configurable audio chunking (fixed-size or silence-based with three-tier detection). Transcript and report timestamps reflect real (wall-clock) meeting time. Service-to-service authentication (Bot ↔ Worker, Worker ↔ Wrapper) in place for non-local deployments. Test suite in place (unit + integration).

A Discord bot that implements STT and summarization capabilities.

---

## Current Features

### Discord bot (Node.js) — session and interface

- **`/start`** — Start a meeting from a voice channel. The bot posts a disclaimer with Accept/Reject buttons for all participants. One active meeting per server (guild) is enforced; starting a second is rejected with a clear message.
- **`/pause`** — Pause recording: stop audio capture and sending chunks. Worker drains existing chunks and idles. Transcript state preserved.
- **`/resume`** — Resume recording: re-subscribe to in-channel participants and resume chunk flow.
- **`/close`** — End the meeting, stop capture, flush remaining chunks, and run the end-of-session pipeline. Only participants can close.
- **Auto-close on empty room** — If everyone leaves the voice channel without `/close`, the bot pauses and waits. After a configurable timeout with no one rejoining, it auto-closes the meeting and posts a message. Timeouts are set in `config/index.js` (explicit pause, paused-empty-room, empty-room, UI confirm).
- **Configurable audio chunking** — Two strategies selectable via `CHUNKING_STRATEGY` env var:
  - `fixedSize` (default) — cuts at a fixed sample count (default 30s).
  - `silenceBased` — three-tier detection: (1) clean cut at silence after a minimum duration, (2) forced cut at max duration at the lowest-energy point, (3) idle-timeout cut when the speaker goes silent for too long. Thresholds and durations configurable via env vars.
- Session state stored in memory (no database). A **controller** (`controller/meeting-controller.js`) handles all Discord flow: disclaimer, Accept/Reject, voice join/subscribe, close confirmation. A **session manager** (`services/session-manager/session-manager.js`) handles transcript lifecycle, PCM chunking (delegating to the chosen strategy), and report/summary generation.

### STT wrapper (Python)

- FastAPI service that loads a [faster-whisper](https://github.com/SYSTRAN/faster-whisper) model at startup and exposes **`GET /health`** (model id, device, ready) and **`POST /transcribe`** (JSON + base64 audio; returns segments and metrics).
- Model config via env: built-in size, Hugging Face repo id, or local path; cache directory (default `.models/`).

### Transcript worker (Node.js)

- Per-transcript queue and HTTP client to the STT wrapper; writes JSONL transcript per meeting/session (metadata header at start, segments and optional gap markers). On close, the worker orders all lines by time then chunk so the report shows a chronological timeline; if a chunk failed STT or never reached the worker, a gap line is written so the reader sees where content is missing. API: `startTranscript(transcriptId, meetingStartTimeMs)`, `enqueueChunk(transcriptId, chunk)`, `closeTranscript(transcriptId, { channelId, participantDisplayNames, closure })`.
- The worker can run in-process or as a separate HTTP service, selected via configuration. An adapter (`services/transcript-worker/get-transcript-worker.js`) always exposes the same `{ startTranscript, enqueueChunk, closeTranscript }` interface and, when running out-of-process, uses an internal HTTP client to call the worker server.
- Standalone HTTP server (`services/transcript-worker/index.js`) with **`/start-transcript`**, **`/enqueue-chunk`**, **`/close-transcript`**. When configured to use HTTP, the bot calls these endpoints via the worker adapter.

### Observability (logs + in-process metrics)

- Structured JSON logs via `services/logger/logger.js` (stdout and/or rotated files under `LOG_FILE_DIR`). Set `LOG_LEVEL` to control verbosity (`debug` | `info` | `warn` | `error` | `silent`; default `info` when unset or invalid). Use `silent` to disable all log output (e.g. in tests). With Docker observe, **`LOG_TO_STDOUT=false`** and **`LOG_FILE_DIR=/var/log/tsummix`** avoid duplicating the same JSON in Loki (Promtail reads files + Docker logs).
- Minimal in-process metrics via `services/metrics/metrics.js` (counters, gauges, histograms) updated alongside log calls. Each process can expose **Prometheus** text at **`GET /metrics`**: the bot (when `BOT_METRICS_PORT` is set), the transcript worker HTTP server, and the STT wrapper. With **`WORKER_USE_LOCAL=true`**, all Node metrics live in the bot process, so you need the bot’s `/metrics` enabled for Prometheus to scrape Node series; with **`WORKER_USE_LOCAL=false`**, scrape both bot and worker. Includes:
  - `worker_queue_depth` (gauge)
  - `stt_latency_ms` (histogram)
  - `stt_queue_wait_ms` (histogram; time from worker chunk receipt to processing start)
  - `chunk_duration_ms` (histogram; audio duration of each chunk cut by the session manager)
  - `meeting_duration_ms` (histogram; wall-clock duration of each meeting)

### Transcript pretty-print & summarization

- After `/close`, the session manager:
  - Asks the transcript worker to close the transcript and return the path to the JSONL file.
  - Generates a human-readable Markdown report (`reports/meeting-report_*.md`) with a fixed-width table: **time | display name | text**, wrapping only the text column.
  - Calls a summarization helper that reads the report and calls a local LLM.
  - Inserts the summary back into the same report file as a `## Summary` section placed immediately before the transcript table.
- The first LLM provider is **Ollama** running **`phi3:mini`** locally:
  - Controlled by env vars like `LLM_PROVIDER=ollama`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `LLM_TEMPERATURE`.
  - Supports optional truncation for long meetings with `LLM_TRUNCATION_ENABLED`, `LLM_TRUNCATION_MAX_CHARS`, and a simple chunk‑and‑combine strategy.
- The `/close` command posts a short Markdown summary back to Discord; the full Markdown report stays on disk for inspection.
- Report generation requires the transcript to contain at least one segment; summary generation requires the LLM to return non-empty content. If either step fails, the user sees an error on confirm and the failure is logged with a distinct category (report vs summary).

---

## Flow

After participants accept a disclaimer, the bot joins the voice channel and subscribes to each accepting participant’s audio stream; the session manager chunks PCM using the configured strategy (fixed-size or silence-based) and enqueues chunks to the worker. The worker calls the STT wrapper and appends to a JSONL transcript. `/pause` stops capture and chunk flow; the worker drains and idles. `/resume` re-subscribes to in-channel participants and resumes. On `/close` (with confirm), the controller stops capture, the session manager closes the worker, generates a Markdown report, and runs the LLM summary; the manager adds the summary to the report and the controller posts it to Discord. If everyone leaves without closing, the bot auto-closes after a configured timeout.

**Current:** Full happy path works, including pause and resume. Unit tests (session store, worker, report/summary, session manager, chunking strategies, controller, commands, voiceStateUpdate) and integration tests covering happy path, pause/resume flow, silence-based chunking, and failure cases (worker down, STT retries).

---

## Prerequisites

- **Node.js** 18+ (or recent LTS)
- **Python 3.12+** (for the STT wrapper)
- **Discord:** [Create an application](https://discord.com/developers/applications), add a bot user, invite it to your server with the right permissions
- **GPU (optional):** For `STT_DEVICE=cuda` you need a CUDA-capable GPU and the venv CUDA libs on the loader path (see Installation note)

---

## Installation

1. **Clone and enter the repo**
   ```bash
   git clone <repository-url>
   cd discord-meeting-bot
   ```

2. **Install Node dependencies**
   ```bash
   npm install
   ```

3. **Environment file**
   ```bash
   cp .env-example .env
   ```
   Fill in Discord and STT variables (see **Configuration** below).

4. **Python STT wrapper**
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate   # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```
   The default `requirements.txt` includes CUDA-related pip packages (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12`). For **CPU-only** (e.g. no NVIDIA GPU), remove those two lines from `requirements.txt` before installing them.

   **GPU (CUDA):** The STT app and scripts import `stt-wrapper/cuda_env.py` first, which locates the venv’s CUDA libraries (e.g. `libcublas.so.12`, `libcudnn.so`) under `site-packages/nvidia/.../lib` and prepends them to `LD_LIBRARY_PATH` if they are not already there. This works around an issue where the dynamic linker could not find these CUDA libs when the venv was activated, causing faster-whisper/CTranslate2 to fail to load CUDA even though the packages were installed.

5. **LLM (summaries)**
   Tsummix uses an LLM to generate meeting summaries. It's built to be **LLM-agnostic** (local models via Ollama or Hugging Face, or inference APIs like Gemini, GPT, DeepSeek, via env and credentials); **currently it only supports local models through [Ollama](https://ollama.com/download)**. Install Ollama for your OS, ensure the service is running (on many installs it runs automatically), then pull your preferred model:
   ```bash
   ollama pull model
   ```
   Set `OLLAMA_MODEL=model` and other LLM-related variables in `.env` (see **Configuration**).

---

## Configuration

Copy `.env-example` to `.env` and set:

| Variable                   | Description |
|----------------------------|-------------|
| `DISCORD_AUTH_TOKEN`       | Bot token (Developer Portal → Bot → Reset Token) |
| `APP_ID`                   | Application ID (Developer Portal → General Information) |
| `SERVER_ID`                | Optional. If set, `deploy-commands.js` registers slash commands in this guild only (instant). If unset, commands are registered globally (all servers; propagation can take up to 1 hour). |
| `WORKER_AUTH_TOKEN`        | Shared secret for Bot ↔ Worker auth. Required when `WORKER_USE_LOCAL=false`. Must match in both Bot and Worker containers. |
| `STT_AUTH_TOKEN`           | Shared secret for Worker ↔ STT Wrapper auth. Required in all non-local deployments. Must match in both Worker and Wrapper containers. |
| `LOG_LEVEL`                | Log level for structured JSON logs: `debug`, `info`, `warn`, `error`, or `silent`. Default `info` if unset or invalid. |
| `LOG_FILE_DIR`             | Optional. Directory for rotated JSON logs (`rotating-file-stream`). Unset = stdout only. In Compose observe, use with `LOG_TO_STDOUT=false` to avoid duplicate lines in Loki. |
| `LOG_FILE_NAME`            | Optional. Log file basename (default `tsummix.log`). Use distinct names per bot vs worker in Compose (`bot.log`, `worker.log`). |
| `LOG_FILE_MAX_SIZE`        | Optional. Rotation size (default `10M`). |
| `LOG_FILE_MAX_FILES`       | Optional. Max rotated files to keep (default `14`). |
| `LOG_TO_STDOUT`            | Optional. When `LOG_FILE_DIR` is set, defaults to `false` so Docker + Promtail do not duplicate JSON; set `true` for console + file (may duplicate in Loki if both Docker and file scrape apply). |
| `BOT_METRICS_PORT`         | If set, the bot process serves **`GET /metrics`** (Prometheus) on this port. Default bind is loopback (`127.0.0.1`); override with `BOT_METRICS_BIND`. Unset = no metrics HTTP server. **Required for Prometheus to scrape Node metrics when `WORKER_USE_LOCAL=true`** (in-process worker). |
| `BOT_METRICS_BIND`         | Address the bot’s `/metrics` listener binds to (default `127.0.0.1`). Use `0.0.0.0` when Prometheus runs in Docker and must reach the bot on the host network. |
| `STT_MODEL_ID`             | Model to load: built-in size (e.g. `medium`), HF repo id (e.g. `dwhoelz/whisper-medium-pt-ct2`), or local path to a CTranslate2 model dir |
| `STT_DOWNLOAD_PATH`      | Where to download/cache models when using a size or HF repo (default `.models/`). Ignored when `STT_MODEL_ID` is a local path. First run may download. |
| `STT_USE_LOCAL`          | Use only cached models, no network. Set to `true` after first download or for offline. |
| `STT_DEVICE`             | Device for inference: `cpu`, `cuda`, or `auto`. |
| `STT_LANGUAGE`           | Optional. Language hint for transcription (e.g. `pt`, `en`). See Whisper language codes. |
| `STT_BASE_URL`           | Base URL of the STT wrapper (e.g. `http://localhost:8000`). |
| `STT_TIMEOUT_MS`         | Timeout in ms for each worker → wrapper `POST /transcribe` call (default `5000`). |
| `STT_READY_TIMEOUT_MS`   | Optional. Max time in ms for the transcript worker to wait for the STT wrapper `/health` at startup (default `120000`). |
| `STT_READY_POLL_MS`      | Optional. Interval in ms between `/health` polls while waiting (default `500`). |
| `WORKER_USE_LOCAL`       | Whether the transcript worker runs in-process (`true`) or is called over HTTP (`false`). |
| `WORKER_BASE_URL`        | Base URL of the worker HTTP server when `WORKER_USE_LOCAL=false` (e.g. `http://localhost:3000`). |
| `WORKER_PORT`            | Port for the worker HTTP server when `WORKER_USE_LOCAL=false` (e.g. `3000`). |
| `LLM_PROVIDER`           | LLM provider to use for summaries (currently `ollama`). |
| `LLM_USE_LOCAL`          | Whether to use a local LLM instead of a remote API. Reserved for future providers; not read by config today. Summaries use `LLM_PROVIDER` (e.g. `ollama`). |
| `OLLAMA_BASE_URL`        | Base URL of the Ollama server (e.g. `http://localhost:11434`). |
| `OLLAMA_MODEL`           | Ollama model name to use (e.g. `phi3:mini`). |
| `CHUNKING_STRATEGY`      | Audio chunking strategy: `fixedSize` (default) or `silenceBased`. |
| `MIN_CHUNK_MS`           | Minimum chunk duration in ms before silence-based cut is allowed (default `20000`). |
| `MAX_CHUNK_MS`           | Maximum chunk duration in ms; forced cut at this length (default `30000`). |
| `SILENCE_THRESHOLD`      | RMS energy threshold for silence detection (default `500`). |
| `SILENCE_HOLD_MS`        | Duration in ms of silence at the buffer tail required to trigger a clean cut (default `1000`). |
| `TAIL_WINDOW_MS`         | Tail window in ms scanned for the lowest-energy cut point on forced cuts (default `3000`). |
| `IDLE_TIMEOUT_MS`        | Wall-clock silence gap in ms before idle-timeout cuts a stale buffer (default `5000`). |
| `LLM_TRUNCATION_ENABLED` | Enable truncation for long reports before calling the LLM (`true`/`false`). |
| `LLM_TRUNCATION_MAX_CHARS` | Maximum number of report characters to send per LLM call (e.g. `12000`). |
| `LLM_TRUNCATION_STRATEGY` | Truncation strategy: `tail` (most recent part) or `head` (start of meeting). |
| `LLM_SYSTEM_PROMPT`      | Optional custom system prompt for summarization; if empty, a default PT-BR prompt is used. |
| `LLM_TEMPERATURE`        | Sampling temperature for the LLM (e.g. `0.7`). |

---

## Usage

**Discord bot**

1. Register slash commands (once, or after changing commands):
   ```bash
   node deploy-commands.js
   ```
2. Start the bot and STT wrapper (`npm start` and `node scripts/tsummix.js run` are equivalent):
   ```bash
   npm start              # bot + STT wrapper
   npm run start:bot      # only Node bot
   npm run start:stt      # only STT wrapper
   ```
   To run from the shell without `npm`, link once: `npm link`. Only one **`tsummix run`** per clone (`.tsummix.lock`; delete if a run crashed).

   ```text
   tsummix run [bot|stt|worker|dev|prod] [--distribute|-d] [--observe|-o]
   ```

   | Flag | Meaning |
   |------|---------|
   | `-d` / `--distribute` | Transcript worker over HTTP (separate Node process) instead of in-process. |
   | `-o` / `--observe` | Prometheus, Grafana, Loki, Promtail. **Local:** `docker-compose.observe-local.yml` (detached), then your processes. **`dev` / `prod`:** merge `docker-compose.observe.yml`. |

   Short flags combine (e.g. **`-do`**). **`dev`** = `docker-compose.dev.yml`; **`prod`** = `docker-compose.prod.yml`.

   ```bash
   tsummix run                 # bot + STT, worker in-process, no Docker
   tsummix run -do             # local: distributed + observability
   tsummix run dev -o          # compose dev + observability
   tsummix run prod -do        # compose prod + distributed + observability
   ```

**Tests:** `npm test` (Jest; unit and integration tests, mocks for Discord/STT/LLM). By default tests set `LOG_LEVEL=silent` so no JSON log lines are printed; override with `LOG_LEVEL=info npm test` when debugging. For the Python STT wrapper, with your venv activated:
```bash
pytest tests/stt_wrapper/test_app.py
```

**STT wrapper**

- Run the API (from repo root, with venv activated). Prefer the same entry as `tsummix run stt` so `cuda_env` runs first:
  ```bash
  python3 scripts/run_stt_server.py
  ```
  For reload during development you can run uvicorn directly if the CUDA path is already correct:
  ```bash
  uvicorn stt_wrapper.app:app --reload
  ```
- Run the standalone model benchmark script (measures model/options latency only, no HTTP). Use **python** (not bash):
  ```bash
  python3 scripts/stt-wrapper/model_benchmark.py
  ```
  The app and this benchmark set `LD_LIBRARY_PATH` for the venv’s CUDA libs at startup.
- Run a manual smoke test against the wrapper HTTP API (`/health` and `/transcribe`):
  ```bash
  python3 scripts/stt-wrapper/smoke_stt_wrapper.py
  ```

**Transcript worker**

- HTTP mode prerequisites (`WORKER_USE_LOCAL=false`):
  - Bot env must set `WORKER_BASE_URL` and `WORKER_AUTH_TOKEN`.
  - Worker env must set matching `WORKER_AUTH_TOKEN`.
  - STT wrapper must be reachable at `STT_BASE_URL` with matching `STT_AUTH_TOKEN`.
- Run only the worker server from repo root:
  ```bash
  node services/transcript-worker/index.js
  ```
- To start bot + worker + STT together locally, use:
  ```bash
  tsummix run --distribute
  ```
  (`tsummix run worker` starts only the worker process.)

---

## Commands

| Command   | Description |
|-----------|-------------|
| `/start` | Start a meeting. Must be in a voice channel. |
| `/pause` | Pause recording. Must be a participant in an active meeting. |
| `/resume` | Resume recording. Must be a participant in a paused meeting. |
| `/close` | Close the session and delete session data. Must be in the same voice channel. |

---

## Project structure

| Path | Description |
|------|-------------|
| `index.js` | Bot entry point; loads commands, events, starts client (Guilds + GuildVoiceStates intents) |
| `deploy-commands.js` | Registers slash commands for one guild |
| `commands/utility/` | Slash commands: `start.js`, `pause.js`, `resume.js`, `close.js` |
| `events/` | `ready.js`, `interactionCreate.js` |
| `session.js` | In-memory session store (`sessionStore`) |
| `config/index.js` | Central configuration: chunking strategy and thresholds (ms → samples conversion), worker and manager config, timeouts, LLM timeouts |
| `controller/meeting-controller.js` | Orchestrates meeting flow: start/pause/resume/close, disclaimer message + Accept/Reject buttons, join/subscribe, Session Manager |
| `stt_wrapper/app.py` | FastAPI app: `/health`, `/transcribe`, `/metrics` (Prometheus), model load at startup |
| `stt_wrapper/prometheus_metrics.py` | Wrapper Prometheus metrics (`prometheus_client`); scrape without auth — protect via network |
| `scripts/stt-wrapper/model_benchmark.py` | Python model benchmark: measure faster-whisper latency for different configs (no HTTP) |
| `scripts/stt-wrapper/smoke_stt_wrapper.py` | Manual smoke test for the STT wrapper HTTP API (`/health`, `/transcribe`) |
| `services/logger/logger.js` | Structured JSON logger; stdout and/or rotated files (`LOG_FILE_*`); `rotating-file-stream` |
| `services/logger/file-sink.js` | Rotating file sink for Promtail/Loki |
| `services/metrics/metrics.js` | In-process metrics (counters/gauges/histograms) for observability |
| `services/metrics/prometheus-exporter.js` | Prometheus text exposition from `getSnapshot()`; bot `GET /metrics` when `BOT_METRICS_PORT` is set (`BOT_METRICS_BIND`, default `127.0.0.1`) |
| `services/transcript-worker/transcript-worker.js` | Transcript worker: per-transcript queue, STT client, JSONL transcript lifecycle |
| `services/transcript-worker/index.js` | Transcript worker HTTP server: `/metrics` (Prometheus, no auth), `/start-transcript`, `/enqueue-chunk`, `/close-transcript` |
| `services/transcript-worker/get-transcript-worker.js` | Adapter that returns either the in-process worker or an HTTP client based on configuration |
| `services/report-generator/report-generator.js` | Generates pretty-printed Markdown reports (`reports/meeting-report_*.md`) from JSONL transcripts |
| `services/report-generator/summary-generator.js` | Calls an LLM to summarize a report into a short Markdown summary |
| `services/report-generator/llm-adapters/` | Provider-specific LLM adapters (e.g. Ollama chat API client) |
| `services/session-manager/session-manager.js` | Transcript worker lifecycle, PCM chunking (delegates to the configured strategy), report and summary generation. Controller owns voice and capture. |
| `services/session-manager/chunking/choose-strategy.js` | Chunking strategy selector and implementations (`fixedSize`, `silenceBased`) plus audio helpers (`calculateRMS`, `checkRecentSilence`, `findLowestEnergyPoint`). |
| `services/session-manager/convert-pcm-to-wav.js` | Helper: raw PCM buffer → WAV (16 kHz mono); used by session manager chunker. |
| `scripts/tsummix.js` | CLI: `tsummix run` (local), `tsummix run dev/prod [-d] [-o]` (compose + optional Prometheus/Grafana overlay), worker-only. Use after `npm link`. |
| `docker-compose.observe.yml` | Optional merge: Prometheus, Grafana, Loki, Promtail; use with `tsummix run dev/prod -o` |
| `docker-compose.observe-local.yml` | Observability stack only (Docker); use with `tsummix run -o` / `bot -o` / … for host-scraped metrics |
| `docker/prometheus/prometheus.yml` | Scrape targets when the app runs in Compose (service DNS names) |
| `docker/prometheus/prometheus.host.yml` | Scrape targets when the app runs on the host (`host.docker.internal`) |
| `docker/promtail/promtail-config.yaml` | Promtail: Docker log discovery → Loki (requires Docker socket mount) |
| `docker/grafana/provisioning/` | Grafana: datasources (Prometheus + Loki), dashboard provider, **Tsummix overview** dashboard (JSON) |
| `tests/jest.setup.js` | Jest setup: default `LOG_LEVEL=silent` so test output stays readable |
| `requirements.txt` | Python deps (FastAPI, faster-whisper, etc.) |
| `.env-example` | Example env vars (Discord + STT); copy to `.env` |

---

## License

Private / no license specified.
