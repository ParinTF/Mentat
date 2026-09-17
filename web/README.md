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
| Execution | **Local simulation only.** The submitted code is never executed, no container, no GPU |
| Hardware peaks | User-entered **specifications**, never auto-detected |
| PCIe transfer time / challenge pass | Not implemented (`null` / `n/a`) |

The simulated latency is
`max(FLOPs / peak_compute, bytes / peak_bandwidth) / assumed_efficiency`, where
efficiency is 0.62 (cuda) or 0.38 (cpu) with deterministic +/-6% jitter seeded
from the source text. Every payload is labelled `timing: simulation`,
`workload: user_estimate`, `movement: simulation`.

## Wiring a real backend

`lib/transport.ts` exposes `KernelTransport`. Add a WebSocket implementation that
connects to `/api/v1/submissions/{id}/events` and pass it to `Playground` in place
of `LocalSimulationTransport`; the UI consumes the same event union, so no
component changes are required. Until the gateway, worker and Docker sandbox from
step 2 exist, results stay honest by staying simulated.

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
