import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateResult,
  formatNumber,
  formatSi,
  logTicks,
  ridgePointAi,
  rooflineCurve,
  validateRequest,
} from '../web/lib/roofline.ts';
import { calculateMetrics, validateSubmission } from '../demo/metrics.mjs';
import { sampleFor } from '../web/lib/samples.ts';

const request = {
  code: 'def benchmark():\n    return {"output": 1.0, "flops": 1000, "bytes": 8000}\n',
  language: 'python',
  device: 'cpu',
  warmup: 2,
  repetitions: 10,
  workload_mode: 'protocol',
  workload: { flops: 1000, bytes_transferred: 8000 },
  hardware: { name: 'Example specification', peak_compute_tflops: 10, peak_bandwidth_gbps: 500 },
  challenge_slug: null,
};

test('CPU worker samples do not select CUDA accidentally', () => {
  assert.equal(sampleFor('python').device, 'cpu');
  assert.equal(sampleFor('pytorch').device, 'cpu');
  assert.equal(sampleFor('triton').device, 'cuda');
});

test('web UI formulas match the Node reference implementation', () => {
  const fromWeb = evaluateResult(request, [1.2]);
  const fromReference = calculateMetrics(request, [1.2]);
  assert.equal(fromWeb.latency_ms, fromReference.latency_ms);
  assert.equal(fromWeb.memory_throughput_gbps, fromReference.memory_throughput_gbps);
  assert.equal(fromWeb.compute_tflops, fromReference.compute_tflops);
  assert.equal(fromWeb.arithmetic_intensity, fromReference.arithmetic_intensity);
  assert.equal(fromWeb.attainable_tflops, fromReference.attainable_tflops);
  assert.equal(fromWeb.bottleneck, fromReference.bottleneck);
  assert.equal(fromWeb.workload_source, fromReference.workload_source);
  assert.equal(fromWeb.ignored_metadata, fromReference.ignored_metadata);
  assert.equal(fromWeb.provenance.timing, 'simulation');
  assert.equal(fromWeb.passed, null);
  assert.equal(fromWeb.short_id, null);
});

test('web validation accepts and rejects exactly what the Node validator does', () => {
  const defaults = { ...request };
  delete defaults.warmup;
  delete defaults.repetitions;
  delete defaults.workload_mode;
  const fixtures = [
    request,
    defaults,
    { ...request, language: 'cpp' },
    { ...request, language: 'triton', device: 'cpu' },
    { ...request, language: 'triton', device: 'cuda' },
    { ...request, repetitions: 0 },
    { ...request, warmup: 1.5 },
    { ...request, extra: true },
    { ...request, code: '\u0e01'.repeat(22000) },
    { ...request, challenge_slug: 123 },
    { ...request, challenge_slug: 'vector-add-1m' },
    { ...request, workload_mode: 'challenge_theory' },
    { ...request, workload_mode: 'challenge_theory', challenge_slug: 'vector-add-1m' },
    { ...request, workload_mode: 'declared' },
    { ...request, workload: { flops: -1, bytes_transferred: 0 } },
    { ...request, workload: { flops: 1000, bytes_transferred: 0 } },
    { ...request, hardware: { ...request.hardware, peak_compute_tflops: Infinity } },
    { ...request, hardware: { ...request.hardware, name: '   ' } },
  ];
  for (const fixture of fixtures) {
    assert.equal(validateRequest(fixture).ok, validateSubmission(fixture), JSON.stringify(fixture).slice(0, 90));
  }
  const normalized = validateRequest(defaults);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.request.warmup, 3);
  assert.equal(normalized.request.repetitions, 10);
  assert.equal(normalized.request.workload_mode, 'protocol');
  const rejected = validateRequest({ ...request, language: 'triton', device: 'cpu' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.detail, /cuda/);
});

test('zero transferred bytes yields null intensity instead of Infinity', () => {
  const result = evaluateResult({ ...request, workload: { flops: 1000, bytes_transferred: 0 } }, [1]);
  assert.equal(result.arithmetic_intensity, null);
  assert.equal(result.attainable_tflops, null);
  assert.equal(formatNumber(result.arithmetic_intensity, 4, 'FLOP/byte'), 'n/a (bytes must be > 0)');
});

test('roofline curve and ridge point follow the model boundary', () => {
  const hardware = { name: 'x', peak_compute_tflops: 10, peak_bandwidth_gbps: 500 };
  assert.equal(ridgePointAi(hardware), 20);
  const curve = rooflineCurve(hardware, 1e-3, 1e4, 32);
  assert.equal(curve.length, 32);
  for (const sample of curve) {
    const expected = Math.min(hardware.peak_compute_tflops, (hardware.peak_bandwidth_gbps * sample.ai) / 1000);
    assert.ok(Math.abs(sample.bound - expected) < 1e-12);
    assert.equal(sample.region, sample.ai < 20 ? 'bandwidth' : 'compute');
  }
  const first = curve[0];
  const last = curve[curve.length - 1];
  assert.ok(first.ai < last.ai);
  assert.ok(first.bound < last.bound);
  assert.equal(last.bound, hardware.peak_compute_tflops);
});

test('log ticks and SI formatting are chart-safe', () => {
  const ticks = logTicks(1e-3, 1e4);
  assert.equal(ticks.length, 8);
  assert.deepEqual(ticks.slice(0, 3), [1e-3, 1e-2, 1e-1]);
  assert.equal(ticks[7], 1e4);
  assert.deepEqual(logTicks(7.8e-4, 39), [1e-3, 1e-2, 1e-1, 1, 10]);
  assert.equal(formatSi(1555), '1.55k');
  assert.equal(formatSi(0.00667), '6.67m');
  assert.equal(formatSi(1e12), '1T');
  assert.equal(formatSi(0.5), '500m');
  assert.throws(() => logTicks(0, 10));
});