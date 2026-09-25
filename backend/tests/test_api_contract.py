from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.app.config import Settings
from backend.app.main import AppServices, create_app
from backend.app.metrics import build_result
from backend.app.schemas import normalise_request


class MemoryStore:
    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}

    def create_submission(self, request: dict[str, Any], short_id: str) -> dict[str, Any]:
        submission_id = str(uuid.uuid4())
        stored = {**request, "short_id": short_id}
        snapshot = {
            "submission_id": submission_id,
            "status": "queued",
            "request": stored,
            "created_at": datetime.now(timezone.utc),
            "result": None,
            "error": None,
        }
        self.rows[submission_id] = snapshot
        return snapshot

    def set_status(self, submission_id: str, status: str, error: str | None = None) -> None:
        self.rows[submission_id]["status"] = status
        self.rows[submission_id]["error"] = error

    def complete(self, submission_id: str, result: dict[str, Any]) -> None:
        self.rows[submission_id]["result"] = result
        self.rows[submission_id]["status"] = "completed"
        self.rows[submission_id]["error"] = None

    def get_submission(self, submission_id: str) -> dict[str, Any] | None:
        return self.rows.get(submission_id)

    def get_share(self, short_id: str) -> dict[str, Any] | None:
        for snapshot in self.rows.values():
            if snapshot["request"]["short_id"] == short_id:
                return {
                    "short_id": short_id,
                    "submission_id": snapshot["submission_id"],
                    "challenge_slug": snapshot["request"]["challenge_slug"],
                    "language": snapshot["request"]["language"],
                    "device": snapshot["request"]["device"],
                    "created_at": snapshot["created_at"].isoformat(),
                    "result": snapshot["result"],
                }
        return None

    def acquire_lock(self, submission_id: str) -> bool:
        return True

    def release_lock(self, submission_id: str) -> None:
        return None

    def close(self) -> None:
        return None


class MemoryJournal:
    def __init__(self) -> None:
        self.events: dict[str, list[dict[str, Any]]] = {}
        self.event_keys: dict[tuple[str, str], dict[str, Any]] = {}

    def emit(
        self,
        submission_id: str,
        event_type: str,
        payload: dict[str, Any],
        event_key: str | None = None,
        timestamp: str | None = None,
    ) -> dict[str, Any]:
        events = self.events.setdefault(submission_id, [])
        cache_key = (submission_id, event_key or "")
        if event_key is not None and cache_key in self.event_keys:
            return self.event_keys[cache_key]
        event = {
            "version": 1,
            "submission_id": submission_id,
            "sequence": len(events) + 1,
            "timestamp": timestamp or "2026-09-25T00:00:00.000Z",
            "type": event_type,
            "payload": payload,
        }
        events.append(event)
        if event_key is not None:
            self.event_keys[cache_key] = event
        return event

    def replay(self, submission_id: str, after: int) -> list[dict[str, Any]]:
        return [event for event in self.events.get(submission_id, []) if event["sequence"] > after]

    def subscribe(self, submission_id: str) -> Any:
        return EmptyPubSub()

    def heartbeat(self, submission_id: str) -> dict[str, Any]:
        return {
            "version": 1,
            "submission_id": submission_id,
            "sequence": 0,
            "timestamp": "2026-09-25T00:00:00.000Z",
            "type": "heartbeat",
            "payload": {},
        }

    def close(self) -> None:
        return None


class EmptyPubSub:
    def close(self) -> None:
        return None


class MemoryQueue:
    def __init__(self) -> None:
        self.submission_ids: list[str] = []

    def enqueue(self, submission_id: str) -> None:
        self.submission_ids.append(submission_id)


class FailingQueue:
    def enqueue(self, submission_id: str) -> None:
        raise RuntimeError("redis://internal-broker")


class MemoryRegistry:
    def close(self) -> None:
        return None


def make_settings(**overrides: Any) -> Settings:
    values = {
        "database_url": "postgresql://unused",
        "redis_url": "redis://unused",
        "run_token": None,
        "mode": "sandbox",
        "concurrency": 1,
        "max_container_seconds": 5,
        "max_log_bytes": 65_536,
        "runner_image_cpu": "kernelforge-runner-cpu:test",
        "runner_image_cuda": "kernelforge-runner-cuda:test",
        "docker_host": "unix:///var/run/docker.sock",
        "runner_input_root": "/tmp/kf-input",
        "runner_input_volume": "kernelforge-runner-inputs-test",
        "cors_origins": ("http://localhost:3000",),
    }
    values.update(overrides)
    return Settings(**values)


def capabilities() -> dict[str, Any]:
    return {
        "mode": "sandbox",
        "devices": {"cpu": True, "cuda": False},
        "languages": {"python": True, "pytorch": True, "triton": False},
        "limits": {"max_code_bytes": 65_536, "max_repetitions": 100, "wall_time_s": 5},
        "host": {"os": "Linux", "arch": "x86_64", "cpu_cores": 4, "memory_gb": 8.0},
    }


def payload(**overrides: Any) -> dict[str, Any]:
    value = {
        "code": "def benchmark():\n    return {'output': 1.0, 'flops': 1000, 'bytes': 8000}\n",
        "language": "python",
        "device": "cpu",
        "warmup": 1,
        "repetitions": 2,
        "workload_mode": "protocol",
        "workload": {"flops": 1000, "bytes_transferred": 8000},
        "hardware": {"name": "CPU test", "peak_compute_tflops": 10, "peak_bandwidth_gbps": 500},
        "challenge_slug": None,
    }
    value.update(overrides)
    return value


def make_client(current: Settings | None = None) -> tuple[TestClient, MemoryStore, MemoryJournal, MemoryQueue]:
    store = MemoryStore()
    journal = MemoryJournal()
    task_queue = MemoryQueue()
    services = AppServices(store, journal, task_queue, MemoryRegistry(), capabilities)
    return TestClient(create_app(current or make_settings(), services)), store, journal, task_queue


def test_health_and_capabilities_follow_the_cpu_contract() -> None:
    client, _, _, _ = make_client()
    with client:
        assert client.get("/api/v1/health").json() == {"status": "ok", "mode": "sandbox"}
        response = client.get("/api/v1/capabilities")
        assert response.status_code == 200
        assert response.json()["devices"] == {"cpu": True, "cuda": False}
        assert response.json()["languages"]["triton"] is False


def test_submission_round_trip_and_public_share() -> None:
    client, store, _, task_queue = make_client()
    with client:
        response = client.post("/api/v1/submissions", json=payload())
        assert response.status_code == 202
        accepted = response.json()
        assert accepted["status"] == "queued"
        assert accepted["mode"] == "sandbox"
        assert task_queue.submission_ids == [accepted["submission_id"]]
        short_id = store.rows[accepted["submission_id"]]["request"]["short_id"]
        request = normalise_request(payload())
        result = build_result(
            request,
            [1.0, 2.0],
            "measured",
            {"flops": 2000, "bytes_transferred": 16000},
            short_id,
        )
        store.complete(accepted["submission_id"], result)
        snapshot = client.get(f"/api/v1/submissions/{accepted['submission_id']}")
        assert snapshot.status_code == 200
        assert snapshot.json()["result"]["short_id"] == short_id
        share = client.get(f"/api/v1/s/{short_id}")
        assert share.status_code == 200
        assert share.json()["submission_id"] == accepted["submission_id"]
        assert "code" not in share.json()


def test_defaults_unknown_fields_and_unsupported_work() -> None:
    client, store, _, task_queue = make_client()
    with client:
        minimal = payload()
        minimal.pop("warmup")
        minimal.pop("repetitions")
        minimal.pop("workload_mode")
        response = client.post("/api/v1/submissions", json=minimal)
        assert response.status_code == 202
        submission_id = response.json()["submission_id"]
        assert store.rows[submission_id]["request"]["warmup"] == 3
        assert store.rows[submission_id]["request"]["repetitions"] == 10
        assert store.rows[submission_id]["request"]["workload_mode"] == "protocol"
        response = client.post("/api/v1/submissions", json=payload(extra=True))
        assert response.status_code == 422
        response = client.post("/api/v1/submissions", content=b'{"padding":"' + (b'x' * 80000) + b'"}', headers={"Content-Type": "application/json"})
        assert response.status_code == 413
        response = client.post("/api/v1/submissions", json=payload(language="triton", device="cuda"))
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "unsupported_device"
        response = client.post("/api/v1/submissions", json=payload(challenge_slug="missing-challenge"))
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "unknown_challenge"
        assert task_queue.submission_ids == [submission_id]


def test_enqueue_failure_is_not_reported_as_accepted() -> None:
    store = MemoryStore()
    journal = MemoryJournal()
    services = AppServices(store, journal, FailingQueue(), MemoryRegistry(), capabilities)
    with TestClient(create_app(make_settings(), services)) as client:
        response = client.post("/api/v1/submissions", json=payload())
        assert response.status_code == 503
        assert response.json()["detail"]["code"] == "infrastructure_error"
        snapshot = next(iter(store.rows.values()))
        assert snapshot["status"] == "failed"


def test_token_is_required_only_when_configured() -> None:
    client, _, _, _ = make_client(make_settings(run_token="secret"))
    with client:
        assert client.post("/api/v1/submissions", json=payload()).status_code == 401
        response = client.post(
            "/api/v1/submissions",
            json=payload(),
            headers={"X-KernelForge-Token": "secret"},
        )
        assert response.status_code == 202


def test_websocket_replays_in_order_and_validates_cursor() -> None:
    client, store, journal, _ = make_client()
    with client:
        accepted = client.post("/api/v1/submissions", json=payload()).json()
        submission_id = accepted["submission_id"]
        request = store.rows[submission_id]["request"]
        result = build_result(
            request,
            [1.0],
            "measured",
            {"flops": 1000, "bytes_transferred": 8000},
            request["short_id"],
        )
        store.complete(submission_id, result)
        journal.emit(submission_id, "result", result, event_key="result")
        journal.emit(submission_id, "status", {"status": "completed"}, event_key="status:completed")
        with client.websocket_connect(f"/api/v1/submissions/{submission_id}/events?after=0") as websocket:
            queued = websocket.receive_json()
            result_event = websocket.receive_json()
            completed = websocket.receive_json()
            assert queued["payload"]["status"] == "queued"
            assert result_event["type"] == "result"
            assert completed["payload"]["status"] == "completed"
        with pytest.raises(WebSocketDisconnect) as invalid:
            with client.websocket_connect(f"/api/v1/submissions/{submission_id}/events?after=nope") as websocket:
                websocket.receive_json()
        assert invalid.value.code == 4400
        with pytest.raises(WebSocketDisconnect) as missing:
            with client.websocket_connect("/api/v1/submissions/missing/events?after=0") as websocket:
                websocket.receive_json()
        assert missing.value.code == 4404
