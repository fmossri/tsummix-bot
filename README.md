# discord-meeting-bot

**Status: in progress.**

A Discord bot that implements STT and summarization capabilities.

---

## Current Features

### Discord bot (Node.js) — session and interface

- **`/start`** — Start a meeting from a voice channel. The bot posts a disclaimer with Accept/Reject buttons for all participants. One active session per voice channel.
- **`/close`** — End the meeting, stop capture, flush remaining chunks, and run the end-of-session pipeline. Only participants can close.
- Session state stored in memory (no database). Voice capture, per‑participant chunking, and sending chunks to the Worker are coordinated by the session manager (`services/session-manager/session-manager.js`).

### STT wrapper (Python)

- FastAPI service that loads a faster-whisper model at startup and exposes **`GET /health`** (model id, device, ready) and **`POST /transcribe`** (JSON + base64 audio; returns segments and metrics).
- Model config via env: built-in size, Hugging Face repo id, or local path; cache directory (default `.models/`).

### Transcript worker (Node.js)

- Per-meeting queue and HTTP client to the STT wrapper; appends transcription results to a JSONL file per meeting.
- Standalone HTTP server (`services/transcript-worker/index.js`) with **`/start-meeting`**, **`/enqueue-chunk`**, **`/close-meeting`**. Smoke test: `scripts/transcript-worker/test-from-disk.js` (feeds WAV files from disk).

### Transcript pretty-print & summarization

- After `/close`, the session manager:
  - Asks the transcript Worker to close the meeting and return the path to the JSONL transcript.
  - Generates a human-readable Markdown report (`reports/meeting-report_*.md`) with a fixed-width table: **time | display name | text**, wrapping only the text column.
  - Calls a summarization helper that reads the report and calls a local LLM.
- The first LLM provider is **Ollama** running **`phi3:mini`** locally:
  - Controlled by env vars like `LLM_PROVIDER=ollama`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `LLM_TEMPERATURE`.
  - Supports optional truncation for long meetings with `LLM_TRUNCATION_ENABLED`, `LLM_TRUNCATION_MAX_CHARS`, and a simple chunk‑and‑combine strategy.
- The `/close` command posts a short Markdown summary back to Discord; the full Markdown report stays on disk for inspection.

---

## Intended flow

After participants accept the disclaimer, the bot captures audio from the voice channel and hands it to the session manager, which chunks per participant and enqueues chunks to the Worker. The Worker calls the STT service for transcription and writes a JSONL transcript per meeting. On `/close`, the session manager stops capture, closes the Worker meeting to get the transcript path, pretty‑prints the transcript into a Markdown report, and calls an LLM to summarize it; the bot then posts the summary in Discord.  
**Done:** Session and disclaimer; STT wrapper `/transcribe` API; transcript Worker (queue, STT client, JSONL file, standalone server); bot voice capture, per‑participant decode & chunk, and sending chunks to the Worker; end‑of‑meeting pretty‑print and summarization on `/close`.  
**Next:** Integration tests and stronger error-handling around Worker/STT/LLM failures.

---

## Prerequisites

- **Node.js** 18+ (or recent LTS)
- **Python 3.12+** (for the STT wrapper)
- **Discord:** [Create an application](https://discord.com/developers/applications), add a bot user, invite it to your server with the right permissions
- **GPU (optional):** For `STT_DEVICE=cuda` you need a CUDA-capable GPU and, on WSL/Linux, the venv CUDA libs on the loader path (see Installation note)

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
   source .venv/bin/activate   # Windows: .venv\Scripts\activate. Alternatively, use `source scripts/env.sh` (also sets CUDA libs if needed).
   pip install -r requirements.txt
   ```

   **GPU (CUDA):** If you use `STT_DEVICE=cuda` and get `Library libcublas.so.12 is not found`, the venv’s CUDA libs are not on the loader path.  
   - **Unix (Linux/macOS/WSL):** Run `source scripts/env.sh` or `. scripts/env.sh` before starting Python; it activates the venv and sets `LD_LIBRARY_PATH` to the venv’s `nvidia/cublas/lib` and `nvidia/cudnn/lib`.  
   - **Windows (cmd):** Run `scripts\env.bat` to activate the venv and add those dirs to `PATH`.  
   If your venv or Python version path differs, edit the script.

---

## Configuration

Copy `.env-example` to `.env` and set:

| Variable                 | Description |
|--------------------------|-------------|
| `DISCORD_TOKEN`          | Bot token (Developer Portal → Bot → Reset Token) |
| `APP_ID`                 | Application ID (Developer Portal → General Information) |
| `SERVER_ID`              | Guild ID where slash commands are registered |
| `PUBLIC_KEY`             | Application public key (Developer Portal → General Information) |
| `STT_MODEL_ID`           | Model to load: built-in size (e.g. `medium`), HF repo id (e.g. `dwhoelz/whisper-medium-pt-ct2`), or local path to a CTranslate2 model dir |
| `STT_DOWNLOAD_PATH`      | Where to download/cache models when using a size or HF repo (default `.models/`). Ignored when `STT_MODEL_ID` is a local path. First run may download. |
| `STT_USE_LOCAL`          | Use only cached models, no network. Set to `true` after first download or for offline. |
| `STT_DEVICE`             | Device for inference: `cpu`, `cuda`, or `auto`. |
| `STT_LANGUAGE`           | Optional. Language hint for transcription (e.g. `pt`, `en`). See Whisper language codes. |
| `STT_BASE_URL`           | Base URL of the STT wrapper (e.g. `http://localhost:8000`). Used by the transcript Worker. |
| `WORKER_PORT`            | Port for the transcript Worker HTTP server (e.g. `3000`). Used when running `node services/transcript-worker/index.js`. |
| `LLM_PROVIDER`           | LLM provider to use for summaries (currently `ollama`). |
| `LLM_USE_LOCAL`          | Whether to use a local LLM instead of a remote API. |
| `OLLAMA_BASE_URL`        | Base URL of the Ollama server (e.g. `http://localhost:11434`). |
| `OLLAMA_MODEL`           | Ollama model name to use (e.g. `phi3:mini`). |
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
2. Start the bot:
   ```bash
   node index.js
   ```

You may add to `package.json`: `"start": "node index.js"`, `"deploy": "node deploy-commands.js"`.

**STT wrapper**

- Run the API (from repo root, with venv activated):
  ```bash
  uvicorn stt-wrapper.app:app --reload
  ```
- Run the simple REPL benchmark against WAV files (WAVs under `tests/audio-samples/` or path in script):
  ```bash
  python3 stt-wrapper/repl.py
  ```
- Run the standalone model benchmark script (measures model/options latency only, no HTTP):
  ```bash
  python3 scripts/stt-wrapper/model_benchmark.py
  ```
- Run a manual smoke test against the wrapper HTTP API (`/health` and `/transcribe`):
  ```bash
  python3 scripts/stt-wrapper/smoke_stt_wrapper.py
  ```

**Transcript worker**

- Run the worker HTTP server (from repo root, with STT wrapper running):
  ```bash
  node services/worker/index.js
  ```
- Run a smoke test that feeds WAV files from disk into the worker (in-process): start meeting, enqueue each file as a chunk, close meeting, then print transcript path and a short preview. Default directory: `tests/audio-samples`. Optional argument: path to a folder of `.wav` files (e.g. `tests/audio-files`).
  ```bash
  node scripts/transcript-worker/test-from-disk.js [audio-dir]
  ```

---

## Commands

| Command   | Description |
|-----------|-------------|
| `/start` | Start a meeting. Must be in a voice channel. | 
| `/close` | Close the session and delete session data. Must be in the same voice channel. |

---

## Project structure

| Path | Description |
|------|-------------|
| `index.js` | Bot entry point; loads commands, events, starts client (Guilds + GuildVoiceStates intents) |
| `deploy-commands.js` | Registers slash commands for one guild |
| `commands/utility/` | Slash commands: `start.js`, `close.js` |
| `events/` | `ready.js`, `interactionCreate.js` |
| `session.js` | In-memory session store (`sessionStore`) |
| `handleDisclaimerButtons.js` | Handles disclaimer Accept/Reject buttons |
| `stt-wrapper/app.py` | FastAPI app: `/health`, `/transcribe`, model load at startup |
| `stt-wrapper/repl.py` | Simple REPL-style script: run transcription on WAV files |
| `scripts/stt-wrapper/model_benchmark.py` | Python model benchmark: measure faster-whisper latency for different configs (no HTTP) |
| `scripts/stt-wrapper/smoke_stt_wrapper.py` | Manual smoke test for the STT wrapper HTTP API (`/health`, `/transcribe`) |
| `services/transcript-worker/transcript-worker.js` | Transcript Worker: per-meeting queue, STT client, JSONL transcript |
| `services/transcript-worker/index.js` | Transcript Worker HTTP server: `/start-meeting`, `/enqueue-chunk`, `/close-meeting` |
| `services/report-generator/report-generator.js` | Generates pretty-printed Markdown reports (`reports/meeting-report_*.md`) from JSONL transcripts |
| `services/report-generator/summary-generator.js` | Calls an LLM to summarize a report into a short Markdown summary |
| `services/report-generator/llm-adapters/` | Provider-specific LLM adapters (e.g. Ollama chat API client) |
| `services/session-manager/session-manager.js` | Manages Discord voice connections and per-meeting state: captures participant audio, enqueues chunks to the Worker, closes meetings, generates reports, and runs LLM summarization |
| `scripts/transcript-worker/test-from-disk.js` | Smoke test: feed WAV files from disk through the Worker (start → enqueue → close → preview transcript) |
| `scripts/env.sh` | Unix: activate venv + set `LD_LIBRARY_PATH` for CUDA libs |
| `scripts/env.bat` | Windows: activate venv + set `PATH` for CUDA libs |
| `requirements.txt` | Python deps (FastAPI, faster-whisper, etc.) |
| `.env-example` | Example env vars (Discord + STT); copy to `.env` |

---

## License

Private / no license specified.
