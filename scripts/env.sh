#!/usr/bin/env bash
# Unix-like (Linux, macOS, WSL): activate venv and set LD_LIBRARY_PATH for
# nvidia-cublas-cu12 / nvidia-cudnn-cu12 so CTranslate2/faster-whisper can load them.
# Usage: source scripts/env.sh   or   . scripts/env.sh   (from any directory)
# On Windows (cmd/PowerShell) use scripts\env.bat or set PATH to the venv nvidia lib dirs.
_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
. "${_REPO_ROOT}/.venv/bin/activate"

CUBLAS_LIB="${_REPO_ROOT}/.venv/lib/python3.12/site-packages/nvidia/cublas/lib"
CUDNN_LIB="${_REPO_ROOT}/.venv/lib/python3.12/site-packages/nvidia/cudnn/lib"
export LD_LIBRARY_PATH="${CUBLAS_LIB}:${CUDNN_LIB}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"

echo "venv + CUDA libs ready"