"""Comparison of reduced benchmark outputs (allclose semantics).

Lives on the worker side, never inside the untrusted container: the agent only
reduces outputs, the worker decides correctness from those reductions.
`torch.allclose(user, baseline, atol=1e-3, rtol=1e-3)` is the reference
semantic; because reductions may come from a submission that never imported
torch, the comparison is implemented over plain numbers.
"""

from __future__ import annotations

from typing import Any, Mapping

from .config import DEFAULT_ATOL, DEFAULT_RTOL


class ComparisonError(ValueError):
    pass


def _require_mapping(reduced: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(reduced, Mapping):
        raise ComparisonError(f"{label} output must be a mapping")
    if reduced.get("kind") not in {"scalar", "tensor"}:
        raise ComparisonError(f"{label} output kind is not comparable ({reduced.get('kind')!r})")
    return reduced


def compare_reduced(
    user: Any,
    baseline: Any,
    atol: float = DEFAULT_ATOL,
    rtol: float = DEFAULT_RTOL,
) -> dict[str, Any]:
    """Return the contract's `correctness` object for two reduced outputs."""
    user_map = _require_mapping(user, "user")
    baseline_map = _require_mapping(baseline, "baseline")
    if user_map.get("kind") != baseline_map.get("kind"):
        return _failed("output kinds differ")
    if int(user_map.get("count", 0)) != int(baseline_map.get("count", 0)):
        return _failed("element counts differ")
    user_shape = user_map.get("shape")
    baseline_shape = baseline_map.get("shape")
    if user_shape is not None and user_shape != baseline_shape:
        return _failed("shapes differ")
    user_sum = float(user_map.get("sum", 0.0))
    baseline_sum = float(baseline_map.get("sum", 0.0))
    aggregate_error = abs(user_sum - baseline_sum)
    aggregate_limit = atol * int(user_map.get("count", 1)) + rtol * abs(baseline_sum)
    max_abs_error = 0.0
    for user_value, baseline_value in zip(user_map.get("sample", []), baseline_map.get("sample", [])):
        difference = abs(float(user_value) - float(baseline_value))
        max_abs_error = max(max_abs_error, difference)
        if difference > atol + rtol * abs(float(baseline_value)):
            return _failed("sampled values differ", max_abs_error)
    if aggregate_error > aggregate_limit:
        return _failed("aggregate sums differ", max_abs_error)
    return {
        "checked": True,
        "passed": True,
        "max_abs_error": max_abs_error,
        "atol": atol,
        "rtol": rtol,
    }


def _failed(reason: str, max_abs_error: float | None = None) -> dict[str, Any]:
    return {
        "checked": True,
        "passed": False,
        "max_abs_error": max_abs_error,
        "atol": DEFAULT_ATOL,
        "rtol": DEFAULT_RTOL,
        "reason": reason[:120],
    }
