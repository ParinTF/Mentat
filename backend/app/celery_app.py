from __future__ import annotations

from celery import Celery

from .config import settings

current_settings = settings()
celery_app = Celery("kernelforge", broker=current_settings.redis_url)
celery_app.conf.update(
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    worker_concurrency=current_settings.concurrency,
    task_default_queue="kernelforge",
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    broker_connection_retry_on_startup=True,
    beat_schedule={
        "publish-worker-capabilities": {
            "task": "kernelforge.publish_capabilities",
            "schedule": 60.0,
        }
    },
)
