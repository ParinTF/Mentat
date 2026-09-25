from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
from typing import Any

from .config import MAX_CODE_BYTES, MAX_REPETITIONS, Settings, settings
from .runners import container_flags

PROBE_SCRIPT = "import importlib.util,json,os,platform;print(json.dumps({'os':platform.system(),'arch':platform.machine(),'cpu_cores':os.cpu_count() or 1,'memory_gb':round(os.sysconf('SC_PAGE_SIZE')*os.sysconf('SC_PHYS_PAGES')/1073741824,2),'pytorch':importlib.util.find_spec('torch') is not None}))"


def _docker_base(settings: Settings) -> list[str]:
    command = ["docker"]
    if settings.docker_host:
        command += ["-H", settings.docker_host]
    return command


def _docker_reachable(settings: Settings) -> bool:
    if shutil.which("docker") is None:
        return False
    command = _docker_base(settings) + ["info", "--format", "{{.ServerVersion}}"]
    try:
        completed = subprocess.run(command, capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return completed.returncode == 0


def _host() -> dict[str, Any]:
    memory_gb = 0.0
    if hasattr(os, "sysconf"):
        try:
            memory_gb = round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1073741824, 2)
        except (OSError, ValueError):
            memory_gb = 0.0
    return {
        "os": platform.system(),
        "arch": platform.machine(),
        "cpu_cores": os.cpu_count() or 1,
        "memory_gb": memory_gb,
    }


def unavailable_capabilities(current: Settings) -> dict[str, Any]:
    simulation = current.mode == "simulation"
    return {
        "mode": current.mode,
        "devices": {"cpu": simulation, "cuda": False},
        "languages": {"python": simulation, "pytorch": simulation, "triton": False},
        "limits": {
            "max_code_bytes": MAX_CODE_BYTES,
            "max_repetitions": MAX_REPETITIONS,
            "wall_time_s": current.max_container_seconds,
        },
        "host": _host(),
    }


def probe_runner_image(mode: str, docker_host: str | None, image: str, max_seconds: int) -> dict[str, Any]:
    current = Settings(
        database_url="",
        redis_url="",
        run_token=None,
        mode=mode,
        concurrency=1,
        max_container_seconds=max_seconds,
        max_log_bytes=65_536,
        runner_image_cpu=image,
        runner_image_cuda="",
        docker_host=docker_host,
        runner_input_root="",
        runner_input_volume="",
        cors_origins=(),
    )
    unavailable = unavailable_capabilities(current)
    if mode != "sandbox" or not _docker_reachable(current):
        return unavailable
    command = _docker_base(current) + container_flags(current)
    command += [image, "python", "-c", PROBE_SCRIPT]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            timeout=max_seconds + 5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return unavailable
    if completed.returncode != 0:
        return unavailable
    try:
        payload = json.loads((completed.stdout or b"")[-4096:].decode("utf-8", errors="replace").strip())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return unavailable
    pytorch = bool(payload.get("pytorch"))
    return {
        "mode": "sandbox",
        "devices": {"cpu": True, "cuda": False},
        "languages": {"python": True, "pytorch": pytorch, "triton": False},
        "limits": {
            "max_code_bytes": MAX_CODE_BYTES,
            "max_repetitions": MAX_REPETITIONS,
            "wall_time_s": max_seconds,
        },
        "host": {
            "os": str(payload.get("os", "")),
            "arch": str(payload.get("arch", "")),
            "cpu_cores": int(payload.get("cpu_cores", 1)),
            "memory_gb": float(payload.get("memory_gb", 0)),
        },
    }


def supports(capabilities: dict[str, Any], device: str, language: str) -> tuple[bool, str | None]:
    if not capabilities.get("devices", {}).get(device, False):
        return False, "unsupported_device"
    if not capabilities.get("languages", {}).get(language, False):
        return False, "unsupported_language"
    return True, None


def current_capabilities() -> dict[str, Any]:
    current = settings()
    return probe_runner_image(current.mode, current.docker_host, current.runner_image_cpu, current.max_container_seconds)
