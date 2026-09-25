"""PostgreSQL persistence, using the schema in db/001_initial.sql plus
db/002_short_id.sql. Connections are lazy and never opened at import time."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from .config import Settings, settings


class Repository:
    def __init__(self, database_url: str | None = None) -> None:
        self._database_url = database_url or settings().database_url
        self._connection: Any = None

    def _connect(self) -> Any:
        if self._connection is None:
            import psycopg

            self._connection = psycopg.connect(self._database_url, autocommit=True)
        return self._connection

    def close(self) -> None:
        if self._connection is not None:
            self._connection.close()
            self._connection = None

    def insert_submission(self, request: dict[str, Any], short_id: str) -> str:
        submission_id = str(uuid.uuid4())
        self._connect().execute(
            """
            INSERT INTO submissions (id, user_id, challenge_id, code, language, status, created_at, request, error)
            VALUES (%s, NULL, NULL, %s, %s, 'queued', %s, %s, NULL)
            """,
            (
                submission_id,
                request["code"],
                request["language"],
                datetime.now(timezone.utc),
                json.dumps(request),
            ),
        )
        self._connect().execute(
            "UPDATE submissions SET request = request || %s::jsonb WHERE id = %s",
            (json.dumps({"short_id": short_id}), submission_id),
        )
        return submission_id

    def set_status(self, submission_id: str, status: str, error: str | None = None) -> None:
        self._connect().execute(
            "UPDATE submissions SET status = %s, error = %s WHERE id = %s",
            (status, error, submission_id),
        )

    def save_result(self, submission_id: str, result: dict[str, Any]) -> None:
        self._connect().execute(
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
                json.dumps(result),
            ),
        )

    def get_submission(self, submission_id: str) -> dict[str, Any] | None:
        row = self._connect().execute(
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
        request = row[3] if isinstance(row[3], dict) else json.loads(row[3])
        result = row[5] if isinstance(row[5], dict) else (json.loads(row[5]) if row[5] else None)
        return {
            "submission_id": str(row[0]),
            "status": row[1],
            "error": row[2],
            "request": request,
            "created_at": row[4].isoformat() if row[4] else None,
            "result": result,
        }

    def get_by_short_id(self, short_id: str) -> dict[str, Any] | None:
        row = self._connect().execute(
            """
            SELECT s.id, s.status, s.request, s.created_at, r.result, s.code, s.language
            FROM submissions s
            LEFT JOIN benchmark_results r ON r.submission_id = s.id
            WHERE s.request->>'short_id' = %s
            """,
            (short_id,),
        ).fetchone()
        if row is None:
            return None
        request = row[2] if isinstance(row[2], dict) else json.loads(row[2])
        result = row[4] if isinstance(row[4], dict) else (json.loads(row[4]) if row[4] else None)
        return {
            "submission_id": str(row[0]),
            "status": row[1],
            "request": request,
            "created_at": row[3].isoformat() if row[3] else None,
            "result": result,
            "code": row[5],
            "language": row[6],
        }

    def short_id_exists(self, short_id: str) -> bool:
        row = self._connect().execute(
            "SELECT 1 FROM submissions WHERE request->>'short_id' = %s LIMIT 1",
            (short_id,),
        ).fetchone()
        return row is not None
