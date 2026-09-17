import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculateMetrics, validateSubmission, bottleneckFor, ridgePointAi } from '../demo/metrics.mjs';
import { evaluateResult, validateRequest, bottleneckFor as webBottleneck } from '../web/lib/roofline.ts';

const fixture = JSON.parse(readFileSync(new URL('../shared/metrics.vectors.json', import.meta.url), 'utf8'));

function closeEnough(actual, expected, label) {
  if (expected === null) {
    assert.equal(actual, null, `${label} should be null`);
    return;
  }
  assert.equal(typeof actual, 'number', `${label} should be a number`);
  const delta = Math.abs(actual - expected);
  const allowed = Math.max(fixture.tolerance.absolute, Math.abs(expected) * fixture.tolerance.relative);
  assert.ok(delta <= allowed, `${label}: ${actual} != ${expected} (delta ${delta} > ${allowed})`);
}

test('the checked-in vectors still match the reference implementation (drift guard)', () => {
  assert.equal(fixture.cases.length, 8);
  for (const testCase of fixture.cases) {
    assert.equal(validateSubmission(testCase.request), true, `${testCase.name}: request must stay valid`);
    const result = calculateMetrics(testCase.request, testCase.samples_ms, 'measured');
    for (const [key, expected] of Object.entries(testCase.expected)) {
      if (typeof expected === 'number' || expected === null) {
        closeEnough(result[key], expected, `${testCase.name}.${key}`);
      } else {
        assert.equal(result[key], expected, `${testCase.name}.${key}`);
      }
    }
  }
});

test('the web implementation reproduces every vector (JS/TS parity)', () => {
  for (const testCase of fixture.cases) {
    const validation = validateRequest(testCase.request);
    assert.equal(validation.ok, true, `${testCase.name}: web validation rejected the fixture`);
    const result = evaluateResult(validation.request, testCase.samples_ms, 'measured');
    for (const [key, expected] of Object.entries(testCase.expected)) {
      const actual = result[key];
      if (typeof expected === 'number') {
        closeEnough(actual, expected, `web ${testCase.name}.${key}`);
      } else {
        assert.equal(actual, expected, `web ${testCase.name}.${key}`);
      }
    }
    assert.equal(result.provenance.timing, 'measured');
    assert.equal(result.provenance.movement, 'derived');
    assert.equal(result.short_id, null);
    assert.equal(result.passed, null);
    assert.equal(result.correctness.checked, false);
    assert.equal(result.baseline, null);
  }
});

test('bottleneck and ridge point agree across implementations', () => {
  for (const testCase of fixture.cases) {
    const { hardware, workload } = testCase.request;
    const ai = workload.bytes_transferred === 0 ? null : workload.flops / workload.bytes_transferred;
    assert.equal(bottleneckFor(hardware, ai), webBottleneck(hardware, ai), testCase.name);
    assert.equal(bottleneckFor(hardware, ai), testCase.expected.bottleneck, testCase.name);
    assert.equal(ridgePointAi(hardware), (hardware.peak_compute_tflops * 1000) / hardware.peak_bandwidth_gbps);
  }
});

test('vector fixture documents the locked formulas', () => {
  assert.equal(fixture.formulas.attainable_tflops, 'min(peak_compute_tflops, peak_bandwidth_gbps * ai / 1000)');
  assert.equal(fixture.formulas.bottleneck, 'ai < ridge_point_ai ? memory : compute');
  assert.equal(fixture.tolerance.relative, 1e-12);
});