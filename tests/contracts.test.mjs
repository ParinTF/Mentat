import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMetrics, validateSubmission } from '../demo/metrics.mjs';

export const request = {
  code: 'def benchmark():\n    return {"output": 1.0, "flops": 1000, "bytes": 8000}\n',
  language: 'python', device: 'cpu', warmup: 2, repetitions: 10,
  workload_mode: 'protocol',
  workload: { flops: 1000, bytes_transferred: 8000 },
  hardware: { name: 'Example specification', peak_compute_tflops: 10, peak_bandwidth_gbps: 500 },
  challenge_slug: null,
};
test('valid submission and metric SI units match contract', () => {
  assert.equal(validateSubmission(request), true);
  const result = calculateMetrics(request, [1.2]);
  assert.equal(result.arithmetic_intensity, 0.125);
  assert.ok(Math.abs(result.memory_throughput_gbps - 0.006666666666666667) < 1e-15);
  assert.equal(result.attainable_tflops, 0.0625);
  assert.equal(result.provenance.timing, 'simulation');
  assert.equal(result.provenance.workload, 'protocol');
  assert.equal(result.provenance.movement, 'simulation');
  assert.equal(result.bottleneck, 'memory');
  assert.equal(result.workload_source, 'protocol');
  assert.equal(result.ignored_metadata, false);
  assert.equal(result.passed, null);
  assert.equal(result.short_id, null);
});
test('submission defaults match the locked protocol', () => {
  const defaults = { ...request };
  delete defaults.warmup;
  delete defaults.repetitions;
  delete defaults.workload_mode;
  assert.equal(validateSubmission(defaults), true);
  assert.equal(calculateMetrics(defaults, [1]).provenance.workload, 'protocol');
});

test('median, zero bytes and compute ceiling', () => {
  assert.equal(calculateMetrics(request, [4, 1, 2, 3]).latency_ms, 2.5);
  assert.equal(calculateMetrics({ ...request, workload: { flops: 1, bytes_transferred: 0 } }, [1]).arithmetic_intensity, null);
  assert.equal(calculateMetrics({ ...request, workload: { flops: 100000, bytes_transferred: 1 } }, [1]).attainable_tflops, 10);
  for (const sample of [0, -1, NaN, Infinity]) assert.throws(() => calculateMetrics(request, [sample]));
});
test('reject unsupported language, invalid numbers, unknown fields and unicode byte overflow', () => {
  for (const patch of [
    { language: 'cpp' }, { language: 'triton', device: 'cpu' }, { repetitions: 0 },
    { warmup: 1.5 }, { extra: true }, { code: 'ก'.repeat(22000) }, { challenge_slug: 123 },
    { challenge_slug: 'Bad_Slug' }, { workload_mode: 'challenge_theory' }, { workload_mode: 'bogus' },
    { workload: { flops: -1, bytes_transferred: 0 } },
    { hardware: { ...request.hardware, peak_compute_tflops: Infinity } },
  ]) assert.equal(validateSubmission({ ...request, ...patch }), false);
});
