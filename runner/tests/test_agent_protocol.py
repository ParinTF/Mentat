from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / "agent.py"
SPEC = importlib.util.spec_from_file_location("kernelforge_agent", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent)


def request(mode: str = "protocol") -> dict[str, object]:
    return {
        "workload_mode": mode,
        "workload": {"flops": 1000, "bytes_transferred": 8000},
    }


def test_protocol_metadata_is_bounded_and_output_is_required() -> None:
    flops, byte_count, ignored = agent.extract_metadata(
        {"output": 1.0, "flops": 1000, "bytes": 8000},
        request(),
    )
    assert (flops, byte_count, ignored) == (1000, 8000, False)
    with pytest.raises(agent.AgentError):
        agent.extract_metadata({"flops": 1000, "bytes": 8000}, request())
    with pytest.raises(agent.MetadataError):
        agent.extract_metadata({"output": 1.0, "flops": agent.MAX_SAFE_INTEGER + 1, "bytes": 0}, request())


def test_declared_mode_uses_request_and_ignores_returned_metadata() -> None:
    flops, byte_count, ignored = agent.extract_metadata(
        {"output": 1.0, "flops": 1, "bytes": 1},
        request("declared"),
    )
    assert (flops, byte_count, ignored) == (1000, 8000, False)


def test_output_reduction_is_finite_and_bounded() -> None:
    reduced = agent.reduce_output({"output": list(range(1000))})
    assert reduced["count"] == 1000
    assert len(reduced["sample"]) == agent.SAMPLE_LIMIT
    assert reduced["sum"] == 499500
    with pytest.raises(agent.AgentError):
        agent.reduce_output({"output": float("nan")})


def test_cli_emits_missing_metadata_error_code(tmp_path, monkeypatch, capsys) -> None:
    request_path = tmp_path / "request.json"
    request_path.write_text(json.dumps(request()), encoding="utf-8")

    def fail(current, role, module_path):
        raise agent.MetadataError("flops missing")

    monkeypatch.setattr(agent, "run_role", fail)
    exit_code = agent.main([
        "--request", str(request_path),
        "--role", "submission",
        "--module", str(tmp_path / "submission.py"),
        "--output", str(tmp_path / "output"),
        "--wall-clock", "2",
    ])
    output = capsys.readouterr().out.strip().splitlines()[-1]
    payload = json.loads(output.removeprefix(agent.SENTINEL).strip())
    assert exit_code == 3
    assert payload["error"]["code"] == "missing_workload_metadata"
