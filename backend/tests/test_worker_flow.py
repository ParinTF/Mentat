from __future__ import annotations

from typing import Any

from backend.app.config import Settings
from backend.app.runners import RunnerError
from backend.app.worker import process_submission


class Store:
    def __init__(self, request: dict[str, Any]) -> None:
        self.snapshot = {
            "submission_id": "submission",
            "status": "queued",
            "request": {**request, "short_id": "8K4QZ2M7"},
            "created_at": None,
            "result": None,
            "error": None,
        }
        self.locks = 0

    def get_submission(self, submission_id: str) -> dict[str, Any] | None:
        return self.snapshot if submission_id == "submission" else None

    def set_status(self, submission_id: str, status: str, error: str | None = None) -> None:
        self.snapshot["status"] = status
        self.snapshot["error"] = error

    def complete(self, submission_id: str, result: dict[str, Any]) -> None:
        self.snapshot["status"] = "completed"
        self.snapshot["result"] = result
        self.snapshot["error"] = None

    def acquire_lock(self, submission_id: str) -> bool:
        self.locks += 1
        return True

    def release_lock(self, submission_id: str) -> None:
        self.snapshot["status"] = self.snapshot["status"]


class Journal:
    def __init__(self) -> None:
        self.events: list[tuple[str, str, dict[str, Any]]] = []

    def emit(
        self,
        submission_id: str,
        event_type: str,
        payload: dict[str, Any],
        event_key: str | None = None,
        timestamp: str | None = None,
    ) -> dict[str, Any]:
        self.events.append((submission_id, event_type, payload))
        return {"sequence": len(self.events), "payload": payload}


def settings(mode: str = "sandbox") -> Settings:
    return Settings(
        database_url="postgresql://unused",
        redis_url="redis://unused",
        run_token=None,
        mode=mode,
        concurrency=1,
        max_container_seconds=5,
        max_log_bytes=65_536,
        runner_image_cpu="runner:test",
        runner_image_cuda="cuda:test",
        docker_host="unix:///var/run/docker.sock",
        runner_input_root="/tmp/kf-input",
        runner_input_volume="runner-input-test",
        cors_origins=(),
    )


def request() -> dict[str, Any]:
    return {
        "code": "def benchmark(): pass",
        "language": "python",
        "device": "cpu",
        "warmup": 1,
        "repetitions": 2,
        "workload_mode": "protocol",
        "workload": {"flops": 1000, "bytes_transferred": 8000},
        "hardware": {"name": "CPU", "peak_compute_tflops": 10, "peak_bandwidth_gbps": 500},
        "challenge_slug": None,
    }


def measurement() -> dict[str, Any]:
    return {
        "samples_ms": [1.0, 2.0],
        "flops": 2000,
        "bytes": 16000,
        "reduced_output": {"kind": "scalar", "value": 1.0, "count": 1, "sum": 1.0},
        "timing_source": "perf_counter",
        "device": "cpu",
        "metadata_ignored": False,
        "language": "python",
    }


def test_worker_uses_protocol_measurement_and_emits_result_before_completed() -> None:
    store = Store(request())
    journal = Journal()
    process_submission("submission", store, journal, settings(), lambda current, value: measurement())
    assert store.snapshot["status"] == "completed"
    result = store.snapshot["result"]
    assert result["short_id"] == "8K4QZ2M7"
    assert result["arithmetic_intensity"] == 0.125
    assert result["provenance"] == {"timing": "measured", "workload": "protocol", "movement": "derived"}
    types = [event_type for _, event_type, _ in journal.events]
    statuses = [payload.get("status") for _, event_type, payload in journal.events if event_type == "status"]
    assert types.index("result") < len(types) - 1
    assert statuses[-1] == "completed"


def test_worker_maps_agent_timeout_to_timed_out() -> None:
    store = Store(request())
    journal = Journal()

    def timeout(current: Settings, value: dict[str, Any]) -> dict[str, Any]:
        raise RunnerError("agent wall clock exceeded", "timeout")

    process_submission("submission", store, journal, settings(), timeout)
    assert store.snapshot["status"] == "timed_out"
    assert journal.events[-2][1] == "error"
    assert journal.events[-2][2]["code"] == "timeout"
    assert journal.events[-1][2]["status"] == "timed_out"


def test_simulation_reports_user_estimate() -> None:
    store = Store(request())
    journal = Journal()
    process_submission("submission", store, journal, settings("simulation"))
    result = store.snapshot["result"]
    assert result["provenance"]["timing"] == "simulation"
    assert result["provenance"]["workload"] == "user_estimate"
