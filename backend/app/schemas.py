from __future__ import annotations

import math
import re
from typing import Annotated, Any, Literal, Mapping

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StrictInt, StrictStr, ValidationError, field_validator, model_validator

from .config import MAX_CODE_BYTES, MAX_PEAK, MAX_REPETITIONS, MAX_SAFE_INTEGER, MAX_WARMUP

CHALLENGE_SLUG = re.compile(r"^[a-z0-9-]{3,64}$")
LANGUAGES = ("python", "pytorch", "triton")
DEVICES = ("cpu", "cuda")
WORKLOAD_MODES = ("protocol", "declared", "challenge_theory")

SubmissionStatus = Literal["queued", "compiling", "running", "completed", "failed", "timed_out"]
Language = Literal["python", "pytorch", "triton"]
Device = Literal["cpu", "cuda"]
WorkloadMode = Literal["protocol", "declared", "challenge_theory"]


def _finite_peak(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("must be a number")
    number = float(value)
    if not math.isfinite(number) or not 0 < number <= MAX_PEAK:
        raise ValueError(f"must be finite, >0 and <= {MAX_PEAK}")
    return number


FinitePeak = Annotated[float, BeforeValidator(_finite_peak)]


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class HardwareSpec(ContractModel):
    name: StrictStr = Field(min_length=1, max_length=120)
    peak_compute_tflops: FinitePeak
    peak_bandwidth_gbps: FinitePeak

    @field_validator("name")
    @classmethod
    def name_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value


class WorkloadEstimate(ContractModel):
    flops: StrictInt = Field(ge=0, le=MAX_SAFE_INTEGER)
    bytes_transferred: StrictInt = Field(ge=0, le=MAX_SAFE_INTEGER)


class SubmissionRequest(ContractModel):
    code: StrictStr
    language: Language
    device: Device
    warmup: StrictInt = Field(default=3, ge=0, le=MAX_WARMUP)
    repetitions: StrictInt = Field(default=10, ge=1, le=MAX_REPETITIONS)
    workload_mode: WorkloadMode = "protocol"
    workload: WorkloadEstimate
    hardware: HardwareSpec
    challenge_slug: StrictStr | None = Field(default=None, pattern=CHALLENGE_SLUG.pattern)

    @field_validator("code")
    @classmethod
    def code_must_fit_utf8_limit(cls, value: str) -> str:
        size = len(value.encode("utf-8"))
        if not 1 <= size <= MAX_CODE_BYTES:
            raise ValueError(f"must be 1..{MAX_CODE_BYTES} UTF-8 bytes")
        return value

    @model_validator(mode="after")
    def validate_execution_combination(self) -> "SubmissionRequest":
        if self.language == "triton" and self.device != "cuda":
            raise ValueError("triton requires device=cuda")
        if self.workload_mode == "challenge_theory" and self.challenge_slug is None:
            raise ValueError("challenge_theory requires challenge_slug")
        return self


class Correctness(ContractModel):
    checked: bool = False
    passed: bool | None = None
    max_abs_error: float | None = None
    atol: float = 1e-3
    rtol: float = 1e-3


class BaselineComparison(ContractModel):
    name: str
    latency_ms: float
    speedup: float


class Provenance(ContractModel):
    timing: Literal["measured", "simulation"]
    workload: Literal["protocol", "challenge_theory", "user_estimate"]
    movement: Literal["derived", "illustrative", "simulation"]


class BenchmarkResult(ContractModel):
    short_id: str | None = None
    latency_ms: float
    memory_throughput_gbps: float
    compute_tflops: float
    arithmetic_intensity: float | None
    attainable_tflops: float | None
    bottleneck: Literal["memory", "compute"] | None
    workload_source: Literal["protocol", "challenge_theory", "user_estimate"]
    ignored_metadata: bool
    pcie_transfer_ms: float | None = None
    passed: bool | None = None
    correctness: Correctness
    baseline: BaselineComparison | None = None
    provenance: Provenance
    hardware: HardwareSpec
    samples_ms: list[float]


class SubmissionAccepted(ContractModel):
    submission_id: str
    status: Literal["queued"]
    websocket_url: str
    mode: Literal["simulation", "sandbox"]


class SubmissionSnapshotResponse(ContractModel):
    submission_id: str
    status: SubmissionStatus
    mode: Literal["simulation", "sandbox"]
    result: BenchmarkResult | None
    error: str | None


class ShareSnapshot(ContractModel):
    short_id: str
    submission_id: str
    challenge_slug: str | None
    language: Language
    device: Device
    created_at: str
    result: BenchmarkResult | None


def validate_request(value: Any) -> str | None:
    try:
        SubmissionRequest.model_validate(value)
    except ValidationError as error:
        return str(error)
    return None


def normalise_request(payload: Mapping[str, Any] | SubmissionRequest) -> dict[str, Any]:
    value = payload.model_dump() if isinstance(payload, SubmissionRequest) else dict(payload)
    return {
        "code": value["code"],
        "language": value["language"],
        "device": value["device"],
        "warmup": int(value.get("warmup", 3)),
        "repetitions": int(value.get("repetitions", 10)),
        "workload_mode": value.get("workload_mode", "protocol"),
        "workload": {
            "flops": int(value["workload"]["flops"]),
            "bytes_transferred": int(value["workload"]["bytes_transferred"]),
        },
        "hardware": {
            "name": value["hardware"]["name"],
            "peak_compute_tflops": float(value["hardware"]["peak_compute_tflops"]),
            "peak_bandwidth_gbps": float(value["hardware"]["peak_bandwidth_gbps"]),
        },
        "challenge_slug": value.get("challenge_slug"),
    }
