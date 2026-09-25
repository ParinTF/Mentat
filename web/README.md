# KernelForge Playground (Next.js)

Split-screen micro-benchmark playground: Monaco editor on the left, data-movement
pipeline and roofline analysis on the right.

```bash
npm install          # from this folder
npm run dev          # http://localhost:3000
npm run build && npm start
npm run typecheck
```

Root shortcuts: `npm run dev`, `npm run build`, `npm start`, `npm run typecheck`.

## What is real and what is simulated

| Piece | Status |
| --- | --- |
| Formulas (AI, bandwidth, TFLOP/s, roofline bound, ridge point) | Real implementation in `lib/roofline.ts`, unit tested for parity against `../demo/metrics.mjs` |
| Event envelope (status/log/trace/result/error/heartbeat) | Matches `contracts/API.md`, emitted by `lib/transport.ts` |
| Monaco editor | Real (Python grammar; PyTorch and Triton reuse it) |
| Data-movement visualizer | Real SVG animation, but the progress values are **synthetic** - no counters are read |
| Roofline chart | Real Recharts log-log plot; the marker is a **model** operating point |
| Execution | Local simulation by default; isolated measured Python/PyTorch CPU execution when `NEXT_PUBLIC_KF_API` points to a sandbox gateway |
| Hardware peaks | User-entered **specifications**; the worker reports its own CPU/OS capability snapshot |
| PCIe transfer time / challenge pass | Not implemented (`null` / `n/a`) |

The simulated latency is
`max(FLOPs / peak_compute, bytes / peak_bandwidth) / assumed_efficiency`, where
efficiency is 0.62 (cuda) or 0.38 (cpu) with deterministic +/-6% jitter seeded
from the source text. Every payload is labelled `timing: simulation`,
`workload: user_estimate`, `movement: simulation`.

## Backend execution

Set `NEXT_PUBLIC_KF_API` to the gateway origin, without `/api/v1`:

```bash
NEXT_PUBLIC_KF_API=http://localhost:8000 npm run dev
```

`lib/api.ts` owns HTTP calls and runtime response validation. `lib/gateway-transport.ts`
implements the same `KernelTransport` seam as `LocalSimulationTransport`: it submits work,
connects to the event WebSocket, suppresses duplicate cursors, reconnects with `after`, and
falls back to the submission snapshot when replay history is missing. The Playground uses
the gateway only when the worker reports a sandbox capability for the selected language and
device; otherwise it remains in honest local-simulation mode.

## Notes and limitations

- Monaco is fetched from jsDelivr on first load. If that fails (offline), the
  editor degrades to a plain textarea and says so.
- `device=cpu` marks the PCIe and VRAM stages as "not used on CPU".
- Tailwind v4, Next 16 (App Router), React 19, TypeScript 7-compatible syntax
  (`erasableSyntaxOnly`, `verbatimModuleSyntax`) so `web/lib/*.ts` is importable
  by `node --test`.
- On this machine Turbopack required a repaired `@next/swc-win32-x64-msvc`
  install (the npm cache had a corrupt tarball). If `next build` reports
  "Turbopack is not supported on this platform", reinstall that package with
  `npm install @next/swc-win32-x64-msvc --prefer-online --cache <fresh-dir>` or
  build with `next build --webpack`.
