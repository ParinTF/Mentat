"""Request/response schemas (Pydantic v2) mirroring contracts/API.md v2.

Validation is pure: it never touches Postgres, Redis or Docker, and it returns
plain error strings that the API layer turns into `{detail: ...}` bodies.
"""

from __future__ import annotations

import re
from typing import Any, Literal, Mapping

from pydantic import BaseModel

from .config import MAX_CODE_BYTES, MAX_PEAK, MAX_REPETITIONS, MAX_WARMUP

CHALLENGE_SLUG = re.compile(r"^[a-z0-9-]{3,64}$")
LANGUAGES = ("python", "pytorch", "triton")
DEVICES = ("cpu", "cuda")
WORKLOAD_MODES = ("protocol", "declared", "challenge_theory")

SubmissionStatus = Literal["queued", "compiling", "running", "completed", "failed", "timed_out"]


class HardwareSpec(BaseModel):
    name: str
    peak_compute_tflops: float
    peak_bandwidth_gbps: float


class WorkloadEstimate(BaseModel):
    flops: int
    bytes_transferred: int


class SubmissionRequest(BaseModel):
    code: str
    language: str
    device: str
    warmup: int
    repetitions: int
    workload_mode: str
    workload: WorkloadEstimate
    hardware: HardwareSpec
    challenge_slug: str | None = None


class Correctness(BaseModel):
    checked: bool = False
    passed: bool | None = None
    max_abs_error: float | None = None
    atol: float = 1e-3
    rtol: float = 1e-3


class BaselineComparison(BaseModel):
    name: str
    latency_ms: float
    speedup: float


class Provenance(BaseModel):
    timing: str
    workload: str
    movement: str


class BenchmarkResult(BaseModel):
    short_id: str | None = None
    latency_ms: float
    memory_throughput_gbps: float
    compute_tflops: float
    arithmetic_intensity: float | None
    attainable_tflops: float | None
    bottleneck: str | None
    workload_source: str
    ignored_metadata: bool
    pcie_transfer_ms: float | None = None
    passed: bool | None = None
    correctness: Correctness
    baseline: BaselineComparison | None = None
    provenance: Provenance
    hardware: HardwareSpec
    samples_ms: list[float]


def _plain_object(value: Any) -> bool:
    return isinstance(value, dict)


def validate_request(value: Any) -> str | None:
    """Return None when the payload satisfies the contract, else the reason."""
    if not _plain_object(value):
        return "Body must be a JSON object"
    allowed = {
        "code", "language", "device", "warmup", "repetitions",
        "workload_mode", "workload", "hardware", "challenge_slug",
    }
    if not set(value.keys()).issubset(allowed):
        return "Unknown field in request"
    code = value.get("code")
    if not isinstance(code, str):
        return "code must be a string"
    code_bytes = len(code.encode("utf-8"))
    if not 1 <= code_bytes <= MAX_CODE_BYTES:
        return f"code must be 1..{MAX_CODE_BYTES} UTF-8 bytes (got {code_bytes})"
    if value.get("language") not in LANGUAGES:
        return "language must be python, pytorch or triton"
    if value.get("device") not in DEVICES:
        return "device must be cpu or cuda"
    if value["language"] == "triton" and value["device"] != "cuda":
        return "triton requires device=cuda"
    warmup = value.get("warmup")
    if isinstance(warmup, bool) or not isinstance(warmup, int) or not 0 <= warmup <= MAX_WARMUP:
        return f"warmup must be an integer in 0..{MAX_WARMUP}"
    repetitions = value.get("repetitions")
    if isinstance(repetitions, bool) or not isinstance(repetitions, int) or not 1 <= repetitions <= MAX_REPETITIONS:
        return f"repetitions must be an integer in 1..{MAX_REPETITIONS}"
    if value.get("workload_mode") not in WORKLOAD_MODES:
        return "workload_mode must be protocol, declared or challenge_theory"
    workload = value.get("workload")
    if not _plain_object(workload) or set(workload.keys()) != {"flops", "bytes_transferred"}:
        return "workload must contain exactly flops and bytes_transferred"
    for key in ("flops", "bytes_transferred"):
        count = workload[key]
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            return f"workload.{key} must be a non-negative integer"
    hardware = value.get("hardware")
    if not _plain_object(hardware) or set(hardware.keys()) != {"name", "peak_compute_tflops", "peak_bandwidth_gbps"}:
        return "hardware must contain exactly name, peak_compute_tflops, peak_bandwidth_gbps"
    name = hardware.get("name")
    if not isinstance(name, str) or not name.strip() or len(name) > 120:
        return "hardware.name must be 1..120 characters"
    for key in ("peak_compute_tflops", "peak_bandwidth_gbps"):
        peak = hardware.get(key)
        if isinstance(peak, bool) or not isinstance(peak, (int, float)) or not 0 < float(peak) <= MAX_PEAK:
            return f"hardware.{key} must be a finite number >0 and <= {MAX_PEAK}"
    slug = value.get("challenge_slug")
    if slug is not None and (not isinstance(slug, str) or not CHALLENGE_SLUG.match(slug)):
        return "challenge_slug must be null or match ^[a-z0-9-]{3,64}$"
    if value["workload_mode"] == "challenge_theory" and slug is None:
        return "workload_mode=challenge_theory requires challenge_slug"
    return None


def normalise_request(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Return a plain dict with the exact request shape the runner expects."""
    return {
        "code": payload["code"],
        "language": payload["language"],
        "device": payload["device"],
        "warmup": int(payload["warmup"]),
        "repetitions": int(payload["repetitions"]),
        "workload_mode": payload["workload_mode"],
        "workload": {
            "flops": int(payload["workload"]["flops"]),
            "bytes_transferred": int(payload["workload"]["bytes_transferred"]),
        },
        "hardware": {
            "name": payload["hardware"]["name"],
            "peak_compute_tflops": float(payload["hardware"]["peak_compute_tflops"]),
            "peak_bandwidth_gbps": float(payload["hardware"]["peak_bandwidth_gbps"]),
        },
        "challenge_slug": payload.get("challenge_slug"),
    }
