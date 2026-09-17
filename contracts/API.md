# KernelForge API contract (v2, decisions A–F locked)

## Locked decisions (2026-09-17)

| Area | Decision |
| --- | --- |
| Environment | Dual mode: `simulation` default on Windows dev, `sandbox` when a remote Linux/GPU worker joins the same Redis queue |
| Default GPU preset | NVIDIA T4 (16 GB, ~8.1 TFLOP/s fp32, ~320 GB/s) because it matches free Colab hardware; A100-class and CPU-socket presets selectable |
| Runner images | CPU: `python:3.12-slim` + CPU PyTorch, no Triton. CUDA: pinned `pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime` |
| GPU isolation | Docker limits only; single-user, concurrency = 1, non-root, read-only rootfs, `--network none`. No microVM in this phase |
| Metric source | Protocol contract: `benchmark()` returns `{"output":..., "flops": int, "bytes": int}`. Challenge runs use server-side theoretical FLOPs/bytes instead. Free-form declared numbers stay labelled `user_estimate` |
| Timing | CUDA events + `torch.cuda.synchronize()` when CUDA is present, `time.perf_counter()` otherwise; warmup discarded; median of repetitions |
| Roofline granularity | One point per submission (no per-kernel timeline) |
| Backend | FastAPI + Pydantic + Celery + Redis (broker + replay) + PostgreSQL, all in one `compose.yaml` |
| Pass criteria | Two stages: correctness `torch.allclose(user, baseline, atol=1e-3, rtol=1e-3)` first, then the challenge's performance condition. Wrong output fails regardless of speed |
| Baselines | Python files under `challenges/baselines/`, run in the same container as the user kernel |
| Frontend | Playground first (Godbolt-like) + side panel for challenge list / concept tree; schematic visualizer |
| Auth | None in MVP. History in `localStorage`; runs gated by `KF_RUN_TOKEN` when exposed publicly, reads stay open |
| Share | 8-char Crockford base32 `short_id` per submission → `GET /api/v1/s/{short_id}` |
| Retention | Indefinite, no TTL for code and results |

**Supersedes** the older statements further down that say: challenge evaluation is not implemented, `passed` is always null, and workload is always `user_estimate`.

---
# KernelForge v1 contracts

## Trust and scope
Browser → FastAPI → Redis/Celery → disposable Docker runner. PostgreSQL stores submissions/results. Node demo is a separate explicitly simulated transport and NEVER executes code. Single-user, loopback-only MVP; public deployment requires authentication, per-owner HTTP/WS authorization, TLS, quotas and admission control.

Python, PyTorch and Triton use `setup()` (optional) and `benchmark()` (required). Runner imports code, calls setup once, warms up, then times repetitions. Triton requires CUDA. `cpp` is reserved and rejected (422) in this milestone.

FLOPs/bytes are user estimates, NOT automatically inferred physical counters. Timing measures synchronized end-to-end benchmark calls, not necessarily a single kernel. Memory animation is illustrative. Hardware peaks are specifications. Self-reported results must not establish challenge passes.

## HTTP base /api/v1
- GET /health → `{status:"ok",mode:"sandbox"|"simulation"}` (liveness only).
- GET /capabilities → probed at worker start, never guessed:
  `{mode, devices:{cpu:true,cuda:false}, languages:{python:true,pytorch:true,triton:false}, limits:{max_code_bytes,max_repetitions,wall_time_s}, host:{os,arch,cpu_cores,memory_gb}}`.
  `cuda` is true only when the runtime can actually expose a device; `triton` mirrors it.
- POST /submissions → 202 `{submission_id,status:"queued",websocket_url,mode}`.
- GET /submissions/{id} → `{submission_id,status,mode,result:BenchmarkResult|null,error:string|null}`; unknown id 404.
- GET /s/{short_id} → public share snapshot `{short_id,submission_id,challenge_slug,language,device,created_at,result}`; unknown 404. Read-only, never exposes container internals.
- POST /submissions requires header `X-KernelForge-Token` only when the server runs with `KF_RUN_TOKEN` set (public portfolio mode); mismatch → 401 `{detail:{code:"run_token_required"}}`. Read endpoints never require auth.
- WS /submissions/{id}/events?after=0 → events after the last received sequence. Ignore duplicate sequences. Heartbeats sequence 0 are not persisted. Replay bounded to 1000 events / 1 hour; missing history requires GET snapshot. Unknown id closes 4404, bad cursor 4400.
- Errors: `{detail:string|array|{code,message}}`. No server tracebacks returned. Requests for `device=cuda` or `language=triton` are rejected with 422 `{detail:{code:"unsupported_device",message}}` when `/capabilities` reports no CUDA, so unsupported work never occupies the queue.

### Submission request
```json
{"code":"def benchmark():\n    return {\"output\": 1.0, \"flops\": 1000, \"bytes\": 8000}\n","language":"python","device":"cpu","warmup":3,"repetitions":10,"workload_mode":"protocol","workload":{"flops":1000,"bytes_transferred":8000},"hardware":{"name":"NVIDIA T4 (nominal)","peak_compute_tflops":8.1,"peak_bandwidth_gbps":320},"challenge_slug":null}
```

`workload_mode` decides where FLOPs and bytes come from:
- `protocol` (default): values come from the object returned by `benchmark()`. Missing, non-integer or negative values fail with `error.code = "missing_workload_metadata"`.
- `declared`: values come from `request.workload` and are reported as `user_estimate`. Intended for quick experiments with uninstrumented code.
- `challenge_theory`: only valid with `challenge_slug`; the server computes FLOPs and bytes from the challenge theory. Any values returned by the kernel are ignored and reported as `ignored_metadata: true`.

`benchmark()` must return a mapping with an `output` key (any JSON-serialisable value, or a list/tensor that the agent reduces for comparison). `setup()` is optional and runs once.

Limits: UTF-8 code 1..65536 bytes; language python|pytorch|triton; device cpu|cuda; warmup 0..10 (default 3, enforced 3 for challenges); repetitions 1..100 (default 10, enforced 10 for challenges); workload integers 0..9007199254740991; finite positive peaks <=1000000; hardware name 1..120 chars; `challenge_slug` null or `^[a-z0-9-]{3,64}$`. Unknown fields rejected. Triton requires cuda. `challenge_slug` must exist in `challenges/manifest.json`, else 404 `{detail:{code:"unknown_challenge"}}`.

Statuses: queued → compiling → running → completed|failed|timed_out. Failure/timeout may occur from any nonterminal state. compiling means preparation/import, not proof of compiler activity.

### BenchmarkResult (v2)
```json
{"short_id":"8K4QZ2M7","latency_ms":1.2,"memory_throughput_gbps":0.006666666666666667,"compute_tflops":0.0000008333333333333334,"arithmetic_intensity":0.125,"attainable_tflops":0.0625,"bottleneck":"memory","workload_source":"protocol","ignored_metadata":false,"pcie_transfer_ms":null,"passed":null,"correctness":{"checked":true,"passed":true,"max_abs_error":1.2e-07,"atol":0.001,"rtol":0.001},"baseline":null,"provenance":{"timing":"measured","workload":"protocol","movement":"derived"},"hardware":{"name":"NVIDIA T4 (nominal)","peak_compute_tflops":8.1,"peak_bandwidth_gbps":320},"samples_ms":[1.2]}
```

`latency_ms` is the median of synchronized samples (CUDA events where available, otherwise `perf_counter`). `bottleneck` is `memory` when `arithmetic_intensity < ridge_point` and `compute` otherwise; it drives the visualizer highlight and is **derived from the roofline position, not from a counter reading**. `pcie_transfer_ms` stays null unless the kernel performs pinned-memory host↔device transfers that the agent times separately. `correctness.checked` is true only when a baseline output was compared. `baseline` is `{name, latency_ms, speedup}` with speedup = baseline_median / user_median, or null. `passed` is null when no challenge was supplied, otherwise the two-stage verdict from the challenge section.

All numbers finite and time > 0. AI = FLOPs/bytes (null when bytes = 0, which also nulls AI-dependent fields). Bandwidth GB/s = bytes/seconds/1e9. Compute TFLOP/s = FLOPs/seconds/1e12. Attainable TFLOP/s = min(peak_compute_tflops, peak_bandwidth_gbps*AI/1000). Decimal SI units. `provenance.timing` is `measured|simulation`, `provenance.workload` is `protocol|challenge_theory|user_estimate`, `provenance.movement` is `derived|illustrative|simulation`.

### WebSocket envelope
```json
{"version":1,"submission_id":"UUID","sequence":1,"timestamp":"2026-09-17T12:00:00.000Z","type":"status","payload":{"status":"queued"}}
```
Types:
- status: `{status}`
- log: `{stream:"stdout"|"stderr"|"system",text:string}` (max 4096 chars each, bounded total; render as text).
- trace: `{source:"measured"|"illustrative"|"simulation", stage:"host_ram"|"pcie"|"vram"|"sram"|"cores", progress:number, bottleneck?:"memory"|"compute"}`; progress in [0,1] and is **not** a utilization counter. In sandbox mode the final trace event carries the derived `bottleneck` so the visualizer highlights the binding roof; stages never visited on the declared device are marked inactive.
- result: BenchmarkResult, before completed status.
- error: `{code:"execution_error"|"timeout"|"infrastructure_error",message:string}`, followed by terminal status.
- heartbeat: `{}`, sequence 0.
Clients validate events and recover terminal snapshots on reconnect.

## Runner boundary
Worker writes request.json and submission.py into a temporary directory mounted read-only at /input. Trusted agent baked into image imports code in the SAME untrusted process and writes result JSON to stdout. Malicious code can forge outputs: shape validation is NOT measurement attestation. Informational results only, no trusted leaderboard.

Container: no network, nonroot, read-only root, drop all capabilities, no-new-privileges, bounded memory/CPU/PIDs/tmpfs/output/wall time, default seccomp. Never mount Docker socket in runner. Only dedicated worker host accesses Docker. Never execute submissions on host Python. Docker alone is insufficient for hostile public multi-tenancy: hardened VM isolation, patched GPU drivers and dedicated GPU scheduling are needed. Docker memory quotas do NOT bound GPU VRAM.

The worker creates containers from `/capabilities`, so a CPU-only host never queues CUDA work. The development host for this repository is a CPU-only Windows 11 laptop (Intel Iris Xe, no NVIDIA device): CPU execution can be genuinely `measured`, CUDA/Triton cannot run there at all. Setup and verification steps live in `docs/SETUP-WINDOWS.md` and `runner/check-env.ps1`.
## Challenge evaluation (v2)

Baselines and starters are files in the repository, not blobs in Postgres, so they can be unit tested and versioned. `challenges/manifest.json`:

```json
[{"slug":"vector-add-1m","title":"Coalesced vector add","concept":"memory-coalescing","language":"pytorch","device":"cuda",
  "baseline":"challenges/baselines/vector_add_torch.py","starter":"challenges/starters/vector_add_torch.py",
  "theory":"vector_add","theory_params":{"n":1048576},"target_metric":"speedup","threshold":1.5}]
```

Theory functions compute FLOPs and bytes server-side so a challenge can never be passed with invented numbers. Initial set: `vector_add` (1 FLOP per element, 3 arrays read+write => `3*n*itemsize` bytes), `matmul` (`2*n**3` FLOPs, `3*n*n*itemsize` bytes), `reduction` (`n-1` FLOPs, `n*itemsize` bytes), `softmax_rows` (`5*n` FLOPs, `2*n*itemsize` bytes). `itemsize` comes from the declared dtype (default 4 for fp32).

Two stages, evaluated in this order:

1. **Correctness (mandatory).** The baseline runs first in the same container to cancel hardware drift, then the user kernel. Comparison uses `torch.allclose(user_out, baseline_out, atol=1e-3, rtol=1e-3)` (NumPy fallback when Torch is absent). Failure yields `correctness.passed = false`, `passed = false`, and no performance verdict.
2. **Performance.** `target_metric` is one of `speedup` (`baseline_median / user_median >= threshold`), `bandwidth_efficiency` (`memory_throughput_gbps / peak_bandwidth_gbps >= threshold`), or `compute_efficiency` (`compute_tflops / attainable_tflops >= threshold`). `passed = correctness.passed and performance_condition`.

Guardrails: challenge submissions force `workload_mode = challenge_theory` (declared numbers are ignored and flagged `ignored_metadata = true`); warmup is forced to 3 and repetitions to 10; a crash or timeout yields `passed = false` plus an `error` event, never a silent pass.

## Storage and privacy (v2)

- No TTL. `submissions` and `benchmark_results` are kept indefinitely as a comparison corpus; `short_id` is unique.
- The MVP has no authentication, so `user_id` stays null. Local history lives in browser `localStorage`.
- Public deployment: set `KF_RUN_TOKEN` (write endpoints), keep Postgres/Redis reachable only on the compose network, and never expose the Docker socket outside the worker.
- Deleting a submission is a manual operation on the database in this phase; there is no user-facing delete until auth exists.
