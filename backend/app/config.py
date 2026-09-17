"""Environment-driven settings. Reading environment variables is the only
import-time side effect; nothing connects to Postgres, Redis or Docker."""

from __future__ import annotations

import os
from dataclasses import dataclass

MAX_CODE_BYTES = 65536
MAX_REPETITIONS = 100
MAX_WARMUP = 10
MAX_PEAK = 1_000_000.0
MAX_CONTAINER_SECONDS = 60
MAX_LOG_BYTES = 65_536
DEFAULT_ATOL = 1e-3
DEFAULT_RTOL = 1e-3
CHALLENGE_WARMUP = 3
CHALLENGE_REPETITIONS = 10


def _env(name: str, default: str) -> str:
    value = os.environ.get(name, "")
    return value if value else default


@dataclass(frozen=True)
class Settings:
    database_url: str
    redis_url: str
    run_token: str | None
    mode: str
    concurrency: int
    max_container_seconds: int
    max_log_bytes: int
    runner_image_cpu: str
    runner_image_cuda: str
    docker_host: str | None

    @staticmethod
    def from_env() -> "Settings":
        token = os.environ.get("KF_RUN_TOKEN", "").strip() or None
        mode = _env("KF_MODE", "simulation")
        if mode not in {"simulation", "sandbox"}:
            raise RuntimeError(f"KF_MODE must be simulation or sandbox, got {mode!r}")
        return Settings(
            database_url=_env("KF_DATABASE_URL", "postgresql://kernelforge:kernelforge@localhost:5432/kernelforge"),
            redis_url=_env("KF_REDIS_URL", "redis://localhost:6379/0"),
            run_token=token,
            mode=mode,
            concurrency=int(_env("KF_CONCURRENCY", "1")),
            max_container_seconds=int(_env("KF_MAX_CONTAINER_SECONDS", str(MAX_CONTAINER_SECONDS))),
            max_log_bytes=int(_env("KF_MAX_LOG_BYTES", str(MAX_LOG_BYTES))),
            runner_image_cpu=_env("KF_RUNNER_IMAGE_CPU", "kernelforge-runner-cpu:latest"),
            runner_image_cuda=_env("KF_RUNNER_IMAGE_CUDA", "kernelforge-runner-cuda:latest"),
            docker_host=os.environ.get("KF_DOCKER_HOST") or None,
        )


def settings() -> Settings:
    """Fresh settings per call so tests can override the environment."""
    return Settings.from_env()
