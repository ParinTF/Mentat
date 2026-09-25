from __future__ import annotations

import json
import shutil
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any

from .config import Settings

SENTINEL = "__KF_RESULT__"
ALLOWED_ERROR_CODES = {"execution_error", "timeout", "infrastructure_error", "missing_workload_metadata"}


class RunnerError(RuntimeError):
    def __init__(self, message: str, code: str = "execution_error") -> None:
        super().__init__(message)
        self.code = code


def _docker_base(settings: Settings) -> list[str]:
    if shutil.which("docker") is None:
        raise RunnerError("docker CLI not found on the worker host", "infrastructure_error")
    command = ["docker"]
    if settings.docker_host:
        command += ["-H", settings.docker_host]
    return command


def container_flags(settings: Settings, container_name: str | None = None) -> list[str]:
    command = ["run", "--rm", "--init"]
    if container_name:
        command += ["--name", container_name]
    command += [
        "--network", "none",
        "--read-only",
        "--user", "65534:65534",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--security-opt", "seccomp=default",
        "--cpus", "2",
        "--memory", "4g",
        "--pids-limit", "512",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
        "--tmpfs", "/output:rw,noexec,nosuid,nodev,size=16m,mode=1777",
        "--env", "PYTHONDONTWRITEBYTECODE=1",
        "--env", "PYTHONUNBUFFERED=1",
    ]
    return command


def _remove_container(settings: Settings, container_name: str) -> None:
    command = _docker_base(settings) + ["rm", "-f", container_name]
    try:
        subprocess.run(command, capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        pass


def _collect_stream(stream: Any, target: bytearray, limit: int, keep_tail: bool) -> None:
    if stream is None:
        return
    while True:
        chunk = stream.read(65_536)
        if not chunk:
            break
        if keep_tail:
            target.extend(chunk)
            if len(target) > limit:
                del target[:-limit]
        else:
            remaining = limit - len(target)
            if remaining > 0:
                target.extend(chunk[:remaining])
    stream.close()


def cleanup_orphan_containers(settings: Settings) -> None:
    command = _docker_base(settings) + ["ps", "-aq", "--filter", "label=kernelforge.runner=true"]
    try:
        completed = subprocess.run(command, capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return
    if completed.returncode != 0:
        return
    for container_id in completed.stdout.decode("utf-8", errors="replace").split():
        try:
            subprocess.run(_docker_base(settings) + ["rm", "-f", container_id], capture_output=True, timeout=10, check=False)
        except (OSError, subprocess.TimeoutExpired):
            continue


def run_agent(settings: Settings, role: str, module_path: str, image: str, input_prefix: str = "/input") -> dict[str, Any]:
    container_name = f"kf-run-{uuid.uuid4().hex}"
    command = _docker_base(settings) + container_flags(settings, container_name)
    input_component = input_prefix.removeprefix("/input/").strip("/")
    if input_component:
        _safe_component(input_component)
    container_prefix = "/input"
    container_module_path = module_path
    if input_component:
        source_prefix = f"/input/{input_component}"
        if not module_path.startswith(f"{source_prefix}/"):
            raise RunnerError("runner module path is outside its input workspace", "infrastructure_error")
        container_module_path = f"/input/{module_path[len(source_prefix) + 1:]}"
    volume_mount = f"type=volume,src={settings.runner_input_volume},dst=/input,readonly"
    if input_component:
        volume_mount += f",volume-subpath={input_component}"
    command += [
        "--label", "kernelforge.runner=true",
        "--mount", volume_mount,
        image,
    ]
    command += agent_command(role, container_module_path, settings.max_container_seconds, container_prefix)
    stdout_buffer = bytearray()
    stderr_buffer = bytearray()
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as error:
        raise RunnerError(f"could not start docker: {error}", "infrastructure_error") from error
    stdout_thread = threading.Thread(
        target=_collect_stream,
        args=(process.stdout, stdout_buffer, max(settings.max_log_bytes * 4, 262_144), True),
        daemon=True,
    )
    stderr_thread = threading.Thread(
        target=_collect_stream,
        args=(process.stderr, stderr_buffer, settings.max_log_bytes, False),
        daemon=True,
    )
    stdout_thread.start()
    stderr_thread.start()
    try:
        returncode = process.wait(timeout=settings.max_container_seconds + 2)
    except subprocess.TimeoutExpired as error:
        _remove_container(settings, container_name)
        process.kill()
        stdout_thread.join(timeout=2)
        stderr_thread.join(timeout=2)
        raise RunnerError("agent wall clock exceeded", "timeout") from error
    stdout_thread.join(timeout=2)
    stderr_thread.join(timeout=2)
    stdout = bytes(stdout_buffer).decode("utf-8", errors="replace")
    stderr = bytes(stderr_buffer).decode("utf-8", errors="replace")
    parsed = parse_agent_output(stdout)
    if parsed is None:
        code = "infrastructure_error" if returncode in {125, 126, 127} else "execution_error"
        raise RunnerError(f"agent produced no result line (exit={returncode}): {stderr[:400]}", code)
    if not parsed.get("ok"):
        error = parsed.get("error") if isinstance(parsed.get("error"), dict) else {}
        code = str(error.get("code", "execution_error"))
        if code not in ALLOWED_ERROR_CODES:
            code = "execution_error"
        raise RunnerError(str(error.get("message", "agent reported failure"))[:4096], code)
    measurement = parsed.get("measurement")
    if not isinstance(measurement, dict):
        raise RunnerError("agent result has no measurement object", "execution_error")
    public_lines = [line for line in stdout.splitlines() if not line.startswith(SENTINEL)]
    return {
        "measurement": measurement,
        "stdout": "\n".join(public_lines)[-4096:],
        "stderr": stderr[-4096:],
    }


def parse_agent_output(stdout: str) -> dict[str, Any] | None:
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


def _clear_directory(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for child in directory.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink(missing_ok=True)


def _safe_component(value: str) -> str:
    if not value or value in {".", ".."} or any(character not in "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-" for character in value):
        raise ValueError("submission workspace component is invalid")
    return value


def prepare_workspace(root: Path, submission_id: str, request: dict[str, Any], code: str, baseline_code: str | None = None) -> Path:
    workspace = root / _safe_component(submission_id)
    _clear_directory(workspace)
    (workspace / "request.json").write_text(json.dumps(request, separators=(",", ":")), encoding="utf-8")
    (workspace / "submission.py").write_text(code, encoding="utf-8")
    if baseline_code is not None:
        (workspace / "baseline.py").write_text(baseline_code, encoding="utf-8")
    return workspace


def cleanup_workspace(workspace: Path) -> None:
    if workspace.exists():
        shutil.rmtree(workspace, ignore_errors=True)


def simulate(settings: Settings, request: dict[str, Any]) -> dict[str, Any]:
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
    }


def agent_command(role: str, module_path: str, wall_clock: int, input_prefix: str = "/input") -> list[str]:
    return [
        "python", "/opt/kf/agent.py",
        "--request", f"{input_prefix}/request.json",
        "--role", role,
        "--module", module_path,
        "--output", "/output",
        "--wall-clock", str(wall_clock),
    ]
