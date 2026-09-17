"""Host capability probing. Everything reported here is probed, never guessed:
the API refuses CUDA/Triton work when the host cannot execute it."""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
from functools import lru_cache
from typing import Any

from .config import MAX_CODE_BYTES, MAX_REPETITIONS, Settings, settings


def _torch_cuda_available() -> bool:
    try:
        import torch  # type: ignore import-not-found
    except Exception:  # torch is absent or broken: report honestly
        return False
    try:
        return bool(torch.cuda.is_available())
    except Exception:
        return False


def _triton_available() -> bool:
    try:
        return importlib.util.find_spec("triton") is not None
    except Exception:
        return False


def _docker_reachable(docker_host: str | None) -> bool:
    if shutil.which("docker") is None:
        return False
    command = ["docker", "info", "--format", "{{.ServerVersion}}"]
    if docker_host:
        command = ["docker", "-H", docker_host, "info", "--format", "{{.ServerVersion}}"]
    try:
        completed = subprocess.run(command, capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return completed.returncode == 0


@lru_cache(maxsize=1)
def probe(mode: str, docker_host: str | None, force_docker_probe: bool = True) -> dict[str, Any]:
    """Probe the execution host once per process and cache the result."""
    cuda = mode == "sandbox" and _torch_cuda_available() and _docker_reachable(docker_host)
    return {
        "mode": mode,
        "devices": {"cpu": mode == "sandbox" and _docker_reachable(docker_host), "cuda": cuda},
        "languages": {
            "python": mode == "sandbox",
            "pytorch": mode == "sandbox",
            "triton": mode == "sandbox" and cuda,
        },
        "limits": {
            "max_code_bytes": MAX_CODE_BYTES,
            "max_repetitions": MAX_REPETITIONS,
            "wall_time_s": Settings.from_env().max_container_seconds,
        },
        "host": {
            "docker_reachable": _docker_reachable(docker_host),
            "torch_installed": importlib.util.find_spec("torch") is not None,
            "triton_installed": _triton_available(),
        },
    }


def capabilities() -> dict[str, Any]:
    current: Settings = settings()
    return probe(current.mode, current.docker_host)


def supports(device: str, language: str) -> tuple[bool, str | None]:
    """(allowed, reason) for a requested device/language pair."""
    caps = capabilities()
    if not caps["devices"].get(device, False):
        return False, "unsupported_device"
    if not caps["languages"].get(language, False):
        return False, "unsupported_language"
    return True, None
