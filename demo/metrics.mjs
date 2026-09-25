export function ridgePointAi(hardware) {
  return (hardware.peak_compute_tflops * 1000) / hardware.peak_bandwidth_gbps;
}

export function bottleneckFor(hardware, ai) {
  if (ai === null) return null;
  return ai < ridgePointAi(hardware) ? 'memory' : 'compute';
}

export function workloadSourceFor(mode = 'protocol') {
  if (mode === 'protocol') return 'protocol';
  if (mode === 'challenge_theory') return 'challenge_theory';
  return 'user_estimate';
}

export const ATOL = 1e-3;
export const RTOL = 1e-3;

export function calculateMetrics(request, samplesMs, timing = 'simulation') {
  if (!samplesMs.length || samplesMs.some(value => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError('Samples must be finite and positive');
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const latency = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const seconds = latency / 1000;
  const { flops, bytes_transferred: bytes } = request.workload;
  const ai = bytes === 0 ? null : flops / bytes;
  const workloadMode = request.workload_mode ?? 'protocol';
  const workloadSource = workloadSourceFor(workloadMode);
  const result = {
    short_id: null,
    latency_ms: latency,
    memory_throughput_gbps: bytes / seconds / 1e9,
    compute_tflops: flops / seconds / 1e12,
    arithmetic_intensity: ai,
    attainable_tflops: ai === null ? null : Math.min(request.hardware.peak_compute_tflops, request.hardware.peak_bandwidth_gbps * ai / 1000),
    bottleneck: bottleneckFor(request.hardware, ai),
    workload_source: workloadSource,
    ignored_metadata: workloadMode === 'challenge_theory',
    pcie_transfer_ms: null,
    passed: null,
    correctness: { checked: false, passed: null, max_abs_error: null, atol: ATOL, rtol: RTOL },
    baseline: null,
    provenance: { timing, workload: workloadSource, movement: timing === 'simulation' ? 'simulation' : 'derived' },
    hardware: request.hardware,
    samples_ms: [...samplesMs],
  };
  for (const value of Object.values(result)) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError('Nonfinite metric');
  }
  return result;
}

function object(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
}

export function validateSubmission(value) {
  const allowed = ['code', 'language', 'device', 'warmup', 'repetitions', 'workload_mode', 'workload', 'hardware', 'challenge_slug'];
  if (!object(value, allowed)) return false;
  if (typeof value.code !== 'string' || Buffer.byteLength(value.code) < 1 || Buffer.byteLength(value.code) > 65536) return false;
  if (!['python', 'pytorch', 'triton'].includes(value.language) || !['cpu', 'cuda'].includes(value.device)) return false;
  if (value.language === 'triton' && value.device !== 'cuda') return false;
  const warmup = value.warmup ?? 3;
  const repetitions = value.repetitions ?? 10;
  const workloadMode = value.workload_mode ?? 'protocol';
  if (!Number.isInteger(warmup) || warmup < 0 || warmup > 10) return false;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100) return false;
  if (!['protocol', 'declared', 'challenge_theory'].includes(workloadMode)) return false;
  if (!object(value.workload, ['flops', 'bytes_transferred'])) return false;
  if (![value.workload.flops, value.workload.bytes_transferred].every(n => Number.isSafeInteger(n) && n >= 0)) return false;
  if (!object(value.hardware, ['name', 'peak_compute_tflops', 'peak_bandwidth_gbps'])) return false;
  if (typeof value.hardware.name !== 'string' || !value.hardware.name.trim() || value.hardware.name.length > 120) return false;
  if (![value.hardware.peak_compute_tflops, value.hardware.peak_bandwidth_gbps].every(n => Number.isFinite(n) && n > 0 && n <= 1000000)) return false;
  if (value.challenge_slug != null && (typeof value.challenge_slug !== 'string' || !/^[a-z0-9-]{3,64}$/.test(value.challenge_slug))) return false;
  if (workloadMode === 'challenge_theory' && value.challenge_slug == null) return false;
  return true;
}
