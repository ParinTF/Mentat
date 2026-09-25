"""Metric formulas. This module is the Python twin of `demo/metrics.mjs` and
`web/lib/roofline.ts`; `shared/metrics.vectors.json` is the cross-language
fixture that keeps all three honest."""

from __future__ import annotations

import math
from typing import Any, Iterable, Mapping

ATOL = 1e-3
RTOL = 1e-3


def median(values: Iterable[float]) -> float:
    samples = sorted(values)
    if not samples:
        raise ValueError("median requires at least one sample")
    middle = len(samples) // 2
    if len(samples) % 2 == 1:
        return float(samples[middle])
    return (samples[middle - 1] + samples[middle]) / 2.0


def arithmetic_intensity(flops: int, bytes_transferred: int) -> float | None:
    """AI = Total FLOPs / Total Bytes (FLOP/byte); None when nothing moves."""
    if bytes_transferred == 0:
        return None
    return flops / bytes_transferred


def ridge_point_ai(hardware: Mapping[str, Any]) -> float:
    peak_compute = float(hardware["peak_compute_tflops"])
    peak_bandwidth = float(hardware["peak_bandwidth_gbps"])
    return peak_compute * 1000.0 / peak_bandwidth


def memory_throughput_gbps(bytes_transferred: int, latency_ms: float) -> float:
    return bytes_transferred / (latency_ms / 1000.0) / 1e9


def compute_tflops(flops: int, latency_ms: float) -> float:
    return flops / (latency_ms / 1000.0) / 1e12


def attainable_tflops(hardware: Mapping[str, Any], ai: float | None) -> float | None:
    """Roofline boundary: min(Peak Compute, Peak Bandwidth * AI)."""
    if ai is None:
        return None
    peak_compute = float(hardware["peak_compute_tflops"])
    peak_bandwidth = float(hardware["peak_bandwidth_gbps"])
    return min(peak_compute, peak_bandwidth * ai / 1000.0)


def bottleneck_for(hardware: Mapping[str, Any], ai: float | None) -> str | None:
    """Memory bound below the ridge point, compute bound at or above it."""
    if ai is None:
        return None
    return "memory" if ai < ridge_point_ai(hardware) else "compute"


def workload_source_for(workload_mode: str) -> str:
    if workload_mode == "protocol":
        return "protocol"
    if workload_mode == "challenge_theory":
        return "challenge_theory"
    return "user_estimate"


def build_result(
    request: Mapping[str, Any],
    samples_ms: list[float],
    timing: str = "simulation",
    workload: Mapping[str, Any] | None = None,
    short_id: str | None = None,
) -> dict[str, Any]:
    if not samples_ms or any(not math.isfinite(value) or value <= 0 for value in samples_ms):
        raise ValueError("samples must be finite and positive")
    if timing not in {"measured", "simulation"}:
        raise ValueError("timing must be measured or simulation")
    latency = median(samples_ms)
    effective_workload = workload or request["workload"]
    flops = int(effective_workload["flops"])
    bytes_transferred = int(effective_workload["bytes_transferred"])
    hardware = request["hardware"]
    ai = arithmetic_intensity(flops, bytes_transferred)
    workload_source = workload_source_for(request["workload_mode"])
    result: dict[str, Any] = {
        "short_id": short_id,
        "latency_ms": latency,
        "memory_throughput_gbps": memory_throughput_gbps(bytes_transferred, latency),
        "compute_tflops": compute_tflops(flops, latency),
        "arithmetic_intensity": ai,
        "attainable_tflops": attainable_tflops(hardware, ai),
        "bottleneck": bottleneck_for(hardware, ai),
        "workload_source": workload_source,
        "ignored_metadata": request["workload_mode"] == "challenge_theory",
        "pcie_transfer_ms": None,
        "passed": None,
        "correctness": {
            "checked": False,
            "passed": None,
            "max_abs_error": None,
            "atol": ATOL,
            "rtol": RTOL,
        },
        "baseline": None,
        "provenance": {
            "timing": timing,
            "workload": workload_source,
            "movement": "simulation" if timing == "simulation" else "derived",
        },
        "hardware": hardware,
        "samples_ms": list(samples_ms),
    }
    for key, value in result.items():
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError(f"non-finite metric {key} would break the JSON contract")
    return result
