"""KernelForge in-container profiling agent.

Trusted harness, baked into the runner image. It imports the submitted module
in the SAME untrusted process (isolation comes from the container: no network,
read-only rootfs, dropped capabilities, CPU/memory/PID limits), runs setup once,
discards warmups, times each repetition, reduces the returned output and prints
exactly one result line:

    __KF_RESULT__ {"ok": true, ...}

Everything else on stdout/stderr is treated as untrusted log text by the worker.
A malicious submission CAN forge the sentinel line; the worker validates the
shape and size of the payload but treats it as informational, never as
attestation of what actually ran.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import signal
import sys
import time
from pathlib import Path
from typing import Any, Callable

SENTINEL = "__KF_RESULT__"
DEFAULT_ITEMSIZE = 4
SAMPLE_LIMIT = 64


class AgentError(RuntimeError):
    """Raised for protocol problems the worker must see as a failure."""


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(f"{SENTINEL} {json.dumps(payload, separators=(',', ':'))}\n")
    sys.stdout.flush()


def fail(code: str, message: str) -> int:
    emit({"ok": False, "error": {"code": code, "message": message[:4096]}})
    return 3


def load_module(path: str, name: str):
    location = Path(path)
    if not location.is_file():
        raise AgentError(f"module not found: {path}")
    spec = importlib.util.spec_from_file_location(name, location)
    if spec is None or spec.loader is None:
        raise AgentError(f"cannot load module from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def extract_metadata(returned: Any, request: dict[str, Any]) -> tuple[int, int, bool]:
    """FLOPs and bytes for this run.

    protocol: taken from the mapping benchmark() returned.
    declared: taken from request.workload (reported as user_estimate).
    challenge_theory: computed by the worker; metadata returned here is ignored.
    Returns (flops, bytes, metadata_ignored).
    """
    mode = request.get("workload_mode", "declared")
    if mode == "declared":
        workload = request["workload"]
        return int(workload["flops"]), int(workload["bytes_transferred"]), False
    if mode == "challenge_theory":
        return 0, 0, True
    if not isinstance(returned, dict):
        raise AgentError("protocol mode requires benchmark() to return a mapping")
    for key in ("flops", "bytes"):
        if key not in returned:
            raise AgentError(f"protocol mode requires benchmark() to return {key!r}")
    flops, byte_count = returned["flops"], returned["bytes"]
    for value in (flops, byte_count):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise AgentError("protocol metadata flops/bytes must be non-negative integers")
    return int(flops), int(byte_count), False


def timed_repetitions(benchmark: Callable[[], Any], warmup: int, repetitions: int, use_cuda: bool) -> list[float]:
    """Warmups are discarded; each repetition is one synchronized sample."""
    for _ in range(warmup):
        benchmark()
    samples: list[float] = []
    if use_cuda:
        import torch

        for _ in range(repetitions):
            torch.cuda.synchronize()
            start = torch.cuda.Event(enable_timing=True)
            end = torch.cuda.Event(enable_timing=True)
            start.record()
            benchmark()
            end.record()
            torch.cuda.synchronize()
            samples.append(float(start.elapsed_time(end)))
        return samples
    for _ in range(repetitions):
        started = time.perf_counter()
        benchmark()
        samples.append((time.perf_counter() - started) * 1000.0)
    return samples


def run_role(request: dict[str, Any], role: str, module_path: str) -> dict[str, Any]:
    """Import one module, run setup/warmup/timed repetitions, return JSON."""
    module = load_module(module_path, f"kernelforge_{role}")
    setup = getattr(module, "setup", None)
    if callable(setup):
        setup()
    benchmark = getattr(module, "benchmark", None)
    if not callable(benchmark):
        raise AgentError("module must define benchmark()")
    device = request.get("device", "cpu")
    use_cuda = False
    if device == "cuda":
        try:
            import torch

            use_cuda = bool(torch.cuda.is_available())
        except Exception:
            use_cuda = False
    warmup = int(request.get("warmup", 3))
    repetitions = int(request.get("repetitions", 10))
    returned = benchmark()
    flops, byte_count, metadata_ignored = extract_metadata(returned, request)
    samples = timed_repetitions(benchmark, warmup, repetitions, use_cuda)
    return {
        "role": role,
        "samples_ms": samples,
        "reduced_output": reduce_output(returned),
        "flops": flops,
        "bytes": byte_count,
        "itemsize": DEFAULT_ITEMSIZE,
        "timing_source": "cuda_events" if use_cuda else "perf_counter",
        "device": device,
        "metadata_ignored": metadata_ignored,
        "language": request.get("language", "python"),
    }


def install_alarm(seconds: int) -> None:
    def _handler(signum: int, frame: Any) -> None:  # noqa: ARG001 - signal API
        raise TimeoutError("agent wall clock exceeded")

    signal.signal(signal.SIGALRM, _handler)
    signal.alarm(max(1, int(seconds)))


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="KernelForge in-container agent")
    parser.add_argument("--request", required=True, help="path to request.json")
    parser.add_argument("--role", required=True, choices=["baseline", "submission"])
    parser.add_argument("--module", required=True, help="path to the python module to measure")
    parser.add_argument("--output", default="/output", help="directory for role result files")
    parser.add_argument("--wall-clock", type=int, default=60, help="agent wall clock in seconds")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    try:
        install_alarm(args.wall_clock)
        request = json.loads(Path(args.request).read_text(encoding="utf-8"))
        measurement = run_role(request, args.role, args.module)
        payload = {"ok": True, "role": args.role, "measurement": measurement}
        output_path = Path(args.output) / f"{args.role}.json"
        try:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(json.dumps(measurement, separators=(",", ":")), encoding="utf-8")
        except OSError:
            pass  # /output may be read-only; stdout remains the source of truth
        emit(payload)
        return 0
    except AgentError as error:
        return fail("execution_error", str(error))
    except TimeoutError:
        return fail("timeout", "agent wall clock exceeded")
    except Exception as error:  # noqa: BLE001 - the worker needs a reason, not a crash
        return fail("execution_error", f"{type(error).__name__}: {error}")


if __name__ == "__main__":
    raise SystemExit(main())


def _tensor_shape(value: Any) -> list[int] | None:
    shape = getattr(value, "shape", None)
    if shape is None:
        return None
    try:
        return [int(dimension) for dimension in shape]
    except TypeError:
        return None


def _tensor_dtype(value: Any) -> str | None:
    dtype = getattr(value, "dtype", None)
    return None if dtype is None else str(dtype)


def _flatten_numbers(value: Any) -> list[float]:
    """Best-effort numeric flattening; non-numeric leaves are skipped."""
    if isinstance(value, bool):
        return [float(value)]
    if isinstance(value, (int, float)):
        return [float(value)]
    if isinstance(value, (list, tuple)):
        flattened: list[float] = []
        for item in value:
            flattened.extend(_flatten_numbers(item))
        return flattened
    tolist = getattr(value, "tolist", None)
    if callable(tolist):
        return _flatten_numbers(tolist())
    return []


def reduce_output(value: Any) -> dict[str, Any]:
    """Reduce an arbitrary benchmark() output to a bounded, comparable form."""
    if isinstance(value, dict) and "output" in value:
        return reduce_output(value["output"])
    if isinstance(value, bool) or isinstance(value, (int, float)):
        numeric = float(value)
        return {"kind": "scalar", "value": numeric, "count": 1, "sum": numeric}
    numbers = _flatten_numbers(value)
    shape = _tensor_shape(value)
    dtype = _tensor_dtype(value)
    if not numbers:
        return {"kind": "unsupported", "repr": repr(value)[:120]}
    return {
        "kind": "tensor" if shape is not None or len(numbers) > 1 else "scalar",
        "shape": shape or [len(numbers)],
        "dtype": dtype,
        "count": len(numbers),
        "sum": math.fsum(numbers),
        "sample": numbers[:SAMPLE_LIMIT],
        "abs_max": max((abs(number) for number in numbers), default=0.0),
    }