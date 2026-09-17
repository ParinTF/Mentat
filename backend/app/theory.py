"""Server-side theoretical FLOP/byte counts for challenges.

A challenge can never be passed with invented numbers: when
`workload_mode == "challenge_theory"` the counts come from here, and any
metadata returned by the kernel is reported as ignored.
"""

from __future__ import annotations

from typing import Any, Callable, Mapping


class UnknownTheory(KeyError):
    pass


def _vector_add(params: Mapping[str, Any]) -> tuple[int, int]:
    n = int(params["n"])
    itemsize = int(params.get("itemsize", 4))
    return n, 3 * n * itemsize


def _matmul(params: Mapping[str, Any]) -> tuple[int, int]:
    n = int(params["n"])
    itemsize = int(params.get("itemsize", 4))
    return 2 * n * n * n, 3 * n * n * itemsize


def _reduction(params: Mapping[str, Any]) -> tuple[int, int]:
    n = int(params["n"])
    itemsize = int(params.get("itemsize", 4))
    return n - 1, n * itemsize


def _softmax_rows(params: Mapping[str, Any]) -> tuple[int, int]:
    n = int(params["n"])
    itemsize = int(params.get("itemsize", 4))
    return 5 * n, 2 * n * itemsize


THEORIES: dict[str, Callable[[Mapping[str, Any]], tuple[int, int]]] = {
    "vector_add": _vector_add,
    "matmul": _matmul,
    "reduction": _reduction,
    "softmax_rows": _softmax_rows,
}


def theoretical_workload(theory: str, params: Mapping[str, Any]) -> dict[str, int]:
    """Return {"flops": ..., "bytes_transferred": ...} for a named theory."""
    if theory not in THEORIES:
        raise UnknownTheory(theory)
    flops, bytes_transferred = THEORIES[theory](params)
    if flops < 0 or bytes_transferred < 0:
        raise ValueError("theory produced a negative count")
    return {"flops": flops, "bytes_transferred": bytes_transferred}
