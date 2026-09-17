/**
 * Generates shared/metrics.vectors.json from the verified Node implementation.
 *
 * Usage:  node tools/gen-vectors.mjs
 *
 * The fixture is the cross-language contract for the metric formulas: the
 * backend parity test (backend/tests/test_vector_parity.py) asserts that
 * `backend/app/metrics.py` reproduces every value, and tests/vectors.test.mjs
 * asserts the checked-in file still matches this generator (so an accidental
 * drift between reference and fixture is caught, not silently accepted).
 */
import { writeFileSync } from 'node:fs';
import { calculateMetrics, validateSubmission } from '../demo/metrics.mjs';

const T4 = { name: 'NVIDIA T4 (nominal)', peak_compute_tflops: 8.1, peak_bandwidth_gbps: 320 };
const CPU_SOCKET = { name: 'CPU socket class (nominal)', peak_compute_tflops: 0.8, peak_bandwidth_gbps: 60 };

function request(overrides) {
  return {
    code: 'def benchmark():\n    return {"output": 1.0, "flops": 1, "bytes": 1}\n',
    language: 'python',
    device: 'cpu',
    warmup: 3,
    repetitions: 10,
    workload_mode: 'protocol',
    workload: { flops: 1000, bytes_transferred: 8000 },
    hardware: T4,
    challenge_slug: null,
    ...overrides,
  };
}

const cases = [
  {
    name: 't4-vector-add-bandwidth-bound',
    note: 'N=2^20 fp32 vector add on a T4: AI 0.083 FLOP/byte sits below the ridge point',
    request: request({ workload: { flops: 1048576, bytes_transferred: 12582912 } }),
    samples_ms: [0.0393, 0.041, 0.0401],
  },
  {
    name: 't4-matmul-compute-bound',
    note: '1024^3 matmul on a T4: AI ~171 FLOP/byte sits above the ridge point',
    request: request({ language: 'pytorch', device: 'cuda', workload: { flops: 2147483648, bytes_transferred: 12582912 } }),
    samples_ms: [1.05, 1.11, 1.08],
  },
  {
    name: 'zero-bytes-yields-null',
    note: 'Zero transferred bytes must produce null AI, null attainable TFLOP/s and null bottleneck',
    request: request({ workload: { flops: 1000, bytes_transferred: 0 } }),
    samples_ms: [1.2],
  },
  {
    name: 'declared-mode-is-user-estimate',
    note: 'Uninstrumented code: the declared numbers are labelled user_estimate',
    request: request({ workload_mode: 'declared', repetitions: 5 }),
    samples_ms: [2.0, 1.9, 2.2, 2.1, 1.8],
  },
  {
    name: 'challenge-theory-ignores-returned-metadata',
    note: 'Challenge runs compute FLOPs/bytes server side, so returned metadata is flagged as ignored',
    request: request({ workload_mode: 'challenge_theory', challenge_slug: 'vector-add-1m' }),
    samples_ms: [0.42, 0.44, 0.43],
  },
  {
    name: 'cpu-socket-ridge-and-bottleneck',
    note: 'CPU socket class has a ridge point of 13.3 FLOP/byte, so the same AI is still memory bound',
    request: request({ hardware: CPU_SOCKET, workload: { flops: 1048576, bytes_transferred: 12582912 } }),
    samples_ms: [3.1, 3.0, 3.2, 2.9],
  },
  {
    name: 'even-sample-count-uses-midpoint',
    note: 'Even repetition counts average the two central samples',
    request: request({ repetitions: 4 }),
    samples_ms: [4, 1, 2, 3],
  },
  {
    name: 'high-bandwidth-triton-vector-add',
    note: 'N=2^22 fp32 add: 48 MiB in 0.05 ms is ~1007 GB/s, at the T4 memory roof',
    request: request({ language: 'triton', device: 'cuda', workload: { flops: 4194304, bytes_transferred: 50331648 } }),
    samples_ms: [0.05],
  },
];

const tolerance = { relative: 1e-12, absolute: 0 };

for (const testCase of cases) {
  if (!validateSubmission(testCase.request)) {
    throw new Error(`generator produced an invalid request for ${testCase.name}`);
  }
  const result = calculateMetrics(testCase.request, testCase.samples_ms, 'measured');
  testCase.expected = {
    latency_ms: result.latency_ms,
    memory_throughput_gbps: result.memory_throughput_gbps,
    compute_tflops: result.compute_tflops,
    arithmetic_intensity: result.arithmetic_intensity,
    attainable_tflops: result.attainable_tflops,
    bottleneck: result.bottleneck,
    workload_source: result.workload_source,
    ignored_metadata: result.ignored_metadata,
  };
}

const fixture = {
  generated_by: 'tools/gen-vectors.mjs',
  formulas: {
    arithmetic_intensity: 'flops / bytes',
    bandwidth_gbps: 'bytes / (latency_ms / 1000) / 1e9',
    compute_tflops: 'flops / (latency_ms / 1000) / 1e12',
    attainable_tflops: 'min(peak_compute_tflops, peak_bandwidth_gbps * ai / 1000)',
    ridge_point_ai: 'peak_compute_tflops * 1000 / peak_bandwidth_gbps',
    bottleneck: 'ai < ridge_point_ai ? memory : compute',
  },
  tolerance,
  cases,
};

writeFileSync(new URL('../shared/metrics.vectors.json', import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
console.log(`wrote shared/metrics.vectors.json with ${cases.length} cases`);