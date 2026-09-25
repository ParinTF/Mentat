from __future__ import annotations

from .celery_app import celery_app


class CeleryTaskQueue:
    def enqueue(self, submission_id: str) -> None:
        celery_app.send_task(
            "kernelforge.run_submission",
            kwargs={"submission_id": submission_id},
            task_id=f"kf:{submission_id}",
            ignore_result=True,
        )
