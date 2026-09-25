from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Mapping

REPLAY_CHANNEL_PREFIX = "kf:events:"
REPLAY_SEQUENCE_PREFIX = "kf:sequence:"
REPLAY_EVENT_KEY_PREFIX = "kf:event-keys:"
REPLAY_LIST_KEY_PREFIX = "kf:replay:"
REPLAY_MAX_EVENTS = 1000
REPLAY_TTL_SECONDS = 3600
MAX_LOG_CHARS = 4096
STAGES = ("host_ram", "pcie", "vram", "sram", "cores")

_APPEND_SCRIPT = """
local existing = redis.call('HGET', KEYS[2], ARGV[1])
if existing then
  return existing
end
local sequence = redis.call('INCR', KEYS[1])
local envelope = cjson.encode({
  version = 1,
  submission_id = ARGV[2],
  sequence = sequence,
  timestamp = ARGV[5],
  type = ARGV[3],
  payload = cjson.decode(ARGV[4])
})
redis.call('HSET', KEYS[2], ARGV[1], envelope)
redis.call('RPUSH', KEYS[3], envelope)
redis.call('LTRIM', KEYS[3], -__MAX_EVENTS__, -1)
redis.call('EXPIRE', KEYS[1], __TTL_SECONDS__)
redis.call('EXPIRE', KEYS[2], __TTL_SECONDS__)
redis.call('EXPIRE', KEYS[3], __TTL_SECONDS__)
redis.call('PUBLISH', ARGV[6], envelope)
return envelope
""".replace("__MAX_EVENTS__", str(REPLAY_MAX_EVENTS)).replace("__TTL_SECONDS__", str(REPLAY_TTL_SECONDS))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_envelope(submission_id: str, sequence: int, event_type: str, payload: Mapping[str, Any], timestamp: str | None = None) -> dict[str, Any]:
    if sequence < 0:
        raise ValueError("sequence must be >= 0")
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
    def __init__(self, redis_url: str) -> None:
        self._redis_url = redis_url
        self._client: Any = None
        self._append_script: Any = None

    def _connection(self) -> Any:
        if self._client is None:
            import redis

            self._client = redis.Redis.from_url(self._redis_url, decode_responses=True)
            self._append_script = self._client.register_script(_APPEND_SCRIPT)
        return self._client

    def emit(
        self,
        submission_id: str,
        event_type: str,
        payload: Mapping[str, Any],
        event_key: str | None = None,
        timestamp: str | None = None,
    ) -> dict[str, Any]:
        self._connection()
        key = event_key or uuid.uuid4().hex
        raw = self._append_script(
            keys=[
                REPLAY_SEQUENCE_PREFIX + submission_id,
                REPLAY_EVENT_KEY_PREFIX + submission_id,
                REPLAY_LIST_KEY_PREFIX + submission_id,
            ],
            args=[
                key,
                submission_id,
                event_type,
                json.dumps(dict(payload), separators=(",", ":")),
                timestamp or now_iso(),
                REPLAY_CHANNEL_PREFIX + submission_id,
            ],
        )
        decoded = json.loads(raw)
        if not isinstance(decoded, dict):
            raise RuntimeError("Redis returned an invalid event envelope")
        return decoded

    def heartbeat(self, submission_id: str) -> dict[str, Any]:
        return build_envelope(submission_id, 0, "heartbeat", {})

    def replay(self, submission_id: str, after: int) -> list[dict[str, Any]]:
        raw = self._connection().lrange(REPLAY_LIST_KEY_PREFIX + submission_id, 0, -1)
        events = [json.loads(item) for item in raw]
        return [event for event in events if int(event.get("sequence", 0)) > after]

    def subscribe(self, submission_id: str) -> Any:
        pubsub = self._connection().pubsub(ignore_subscribe_messages=True)
        pubsub.subscribe(REPLAY_CHANNEL_PREFIX + submission_id)
        return pubsub

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None
            self._append_script = None
