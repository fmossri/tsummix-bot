# discord-meeting-bot

**Status: in progress.**

A Discord bot that implements STT and summarization capabilities.

---

## Current Features

### STT wrapper (Python) — **in progress**

- FastAPI service that loads a faster-whisper model at startup and exposes **`GET /health`** (model id, device, ready).
- Model config via env: built-in size, Hugging Face repo id, or local path; cache directory (default `.models/`).
- Benchmark script `stt-wrapper/repl.py` for testing transcription on WAV files (see `docs/STT-BENCHMARKS.md` if present).

### Discord bot (Node.js) — session and interface

- **`/start`** — Start a meeting from a voice channel. The bot posts a disclaimer with Accept/Reject buttons for all participants. One active session per voice channel.
- **`/close`** — End the session and delete session data. Only participants can close.
- Disclaimer flow with a one-minute timeout; if not everyone accepts in time, the session is aborted.
- Session state stored in memory (no database).

---

## Intended flow

After participants accept the disclaimer, the bot captures audio from the voice channel, sends it (via a Worker) to the STT service for transcription, receives the full transcript, then sends it to an LLM for summarization. Session handling and disclaimer are in place; voice capture, Worker, and LLM summarization are in progress (see docs).

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

| Variable           | Description |
|--------------------|-------------|
| `DISCORD_TOKEN`    | Bot token (Developer Portal → Bot → Reset Token) |
| `APP_ID`           | Application ID (Developer Portal → General Information) |
| `SERVER_ID`        | Guild ID where slash commands are registered |
| `PUBLIC_KEY`       | Application public key (Developer Portal → General Information) |
| `STT_MODEL_ID`     | Model to load: built-in size (e.g. `medium`), HF repo id (e.g. `dwhoelz/whisper-medium-pt-ct2`), or local path to a CTranslate2 model dir |
| `STT_DOWNLOAD_PATH` | Where to download/cache models when using a size or HF repo (default `.models/`). Ignored when `STT_MODEL_ID` is a local path. First run may download. |
| `STT_USE_LOCAL`    | Use only cached models, no network. Set to `true` after first download or for offline. |
| `STT_DEVICE`       | Device for inference: `cpu`, `cuda`, or `auto`. |
| `STT_LANGUAGE`     | Optional. Language hint for transcription (e.g. `pt`, `en`). See [Whisper language codes](https://github.com/openai/whisper#available-models-and-languages). |

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
- Run the benchmark script (WAVs under `tests/audio-samples/` or path in script):
  ```bash
  python3 stt-wrapper/repl.py
  ```

---

## Commands

| Command   | Description |
|-----------|-------------|
| `/start` | Start a meeting. You must be in a voice channel. Bot posts a disclaimer; each participant must Accept or Reject. Session times out after 1 minute if not everyone accepts. **in progress** | 
| `/close` | Close the session and delete session data. You must be in the same voice channel, be a participant, and the disclaimer must have been accepted by all. **in progress** |

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
| `stt-wrapper/app.py` | FastAPI app: `/health`, model load at startup |
| `stt-wrapper/repl.py` | Benchmark script: run transcription on WAV files |
| `scripts/env.sh` | Unix: activate venv + set `LD_LIBRARY_PATH` for CUDA libs |
| `scripts/env.bat` | Windows: activate venv + set `PATH` for CUDA libs |
| `requirements.txt` | Python deps (FastAPI, faster-whisper, etc.) |
| `.env-example` | Example env vars (Discord + STT); copy to `.env` |

---

## License

Private / no license specified.
