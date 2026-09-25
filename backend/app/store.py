from __future__ import annotations

import json
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

from .config import settings


class ShortIdCollision(RuntimeError):
    pass


class PostgresStore:
    def __init__(self, database_url: str | None = None) -> None:
        self._database_url = database_url or settings().database_url
        self._lock_connection: Any = None
        self._lock_id: str | None = None

    @contextmanager
    def _connection(self) -> Iterator[Any]:
        import psycopg

        connection = psycopg.connect(self._database_url, autocommit=True)
        try:
            yield connection
        finally:
            connection.close()

    @staticmethod
    def _jsonb(value: dict[str, Any]) -> Any:
        from psycopg.types.json import Jsonb

        return Jsonb(value)

    @staticmethod
    def _decode(value: Any) -> Any:
        if value is None or isinstance(value, (dict, list)):
            return value
        if isinstance(value, str):
            return json.loads(value)
        return value

    def close(self) -> None:
        self.release_lock(self._lock_id) if self._lock_id is not None else None

    def create_submission(self, request: dict[str, Any], short_id: str) -> dict[str, Any]:
        submission_id = str(uuid.uuid4())
        created_at = datetime.now(timezone.utc)
        stored_request = {**request, "short_id": short_id}
        try:
            with self._connection() as connection:
                with connection.transaction():
                    connection.execute(
                        """
                        INSERT INTO submissions
                            (id, user_id, challenge_id, code, language, status, created_at, request, error)
                        VALUES (%s, NULL, NULL, %s, %s, 'queued', %s, %s, NULL)
                        """,
                        (
                            submission_id,
                            request["code"],
                            request["language"],
                            created_at,
                            self._jsonb(stored_request),
                        ),
                    )
        except Exception as error:
            if type(error).__name__ == "UniqueViolation":
                raise ShortIdCollision(short_id) from error
            raise
        return {
            "submission_id": submission_id,
            "status": "queued",
            "request": stored_request,
            "created_at": created_at,
            "result": None,
            "error": None,
        }

    def set_status(self, submission_id: str, status: str, error: str | None = None) -> None:
        with self._connection() as connection:
            connection.execute(
                "UPDATE submissions SET status = %s, error = %s WHERE id = %s",
                (status, error, submission_id),
            )

    def complete(self, submission_id: str, result: dict[str, Any]) -> None:
        with self._connection() as connection:
            with connection.transaction():
                connection.execute(
                    """
                    INSERT INTO benchmark_results
                        (submission_id, latency_ms, memory_throughput_gbps, compute_tflops,
                         arithmetic_intensity, pcie_transfer_ms, passed, result)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (submission_id) DO UPDATE SET
                        latency_ms = EXCLUDED.latency_ms,
                        memory_throughput_gbps = EXCLUDED.memory_throughput_gbps,
                        compute_tflops = EXCLUDED.compute_tflops,
                        arithmetic_intensity = EXCLUDED.arithmetic_intensity,
                        pcie_transfer_ms = EXCLUDED.pcie_transfer_ms,
                        passed = EXCLUDED.passed,
                        result = EXCLUDED.result
                    """,
                    (
                        submission_id,
                        float(result["latency_ms"]),
                        float(result["memory_throughput_gbps"]),
                        float(result["compute_tflops"]),
                        result["arithmetic_intensity"],
                        result["pcie_transfer_ms"],
                        result["passed"],
                        self._jsonb(result),
                    ),
                )
                connection.execute(
                    "UPDATE submissions SET status = 'completed', error = NULL WHERE id = %s",
                    (submission_id,),
                )

    def get_submission(self, submission_id: str) -> dict[str, Any] | None:
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT s.id, s.status, s.error, s.request, s.created_at, r.result
                FROM submissions s
                LEFT JOIN benchmark_results r ON r.submission_id = s.id
                WHERE s.id = %s
                """,
                (submission_id,),
            ).fetchone()
        if row is None:
            return None
        return {
            "submission_id": str(row[0]),
            "status": row[1],
            "request": self._decode(row[3]),
            "created_at": row[4],
            "result": self._decode(row[5]),
            "error": row[2],
        }

    def get_share(self, short_id: str) -> dict[str, Any] | None:
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT s.id, s.status, s.request, s.created_at, r.result
                FROM submissions s
                LEFT JOIN benchmark_results r ON r.submission_id = s.id
                WHERE s.request->>'short_id' = %s
                """,
                (short_id,),
            ).fetchone()
        if row is None:
            return None
        request = self._decode(row[2]) or {}
        return {
            "short_id": short_id,
            "submission_id": str(row[0]),
            "challenge_slug": request.get("challenge_slug"),
            "language": request.get("language"),
            "device": request.get("device"),
            "created_at": row[3].isoformat() if isinstance(row[3], datetime) else str(row[3]),
            "result": self._decode(row[4]),
        }

    def short_id_exists(self, short_id: str) -> bool:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT 1 FROM submissions WHERE request->>'short_id' = %s LIMIT 1",
                (short_id,),
            ).fetchone()
        return row is not None

    def acquire_lock(self, submission_id: str) -> bool:
        if self._lock_connection is not None:
            return False
        import psycopg

        connection = psycopg.connect(self._database_url, autocommit=True)
        try:
            row = connection.execute(
                "SELECT pg_try_advisory_lock(hashtextextended(%s, 0))",
                (submission_id,),
            ).fetchone()
        except Exception:
            connection.close()
            raise
        if not row or not row[0]:
            connection.close()
            return False
        self._lock_connection = connection
        self._lock_id = submission_id
        return True

    def release_lock(self, submission_id: str | None) -> None:
        if self._lock_connection is None or self._lock_id != submission_id:
            return
        try:
            self._lock_connection.execute(
                "SELECT pg_advisory_unlock(hashtextextended(%s, 0))",
                (submission_id,),
            )
        finally:
            self._lock_connection.close()
            self._lock_connection = None
            self._lock_id = None
