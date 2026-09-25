from __future__ import annotations

import asyncio
import json
import secrets
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Callable

from fastapi import FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .capabilities import supports, unavailable_capabilities
from .capability_registry import RedisCapabilityRegistry
from .config import MAX_CODE_BYTES, Settings, settings
from .events import EventPublisher, error_payload, status_payload
from .queue import CeleryTaskQueue
from .schemas import SubmissionAccepted, SubmissionRequest, SubmissionSnapshotResponse, ShareSnapshot, normalise_request
from .shortid import generate
from .store import PostgresStore, ShortIdCollision


class RequestBodyLimitMiddleware:
    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") != "POST":
            await self.app(scope, receive, send)
            return
        headers = {key.decode().lower(): value.decode() for key, value in scope.get("headers", [])}
        content_length = headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > self.max_bytes:
                    response = JSONResponse(status_code=413, content={"detail": "Body too large"})
                    await response(scope, receive, send)
                    return
            except ValueError:
                response = JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})
                await response(scope, receive, send)
                return
        received = 0

        async def limited_receive() -> dict[str, Any]:
            nonlocal received
            message = await receive()
            if message.get("type") == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise RequestBodyTooLarge()
            return message

        try:
            await self.app(scope, limited_receive, send)
        except RequestBodyTooLarge:
            response = JSONResponse(status_code=413, content={"detail": "Body too large"})
            await response(scope, receive, send)


class RequestBodyTooLarge(Exception):
    pass


@dataclass
class AppServices:
    store: Any
    journal: Any
    task_queue: Any
    capability_registry: Any
    capability_provider: Callable[[], dict[str, Any]]


def _default_services(current: Settings) -> AppServices:
    store = PostgresStore(current.database_url)
    journal = EventPublisher(current.redis_url)
    task_queue = CeleryTaskQueue()
    registry = RedisCapabilityRegistry(current.redis_url)

    def capabilities() -> dict[str, Any]:
        value = registry.get()
        return value if value is not None else unavailable_capabilities(current)

    return AppServices(store, journal, task_queue, registry, capabilities)


def _close(services: AppServices) -> None:
    for dependency in (services.store, services.journal, services.capability_registry):
        close = getattr(dependency, "close", None)
        if callable(close):
            close()


def create_app(
    current: Settings | None = None,
    services: AppServices | None = None,
) -> FastAPI:
    active_settings = current or settings()
    active_services = services or _default_services(active_settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        _close(active_services)

    app = FastAPI(title="KernelForge API", version="0.1.0", lifespan=lifespan)
    app.state.services = active_services
    app.state.settings = active_settings
    app.add_middleware(RequestBodyLimitMiddleware, max_bytes=MAX_CODE_BYTES + 8192)
    if active_settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(active_settings.cors_origins),
            allow_credentials=False,
            allow_methods=["GET", "POST"],
            allow_headers=["Content-Type", "X-KernelForge-Token"],
        )

    @app.get("/api/v1/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "mode": active_settings.mode}

    @app.get("/api/v1/capabilities")
    def capabilities() -> dict[str, Any]:
        return active_services.capability_provider()

    @app.post("/api/v1/submissions", response_model=SubmissionAccepted, status_code=202)
    def create_submission(
        submission: SubmissionRequest,
        run_token: str | None = Header(default=None, alias="X-KernelForge-Token"),
    ) -> dict[str, Any]:
        if active_settings.run_token is not None and (
            run_token is None or not secrets.compare_digest(run_token, active_settings.run_token)
        ):
            raise HTTPException(status_code=401, detail={"code": "run_token_required"})
        if submission.challenge_slug is not None:
            raise HTTPException(status_code=404, detail={"code": "unknown_challenge"})
        capability = active_services.capability_provider()
        if submission.language == "triton" and not capability.get("devices", {}).get("cuda", False):
            raise HTTPException(status_code=422, detail={"code": "unsupported_device", "message": "CUDA is unavailable"})
        allowed, reason = supports(capability, submission.device, submission.language)
        if not allowed:
            raise HTTPException(
                status_code=422,
                detail={"code": reason, "message": f"{submission.language}/{submission.device} is unavailable"},
            )
        request = normalise_request(submission)
        snapshot = None
        for _ in range(5):
            try:
                snapshot = active_services.store.create_submission(request, generate())
                break
            except ShortIdCollision:
                continue
        if snapshot is None:
            raise HTTPException(status_code=503, detail={"code": "short_id_exhausted"})
        submission_id = snapshot["submission_id"]
        try:
            active_services.journal.emit(
                submission_id,
                "status",
                status_payload("queued"),
                event_key="status:queued",
            )
            active_services.task_queue.enqueue(submission_id)
        except Exception as error:
            public_message = "gateway infrastructure is unavailable"
            active_services.store.set_status(submission_id, "failed", public_message)
            try:
                active_services.journal.emit(
                    submission_id,
                    "error",
                    error_payload("infrastructure_error", public_message),
                    event_key="error:terminal",
                )
                active_services.journal.emit(
                    submission_id,
                    "status",
                    status_payload("failed"),
                    event_key="status:failed",
                )
            except Exception:
                pass
            raise HTTPException(
                status_code=503,
                detail={"code": "infrastructure_error", "message": public_message},
            ) from error
        return {
            "submission_id": submission_id,
            "status": "queued",
            "websocket_url": f"/api/v1/submissions/{submission_id}/events?after=0",
            "mode": active_settings.mode,
        }

    @app.get("/api/v1/submissions/{submission_id}", response_model=SubmissionSnapshotResponse)
    def get_submission(submission_id: str) -> dict[str, Any]:
        snapshot = active_services.store.get_submission(submission_id)
        if snapshot is None:
            raise HTTPException(status_code=404, detail="Not found")
        return {
            "submission_id": snapshot["submission_id"],
            "status": snapshot["status"],
            "mode": active_settings.mode,
            "result": snapshot.get("result"),
            "error": snapshot.get("error"),
        }

    @app.get("/api/v1/s/{short_id}", response_model=ShareSnapshot)
    def get_share(short_id: str) -> dict[str, Any]:
        snapshot = active_services.store.get_share(short_id)
        if snapshot is None:
            raise HTTPException(status_code=404, detail="Not found")
        return snapshot

    @app.websocket("/api/v1/submissions/{submission_id}/events")
    async def submission_events(websocket: WebSocket, submission_id: str, after: str = Query(default="0")) -> None:
        await websocket.accept()
        try:
            cursor = int(after)
        except ValueError:
            await websocket.close(code=4400, reason="invalid cursor")
            return
        if cursor < 0:
            await websocket.close(code=4400, reason="invalid cursor")
            return
        snapshot = await asyncio.to_thread(active_services.store.get_submission, submission_id)
        if snapshot is None:
            await websocket.close(code=4404, reason="submission not found")
            return
        pubsub = await asyncio.to_thread(active_services.journal.subscribe, submission_id)
        cursor_now = cursor
        terminal = False
        initial_events = await asyncio.to_thread(active_services.journal.replay, submission_id, cursor_now)
        terminal_statuses = {"completed", "failed", "timed_out"}
        has_terminal_event = any(
            event.get("type") == "status" and event.get("payload", {}).get("status") in terminal_statuses
            for event in initial_events
        )
        has_result_event = any(event.get("type") == "result" for event in initial_events)
        if snapshot["status"] in terminal_statuses and (not has_terminal_event or (snapshot["status"] == "completed" and not has_result_event)):
            close = getattr(pubsub, "close", None)
            if callable(close):
                close()
            await websocket.close(code=4409, reason="replay history unavailable")
            return
        try:
            for event in initial_events:
                sequence = int(event.get("sequence", 0))
                if sequence <= cursor_now:
                    continue
                await websocket.send_json(event)
                cursor_now = sequence
                if event.get("type") == "status" and event.get("payload", {}).get("status") in {"completed", "failed", "timed_out"}:
                    terminal = True
                    break
            while not terminal:
                message = await asyncio.to_thread(
                    pubsub.get_message,
                    ignore_subscribe_messages=True,
                    timeout=15.0,
                )
                if message is None:
                    heartbeat = await asyncio.to_thread(active_services.journal.heartbeat, submission_id)
                    await websocket.send_json(heartbeat)
                    continue
                raw = message.get("data") if isinstance(message, dict) else None
                if not isinstance(raw, str):
                    continue
                event = json.loads(raw)
                sequence = int(event.get("sequence", 0))
                if sequence <= cursor_now:
                    continue
                await websocket.send_json(event)
                cursor_now = sequence
                if event.get("type") == "status" and event.get("payload", {}).get("status") in {"completed", "failed", "timed_out"}:
                    terminal = True
        except WebSocketDisconnect:
            return
        finally:
            close = getattr(pubsub, "close", None)
            if callable(close):
                close()

    return app


app = create_app()
