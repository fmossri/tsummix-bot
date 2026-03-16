"""
Set LD_LIBRARY_PATH so CTranslate2/faster-whisper can load venv's nvidia cublas/cudnn
when not already findable. Import this module first (before faster_whisper). No-op on Windows.
Uses the same logic as the linker: only add a dir if the library file is not in existing path.
"""
import os
import sys

def _ensure_cuda_lib_path():
    if os.name == "nt":
        return
    existing = os.environ.get("LD_LIBRARY_PATH", "")
    existing_dirs = [p.strip() for p in existing.split(":") if p.strip()]
    cublas_lib = "libcublas.so.12"
    cudnn_lib = "libcudnn.so.9"
    found_cublas = any(os.path.isfile(os.path.join(d, cublas_lib)) for d in existing_dirs)
    found_cudnn = any(os.path.isfile(os.path.join(d, cudnn_lib)) for d in existing_dirs)
    if found_cublas and found_cudnn:
        return

    site = os.path.join(
        sys.prefix, "lib", f"python{sys.version_info.major}.{sys.version_info.minor}", "site-packages"
    )
    cublas_dir = os.path.join(site, "nvidia", "cublas", "lib")
    cudnn_dir = os.path.join(site, "nvidia", "cudnn", "lib")
    cublas_lib_path = os.path.join(cublas_dir, cublas_lib)
    cudnn_lib_path = os.path.join(cudnn_dir, cudnn_lib)

    to_prepend = []
    if not found_cublas:
        if not os.path.isfile(cublas_lib_path):
            import warnings
            warnings.warn(
                f"CUDA lib {cublas_lib} not findable in LD_LIBRARY_PATH and not in venv at {cublas_lib_path}. "
                "Install nvidia-cublas-cu12 in the venv or set LD_LIBRARY_PATH. GPU/CUDA may fail; use STT_DEVICE=cpu to avoid.",
                UserWarning,
                stacklevel=0,
            )
        else:
            to_prepend.append(cublas_dir)
    if not found_cudnn:
        if not os.path.isfile(cudnn_lib_path):
            import warnings
            warnings.warn(
                f"CUDA lib {cudnn_lib} not findable in LD_LIBRARY_PATH and not in venv at {cudnn_lib_path}. "
                "Install nvidia-cudnn-cu12 in the venv or set LD_LIBRARY_PATH. GPU/CUDA may fail; use STT_DEVICE=cpu to avoid.",
                UserWarning,
                stacklevel=0,
            )
        else:
            to_prepend.append(cudnn_dir)
    if not to_prepend:
        return
    new_path = os.pathsep.join(to_prepend + existing_dirs)
    os.environ["LD_LIBRARY_PATH"] = new_path


_ensure_cuda_lib_path()
