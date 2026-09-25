from __future__ import annotations

import json
from typing import Any

CAPABILITY_KEY = "kf:capabilities:v1"
CAPABILITY_TTL_SECONDS = 120


class RedisCapabilityRegistry:
    def __init__(self, redis_url: str) -> None:
        self._redis_url = redis_url
        self._client: Any = None

    def _connection(self) -> Any:
        if self._client is None:
            import redis

            self._client = redis.Redis.from_url(self._redis_url, decode_responses=True)
        return self._client

    def publish(self, capabilities: dict[str, Any]) -> None:
        client = self._connection()
        client.set(CAPABILITY_KEY, json.dumps(capabilities, separators=(",", ":")), ex=CAPABILITY_TTL_SECONDS)

    def get(self) -> dict[str, Any] | None:
        raw = self._connection().get(CAPABILITY_KEY)
        if raw is None:
            return None
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            return None
        return value if isinstance(value, dict) else None

    def close(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None
