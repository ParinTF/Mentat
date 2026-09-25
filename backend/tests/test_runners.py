from __future__ import annotations

import io
import json

from backend.app import runners
from backend.app.config import Settings
from backend.app.runners import agent_command, container_flags, parse_agent_output, prepare_workspace


def settings() -> Settings:
    return Settings(
        database_url="",
        redis_url="",
        run_token=None,
        mode="sandbox",
        concurrency=1,
        max_container_seconds=5,
        max_log_bytes=65_536,
        runner_image_cpu="runner:test",
        runner_image_cuda="",
        docker_host=None,
        runner_input_root="",
        runner_input_volume="runner-input",
        cors_origins=(),
    )


def test_runner_command_has_isolation_and_per_submission_input(tmp_path) -> None:
    first = prepare_workspace(tmp_path, "submission-a", {"code": "a"}, "a")
    second = prepare_workspace(tmp_path, "submission-b", {"code": "b"}, "b")
    assert first != second
    assert (first / "submission.py").read_text(encoding="utf-8") == "a"
    assert (second / "submission.py").read_text(encoding="utf-8") == "b"
    flags = container_flags(settings(), "kf-test")
    assert "--network" in flags
    assert flags[flags.index("--network") + 1] == "none"
    assert "--read-only" in flags
    assert "--cap-drop" in flags
    assert agent_command("submission", "/input/submission-a/submission.py", 5, "/input/submission-a")[3] == "/input/submission-a/request.json"


def test_run_agent_rewrites_paths_after_mounting_a_volume_subpath(monkeypatch) -> None:
    captured = {}

    class FakeProcess:
        def __init__(self, command, stdout, stderr):
            captured["command"] = command
            self.stdout = io.BytesIO(b'__KF_RESULT__ {"ok":true,"measurement":{"samples_ms":[1]}}\n')
            self.stderr = io.BytesIO(b"")

        def wait(self, timeout):
            return 0

        def kill(self):
            return None

    monkeypatch.setattr(runners.shutil, "which", lambda name: "/usr/bin/docker")
    monkeypatch.setattr(runners.subprocess, "Popen", FakeProcess)
    result = runners.run_agent(settings(), "submission", "/input/submission-a/submission.py", "runner:test", "/input/submission-a")
    command = captured["command"]
    assert any("volume-subpath=submission-a" in argument for argument in command)
    assert "--request" in command
    assert command[command.index("--request") + 1] == "/input/request.json"
    assert command[command.index("--module") + 1] == "/input/submission.py"
    assert result["measurement"]["samples_ms"] == [1]


def test_agent_parser_uses_the_last_sentinel() -> None:
    stdout = "noise\n__KF_RESULT__ {\"ok\":false}\nmore\n__KF_RESULT__ {\"ok\":true}"
    assert parse_agent_output(stdout) == {"ok": True}
    assert parse_agent_output("no result") is None
