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
MAX_SAFE_INTEGER = 9_007_199_254_740_991


class AgentError(RuntimeError):
    pass


class MetadataError(AgentError):
    pass


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(f"{SENTINEL} {json.dumps(payload, separators=(',', ':'), allow_nan=False)}\n")
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


def _metadata_count(value: Any, key: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_SAFE_INTEGER:
        raise MetadataError(f"protocol metadata {key} must be a non-negative safe integer")
    return value


def extract_metadata(returned: Any, request: dict[str, Any]) -> tuple[int, int, bool]:
    if not isinstance(returned, dict) or "output" not in returned:
        raise AgentError("benchmark() must return a mapping containing output")
    mode = request.get("workload_mode", "protocol")
    if mode == "declared":
        workload = request["workload"]
        return _metadata_count(workload["flops"], "flops"), _metadata_count(workload["bytes_transferred"], "bytes"), False
    if mode == "challenge_theory":
        return 0, 0, True
    for key in ("flops", "bytes"):
        if key not in returned:
            raise MetadataError(f"protocol mode requires benchmark() to return {key!r}")
    return _metadata_count(returned["flops"], "flops"), _metadata_count(returned["bytes"], "bytes"), False


def timed_repetitions(benchmark: Callable[[], Any], repetitions: int, use_cuda: bool) -> list[float]:
    if not 1 <= repetitions <= 100:
        raise AgentError("repetitions must be within 1..100")
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
            samples.append(max(float(start.elapsed_time(end)), 1e-9))
        return samples
    for _ in range(repetitions):
        started = time.perf_counter()
        benchmark()
        samples.append(max((time.perf_counter() - started) * 1000.0, 1e-9))
    return samples


def run_role(request: dict[str, Any], role: str, module_path: str) -> dict[str, Any]:
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
        except Exception as error:
            raise AgentError("CUDA runtime is unavailable") from error
        if not torch.cuda.is_available():
            raise AgentError("CUDA runtime is unavailable")
        use_cuda = True
    warmup = int(request.get("warmup", 3))
    repetitions = int(request.get("repetitions", 10))
    if not 0 <= warmup <= 10:
        raise AgentError("warmup must be within 0..10")
    if use_cuda:
        import torch

        for _ in range(warmup):
            benchmark()
            torch.cuda.synchronize()
    else:
        for _ in range(warmup):
            benchmark()
    returned = benchmark()
    flops, byte_count, metadata_ignored = extract_metadata(returned, request)
    samples = timed_repetitions(benchmark, repetitions, use_cuda)
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
    if not hasattr(signal, "SIGALRM"):
        return

    def _handler(signum: int, frame: Any) -> None:
        raise TimeoutError("agent wall clock exceeded")

    signal.signal(signal.SIGALRM, _handler)
    signal.alarm(max(1, int(seconds)))


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="KernelForge in-container agent")
    parser.add_argument("--request", required=True)
    parser.add_argument("--role", required=True, choices=["baseline", "submission"])
    parser.add_argument("--module", required=True)
    parser.add_argument("--output", default="/output")
    parser.add_argument("--wall-clock", type=int, default=60)
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
            output_path.write_text(json.dumps(measurement, separators=(",", ":"), allow_nan=False), encoding="utf-8")
        except OSError:
            pass
        emit(payload)
        return 0
    except MetadataError as error:
        return fail("missing_workload_metadata", str(error))
    except TimeoutError:
        return fail("timeout", "agent wall clock exceeded")
    except AgentError as error:
        return fail("execution_error", str(error))
    except Exception as error:
        return fail("execution_error", f"{type(error).__name__}: {error}")


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


def _finite_number(value: int | float) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise AgentError("benchmark output contains a non-finite number")
    return number


def _flatten_numbers(value: Any) -> list[float]:
    if isinstance(value, bool):
        return [_finite_number(value)]
    if isinstance(value, (int, float)):
        return [_finite_number(value)]
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
    if isinstance(value, dict) and "output" in value:
        return reduce_output(value["output"])
    if isinstance(value, bool) or isinstance(value, (int, float)):
        numeric = _finite_number(value)
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


if __name__ == "__main__":
    raise SystemExit(main())
