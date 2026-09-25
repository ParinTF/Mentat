from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Callable

from celery.signals import worker_process_init

from .capabilities import current_capabilities
from .capability_registry import RedisCapabilityRegistry
from .celery_app import celery_app
from .config import MAX_SAFE_INTEGER, Settings, settings
from .events import EventPublisher, error_payload, status_payload, trace_payload
from .metrics import build_result
from .runners import RunnerError, cleanup_orphan_containers, cleanup_workspace, prepare_workspace, run_agent, simulate
from .store import PostgresStore

TERMINAL_STATUSES = {"completed", "failed", "timed_out"}


def _validate_measurement(measurement: dict[str, Any], repetitions: int) -> None:
    samples = measurement.get("samples_ms")
    if not isinstance(samples, list) or len(samples) != repetitions:
        raise ValueError("agent samples_ms must match repetitions")
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)) or float(value) <= 0 for value in samples):
        raise ValueError("agent samples must be finite and positive")
    for key in ("flops", "bytes"):
        value = measurement.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_SAFE_INTEGER:
            raise ValueError(f"agent {key} must be a non-negative safe integer")
    if not isinstance(measurement.get("reduced_output"), dict):
        raise ValueError("agent reduced_output must be an object")


def _emit_terminal(snapshot: dict[str, Any], journal: EventPublisher) -> None:
    status = snapshot["status"]
    if status == "completed":
        result = snapshot.get("result")
        if not isinstance(result, dict):
            return
        journal.emit(snapshot["submission_id"], "result", result, event_key="result")
        journal.emit(
            snapshot["submission_id"],
            "status",
            status_payload("completed"),
            event_key="status:completed",
        )
        return
    code = "timeout" if status == "timed_out" else "execution_error"
    journal.emit(
        snapshot["submission_id"],
        "error",
        error_payload(code, str(snapshot.get("error") or "submission failed")),
        event_key="error:terminal",
    )
    journal.emit(
        snapshot["submission_id"],
        "status",
        status_payload(status),
        event_key=f"status:{status}",
    )


def _execute(settings_value: Settings, submission_id: str, request: dict[str, Any]) -> dict[str, Any]:
    if request["device"] != "cpu":
        raise RunnerError("CPU worker cannot execute the requested device", "execution_error")
    if request["language"] not in {"python", "pytorch"}:
        raise RunnerError("CPU worker cannot execute the requested language", "execution_error")
    if request["workload_mode"] == "challenge_theory":
        raise RunnerError("challenge execution is not available in the CPU MVP", "execution_error")
    workspace = prepare_workspace(Path(settings_value.runner_input_root), submission_id, request, request["code"])
    try:
        return run_agent(
            settings_value,
            "submission",
            f"/input/{submission_id}/submission.py",
            settings_value.runner_image_cpu,
            f"/input/{submission_id}",
        )
    finally:
        cleanup_workspace(workspace)


def _public_error_message(code: str, message: str) -> str:
    if code == "infrastructure_error":
        return "runner infrastructure is unavailable"
    if code == "timeout":
        return "submission exceeded the execution time limit"
    return message[:4096]


def process_submission(
    submission_id: str,
    store: PostgresStore,
    journal: EventPublisher,
    settings_value: Settings,
    runner: Callable[..., dict[str, Any]] | None = None,
) -> None:
    snapshot = store.get_submission(submission_id)
    if snapshot is None:
        return
    if snapshot["status"] in TERMINAL_STATUSES:
        _emit_terminal(snapshot, journal)
        return
    acquire = getattr(store, "acquire_lock", None)
    if callable(acquire) and not acquire(submission_id):
        return
    try:
        snapshot = store.get_submission(submission_id)
        if snapshot is None or snapshot["status"] in TERMINAL_STATUSES:
            if snapshot is not None:
                _emit_terminal(snapshot, journal)
            return
        request = snapshot["request"]
        try:
            store.set_status(submission_id, "compiling")
            journal.emit(submission_id, "status", status_payload("compiling"), event_key="status:compiling")
            journal.emit(
                submission_id,
                "log",
                {"stream": "system", "text": "Preparing the isolated CPU runner."},
                event_key="log:compiling",
            )
            store.set_status(submission_id, "running")
            journal.emit(submission_id, "status", status_payload("running"), event_key="status:running")
            if settings_value.mode == "simulation":
                measurement = simulate(settings_value, request)
                logs: dict[str, str] = {}
            else:
                run_output = _execute(settings_value, submission_id, request) if runner is None else runner(settings_value, request)
                if "measurement" in run_output:
                    measurement = run_output["measurement"]
                    logs = {
                        "stdout": str(run_output.get("stdout", "")),
                        "stderr": str(run_output.get("stderr", "")),
                    }
                else:
                    measurement = run_output
                    logs = {}
            _validate_measurement(measurement, int(request["repetitions"]))
            for stream, text in logs.items():
                if text:
                    journal.emit(
                        submission_id,
                        "log",
                        {"stream": stream, "text": text},
                        event_key=f"log:{stream}",
                    )
            metric_request = dict(request)
            if settings_value.mode == "simulation":
                metric_request["workload_mode"] = "declared"
            if metric_request["workload_mode"] == "protocol":
                effective_workload = {"flops": measurement["flops"], "bytes_transferred": measurement["bytes"]}
            else:
                effective_workload = metric_request["workload"]
            result = build_result(
                metric_request,
                [float(value) for value in measurement["samples_ms"]],
                "simulation" if settings_value.mode == "simulation" else "measured",
                effective_workload,
                request["short_id"],
            )
            store.complete(submission_id, result)
            stage = "cores" if result["bottleneck"] == "compute" else "host_ram"
            journal.emit(
                submission_id,
                "trace",
                trace_payload(stage, 1.0, "illustrative", result["bottleneck"]),
                event_key="trace:final",
            )
            journal.emit(submission_id, "result", result, event_key="result")
            journal.emit(
                submission_id,
                "status",
                status_payload("completed"),
                event_key="status:completed",
            )
        except RunnerError as error:
            if error.code == "infrastructure_error":
                raise
            terminal = "timed_out" if error.code == "timeout" else "failed"
            public_message = _public_error_message(error.code, str(error))
            store.set_status(submission_id, terminal, public_message)
            journal.emit(
                submission_id,
                "error",
                error_payload(error.code, public_message),
                event_key="error:terminal",
            )
            journal.emit(
                submission_id,
                "status",
                status_payload(terminal),
                event_key=f"status:{terminal}",
            )
        except ValueError as error:
            public_message = _public_error_message("execution_error", str(error))
            store.set_status(submission_id, "failed", public_message)
            journal.emit(
                submission_id,
                "error",
                error_payload("execution_error", public_message),
                event_key="error:terminal",
            )
            journal.emit(
                submission_id,
                "status",
                status_payload("failed"),
                event_key="status:failed",
            )
    finally:
        release = getattr(store, "release_lock", None)
        if callable(release):
            release(submission_id)


def _publish_worker_capabilities() -> None:
    current = settings()
    if current.mode == "sandbox":
        cleanup_orphan_containers(current)
    registry = RedisCapabilityRegistry(current.redis_url)
    try:
        registry.publish(current_capabilities())
    finally:
        registry.close()


@worker_process_init.connect
def publish_worker_capabilities(**kwargs: Any) -> None:
    _publish_worker_capabilities()


@celery_app.task(name="kernelforge.publish_capabilities")
def publish_capabilities() -> None:
    _publish_worker_capabilities()


@celery_app.task(bind=True, name="kernelforge.run_submission", max_retries=2)
def run_submission(self: Any, submission_id: str) -> None:
    current = settings()
    store = PostgresStore(current.database_url)
    journal = EventPublisher(current.redis_url)
    try:
        process_submission(submission_id, store, journal, current)
    except Exception as error:
        if self.request.retries >= self.max_retries:
            snapshot = store.get_submission(submission_id)
            if snapshot is not None and snapshot["status"] not in TERMINAL_STATUSES:
                public_message = _public_error_message("infrastructure_error", str(error))
                store.set_status(submission_id, "failed", public_message)
                journal.emit(
                    submission_id,
                    "error",
                    error_payload("infrastructure_error", public_message),
                    event_key="error:terminal",
                )
                journal.emit(
                    submission_id,
                    "status",
                    status_payload("failed"),
                    event_key="status:failed",
                )
            return
        raise self.retry(exc=error, countdown=min(30, 2 ** self.request.retries))
    finally:
        store.close()
        journal.close()
