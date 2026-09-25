import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalSimulationTransport,
  PIPELINE_STAGES,
  SIMULATED_EFFICIENCY,
  idealSeconds,
  simulateSamples,
  workloadModeForExecution,
} from '../web/lib/transport.ts';
import { evaluateResult } from '../web/lib/roofline.ts';
import { calculateMetrics } from '../demo/metrics.mjs';

const request = {
  code: 'def benchmark():\n    return {"output": 1.0}\n',
  language: 'pytorch',
  device: 'cuda',
  warmup: 2,
  repetitions: 8,
  workload_mode: 'declared',
  workload: { flops: 2_147_483_648, bytes_transferred: 12_582_912 },
  hardware: { name: 'Datacenter GPU class', peak_compute_tflops: 19.5, peak_bandwidth_gbps: 1555 },
  challenge_slug: null,
};

const instantClock = { sleep: async () => {} };
const fixedId = () => '8f14e45f-ea0a-4a2b-9c1d-5f6a7b8c9d0e';

test('execution mode selects honest workload provenance', () => {
  assert.equal(workloadModeForExecution('simulation'), 'declared');
  assert.equal(workloadModeForExecution('sandbox'), 'protocol');
});

test('local simulation emits the contract envelope in order and never claims to measure', async () => {
  const transport = new LocalSimulationTransport({
    evaluate: calculateMetrics,
    clock: instantClock,
    stepDelayMs: 0,
    idFactory: fixedId,
    now: () => '2026-09-17T12:00:00.000Z',
  });
  const events = [];
  const handle = await transport.start(request, event => events.push(event));
  await handle.finished;

  assert.equal(transport.mode, 'simulation');
  assert.equal(handle.submission_id, fixedId());
  assert.equal(events[0].type, 'status');
  assert.equal(events[0].payload.status, 'queued');
  assert.equal(events[events.length - 1].type, 'status');
  assert.equal(events[events.length - 1].payload.status, 'completed');

  events.forEach((event, index) => {
    assert.equal(event.version, 1);
    assert.equal(event.sequence, index + 1);
    assert.equal(event.submission_id, fixedId());
    assert.equal(event.timestamp, '2026-09-17T12:00:00.000Z');
    assert.deepEqual(Object.keys(event).sort(), ['payload', 'sequence', 'submission_id', 'timestamp', 'type', 'version']);
  });

  const traces = events.filter(event => event.type === 'trace');
  assert.equal(traces.length, PIPELINE_STAGES.length * 3 + 1, 'three traces per stage plus one bottleneck marker');
  const stageOrder = [];
  for (const trace of traces) {
    assert.equal(trace.payload.source, 'simulation');
    assert.ok(trace.payload.progress >= 0 && trace.payload.progress <= 1);
    if (!stageOrder.includes(trace.payload.stage)) stageOrder.push(trace.payload.stage);
  }
  assert.deepEqual(stageOrder, PIPELINE_STAGES);

  const results = events.filter(event => event.type === 'result');
  assert.equal(results.length, 1);
  assert.equal(results[0].payload.provenance.timing, 'simulation');
  assert.equal(results[0].payload.provenance.workload, 'user_estimate');
  assert.equal(results[0].payload.provenance.movement, 'simulation');
  assert.equal(results[0].payload.passed, null);
  assert.equal(results[0].payload.short_id, null);
  // AI ~171 FLOP/byte on a datacenter-GPU-class spec sits above the ridge point.
  assert.equal(results[0].payload.bottleneck, 'compute');
  assert.equal(results[0].payload.workload_source, 'user_estimate');
  assert.equal(results[0].payload.ignored_metadata, false);
  assert.ok(events.indexOf(results[0]) < events.length - 1);
  const marker = traces[traces.length - 1];
  assert.equal(marker.payload.bottleneck, 'compute');
  assert.equal(marker.payload.stage, 'cores');
  assert.ok(events.indexOf(marker) < events.indexOf(results[0]));
});

test('simulated samples are deterministic and follow the roofline timing model', () => {
  const idealMs = idealSeconds(request) * 1000;
  const samples = simulateSamples(request);
  assert.equal(samples.length, request.repetitions);
  assert.deepEqual(samples, simulateSamples(request));
  const efficiency = SIMULATED_EFFICIENCY[request.device];
  for (const sample of samples) {
    const ratio = sample / (idealMs / efficiency);
    assert.ok(ratio >= 0.94 && ratio <= 1.06, `jitter out of range: ${ratio}`);
  }
  // 2.147 GFLOP on a 19.5 TFLOP/s class device is compute bound, not memory bound.
  assert.ok(idealMs > (request.workload.bytes_transferred / (request.hardware.peak_bandwidth_gbps * 1e9)) * 1000);
  assert.ok(samples.every(sample => sample > 0));
});

test('cancel stops emitting events and never reports completion', async () => {
  const transport = new LocalSimulationTransport({
    evaluate: evaluateResult,
    clock: { sleep: ms => new Promise(resolve => { setTimeout(resolve, ms); }) },
    stepDelayMs: 1,
    idFactory: fixedId,
  });
  const events = [];
  const handle = await transport.start(request, event => events.push(event));
  const atCancel = events.length;
  assert.ok(atCancel >= 2);
  handle.cancel();
  await handle.finished;
  assert.equal(events.length, atCancel);
  assert.ok(!events.some(event => event.type === 'status' && event.payload.status === 'completed'));
});

test('transport surfaces evaluator failures as an error event plus failed status', async () => {
  const transport = new LocalSimulationTransport({
    evaluate: () => { throw new RangeError('Samples must be finite and positive'); },
    clock: instantClock,
    stepDelayMs: 0,
    idFactory: fixedId,
  });
  const events = [];
  const handle = await transport.start(request, event => events.push(event));
  await handle.finished;
  assert.equal(events[events.length - 2].type, 'error');
  assert.equal(events[events.length - 2].payload.code, 'infrastructure_error');
  assert.equal(events[events.length - 1].payload.status, 'failed');
});