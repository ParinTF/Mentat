"""WebSocket event envelopes plus the Redis replay buffer.

Envelope contract (contracts/API.md):
    {"version": 1, "submission_id": ..., "sequence": n, "timestamp": ISO-8601,
     "type": status|log|trace|result|error|heartbeat, "payload": {...}}

Sequence numbers start at 1 and are strictly monotonic per submission; the
heartbeat uses sequence 0 and is never stored, so a client reconnecting with
`after=<last seen>` replays exactly the persisted events.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Mapping

REPLAY_CHANNEL_PREFIX = "kf:events:"
REPLAY_LIST_KEY_PREFIX = "kf:replay:"
REPLAY_MAX_EVENTS = 1000
REPLAY_TTL_SECONDS = 3600
MAX_LOG_CHARS = 4096

STAGES = ("host_ram", "pcie", "vram", "sram", "cores")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_envelope(submission_id: str, sequence: int, event_type: str, payload: Mapping[str, Any], timestamp: str | None = None) -> dict[str, Any]:
    if sequence < 0:
        raise ValueError("sequence must be >= 0 (0 is reserved for heartbeats)")
    if event_type not in {"status", "log", "trace", "result", "error", "heartbeat"}:
        raise ValueError(f"unknown event type {event_type!r}")
    return {
        "version": 1,
        "submission_id": submission_id,
        "sequence": sequence,
        "timestamp": timestamp or now_iso(),
        "type": event_type,
        "payload": dict(payload),
    }


def log_payload(stream: str, text: str) -> dict[str, Any]:
    if stream not in {"stdout", "stderr", "system"}:
        raise ValueError(f"unknown log stream {stream!r}")
    return {"stream": stream, "text": text[:MAX_LOG_CHARS]}


def trace_payload(stage: str, progress: float, source: str = "illustrative", bottleneck: str | None = None) -> dict[str, Any]:
    if stage not in STAGES:
        raise ValueError(f"unknown stage {stage!r}")
    if not 0.0 <= progress <= 1.0:
        raise ValueError("progress must be within [0, 1]")
    payload: dict[str, Any] = {"source": source, "stage": stage, "progress": progress}
    if bottleneck is not None:
        payload["bottleneck"] = bottleneck
    return payload


def status_payload(status: str) -> dict[str, Any]:
    if status not in {"queued", "compiling", "running", "completed", "failed", "timed_out"}:
        raise ValueError(f"unknown status {status!r}")
    return {"status": status}


def error_payload(code: str, message: str) -> dict[str, Any]:
    if code not in {"execution_error", "timeout", "infrastructure_error", "missing_workload_metadata", "unsupported_device"}:
        raise ValueError(f"unknown error code {code!r}")
    return {"code": code, "message": message[:MAX_LOG_CHARS]}


class EventPublisher:
    """Publishes envelopes to a per-submission Redis channel and keeps a
    bounded replay list. Redis is imported lazily so the module stays
    import-safe on machines without it."""

    def __init__(self, redis_url: str, submission_id: str) -> None:
        self._redis_url = redis_url
        self._submission_id = submission_id
        self._sequence = 0
        self._client: Any = None

    def _connection(self) -> Any:
        if self._client is None:
            import redis  # imported lazily: tests may not have redis installed

            self._client = redis.Redis.from_url(self._redis_url, decode_responses=True)
        return self._client

    def emit(self, event_type: str, payload: Mapping[str, Any], timestamp: str | None = None) -> dict[str, Any]:
        self._sequence += 1
        envelope = build_envelope(self._submission_id, self._sequence, event_type, payload, timestamp)
        client = self._connection()
        key = REPLAY_LIST_KEY_PREFIX + self._submission_id
        client.rpush(key, json.dumps(envelope))
        client.ltrim(key, -REPLAY_MAX_EVENTS, -1)
        client.expire(key, REPLAY_TTL_SECONDS)
        client.publish(REPLAY_CHANNEL_PREFIX + self._submission_id, json.dumps(envelope))
        return envelope

    def heartbeat(self) -> dict[str, Any]:
        return build_envelope(self._submission_id, 0, "heartbeat", {})

    def replay(self, after: int) -> list[dict[str, Any]]:
        """Events with sequence > after, oldest first; empty when history
        expired (clients must then fall back to the GET snapshot)."""
        client = self._connection()
        raw = client.lrange(REPLAY_LIST_KEY_PREFIX + self._submission_id, 0, -1)
        events = [json.loads(item) for item in raw]
        return [event for event in events if event["sequence"] > after]
