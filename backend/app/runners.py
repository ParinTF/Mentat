"""Docker orchestration for the worker host.

The worker is the only component allowed to talk to dockerd, and it does so
through the Docker CLI with a hard-coded safe flag set. The Docker socket is
NEVER mounted into a runner container, and submissions never touch host Python.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .config import Settings

SENTINEL = "__KF_RESULT__"


class RunnerError(RuntimeError):
    pass


def _docker_base(settings: Settings) -> list[str]:
    if shutil.which("docker") is None:
        raise RunnerError("docker CLI not found on the worker host")
    command = ["docker"]
    if settings.docker_host:
        command += ["-H", settings.docker_host]
    return command


def container_flags(settings: Settings, image: str) -> list[str]:
    """The exact isolation set from contracts/API.md. No GPU flags here: a
    CUDA host adds --gpus plus the NVIDIA runtime capabilities explicitly."""
    return [
        "run", "--rm",
        "--network", "none",
        "--read-only",
        "--user", "65534:65534",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--cpus", "2",
        "--memory", "4g",
        "--pids-limit", "512",
        "--tmpfs", "/tmp:rw,size=64m",
def run_agent(settings: Settings, workspace: Path, role: str, module_path: str, image: str) -> dict[str, Any]:
    """Run the agent for one role and return its parsed measurement.

    Output is truncated to settings.max_log_bytes BEFORE parsing so a noisy or
    hostile submission cannot exhaust worker memory. stdout is untrusted: the
    parsed payload is validated by the caller and used informationally.
    """
    command = _docker_base(settings) + container_flags(settings, image)
    command += [
        "-v", f"{workspace / 'request.json'}:/input/request.json:ro",
        "-v", f"{workspace / 'submission.py'}:/input/submission.py:ro",
    ]
    if role == "baseline":
        command += ["-v", f"{workspace / 'baseline.py'}:/challenges/baseline.py:ro"]
    command += agent_command(role, module_path, settings.max_container_seconds)
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            timeout=settings.max_container_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise RunnerError("timeout") from error
    stdout = (completed.stdout or b"")[: settings.max_log_bytes].decode("utf-8", errors="replace")
    stderr = (completed.stderr or b"")[: settings.max_log_bytes].decode("utf-8", errors="replace")
    parsed = parse_agent_output(stdout)
    if parsed is None:
        raise RunnerError(f"agent produced no result line (exit={completed.returncode}): {stderr[:400]}")
    if not parsed.get("ok"):
        error = parsed.get("error") or {}
        raise RunnerError(str(error.get("message", "agent reported failure")))
    return parsed


def parse_agent_output(stdout: str) -> dict[str, Any] | None:
    """Extract the last `__KF_RESULT__` line and decode its JSON payload."""
    for line in reversed(stdout.splitlines()):
        if not line.startswith(SENTINEL):
            continue
        payload = line[len(SENTINEL):].strip()
        try:
            decoded = json.loads(payload)
        except json.JSONDecodeError:
            return None
        return decoded if isinstance(decoded, dict) else None
    return None


def cleanup_workspace(workspace: Path) -> None:
    shutil.rmtree(workspace, ignore_errors=True)


def simulate(settings: Settings, request: dict[str, Any]) -> dict[str, Any]:
    """Local, honest fallback when no Docker host exists.

    This NEVER runs the submitted code: the latency comes from the roofline
    model (max of the two roofs divided by an assumed efficiency), the same
    provenance labelling as the browser simulation.
    """
    flops = int(request["workload"]["flops"])
    bytes_transferred = int(request["workload"]["bytes_transferred"])
    peak_compute = float(request["hardware"]["peak_compute_tflops"])
    peak_bandwidth = float(request["hardware"]["peak_bandwidth_gbps"])
    efficiency = 0.62 if request["device"] == "cuda" else 0.38
    compute_seconds = flops / (peak_compute * 1e12)
    memory_seconds = bytes_transferred / (peak_bandwidth * 1e9)
    latency_ms = max(0.05, max(compute_seconds, memory_seconds) / efficiency * 1000.0)
    repetitions = int(request["repetitions"])
    return {
        "ok": True,
        "measurement": {
            "role": "submission",
            "samples_ms": [latency_ms] * repetitions,
            "flops": flops,
            "bytes": bytes_transferred,
            "itemsize": 4,
            "timing_source": "simulated",
            "device": request["device"],
            "metadata_ignored": request["workload_mode"] == "challenge_theory",
            "language": request["language"],
            "reduced_output": {"kind": "scalar", "value": 0.0, "count": 1, "sum": 0.0},
        },
    }
        "--tmpfs", "/output:rw,size=16m",
        image,
    ]


def prepare_workspace(request: dict[str, Any], code: str, baseline_code: str | None) -> Path:
    """Write request.json / submission.py / baseline.py into a temp dir that is
    mounted read-only; the caller removes it in `finally`."""
    workspace = Path(tempfile.mkdtemp(prefix="kf-run-"))
    (workspace / "request.json").write_text(json.dumps(request), encoding="utf-8")
    (workspace / "submission.py").write_text(code, encoding="utf-8")
    if baseline_code is not None:
        (workspace / "baseline.py").write_text(baseline_code, encoding="utf-8")
    return workspace


def agent_command(role: str, module_path: str, wall_clock: int) -> list[str]:
    return [
        "python", "/opt/kf/agent.py",
        "--request", "/input/request.json",
        "--role", role,
        "--module", module_path,
        "--output", "/output",
        "--wall-clock", str(wall_clock),
    ]