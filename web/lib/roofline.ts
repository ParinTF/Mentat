/**
 * KernelForge roofline metrics.
 *
 * Browser-safe and dependency-free so the same code can be unit tested with
 * `node --test` (Node strips the types) and imported by the Next.js app.
 * Formulas mirror the Node reference implementation in `demo/metrics.mjs`.
 *
 * HONESTY CONTRACT
 * - `hardware` peaks are USER-SUPPLIED specifications, never auto-detected.
 * - `workload` FLOPs/bytes are USER ESTIMATES unless a profiling backend
 *   supplies them; the provenance field records which source was used.
 * - Zero transferred bytes yields `null` arithmetic intensity / attainable
 *   performance instead of Infinity.
 */

export type Language = 'python' | 'pytorch' | 'triton';
export type Device = 'cpu' | 'cuda';
export type TimingProvenance = 'measured' | 'simulation';
export type TimingSource = 'cuda_events' | 'perf_counter' | 'simulated';
export type WorkloadSource = 'protocol' | 'challenge_theory' | 'user_estimate';
export type WorkloadMode = 'protocol' | 'declared' | 'challenge_theory';
export type MovementProvenance = 'derived' | 'illustrative' | 'simulation';
export type Bottleneck = 'memory' | 'compute';
export type Stage = 'host_ram' | 'pcie' | 'vram' | 'sram' | 'cores';

export interface WorkloadEstimate {
  flops: number;
  bytes_transferred: number;
}

export interface HardwareSpec {
  name: string;
  peak_compute_tflops: number;
  peak_bandwidth_gbps: number;
}

export interface BenchmarkRequest {
  code: string;
  language: Language;
  device: Device;
  warmup: number;
  repetitions: number;
  workload_mode: WorkloadMode;
  workload: WorkloadEstimate;
  hardware: HardwareSpec;
  challenge_slug: string | null;
}

export interface Provenance {
  timing: TimingProvenance;
  workload: WorkloadSource;
  movement: MovementProvenance;
}

export interface Correctness {
  checked: boolean;
  passed: boolean | null;
  max_abs_error: number | null;
  atol: number;
  rtol: number;
}

export interface BaselineComparison {
  name: string;
  latency_ms: number;
  speedup: number;
}

export type ValidationResult =
  | { ok: true; request: BenchmarkRequest }
  | { ok: false; detail: string };

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

const CHALLENGE_SLUG = /^[a-z0-9-]{3,64}$/;

/**
 * Same accept/reject semantics as `validateSubmission` in demo/metrics.mjs
 * (parity is enforced by tests/roofline-web.test.mjs).
 */
export function validateRequest(value: unknown): ValidationResult {
  if (!plainObject(value)) return { ok: false, detail: 'Body must be a JSON object' };
  const allowed = ['code', 'language', 'device', 'warmup', 'repetitions', 'workload_mode', 'workload', 'hardware', 'challenge_slug'];
  if (!onlyKeys(value, allowed)) return { ok: false, detail: 'Unknown field in request' };
  const code = value.code;
  if (typeof code !== 'string') return { ok: false, detail: 'code must be a string' };
  const codeBytes = utf8ByteLength(code);
  if (codeBytes < 1 || codeBytes > MAX_CODE_BYTES) {
    return { ok: false, detail: `code must be 1..${MAX_CODE_BYTES} UTF-8 bytes (got ${codeBytes})` };
  }
  const language = value.language;
  if (language !== 'python' && language !== 'pytorch' && language !== 'triton') {
    return { ok: false, detail: 'language must be python, pytorch or triton' };
  }
  const device = value.device;
  if (device !== 'cpu' && device !== 'cuda') return { ok: false, detail: 'device must be cpu or cuda' };
  if (language === 'triton' && device !== 'cuda') return { ok: false, detail: 'triton requires device=cuda' };
  const warmup = value.warmup ?? 3;
  if (typeof warmup !== 'number' || !Number.isInteger(warmup) || warmup < 0 || warmup > MAX_WARMUP) {
    return { ok: false, detail: `warmup must be an integer in 0..${MAX_WARMUP}` };
  }
  const repetitions = value.repetitions ?? 10;
  if (typeof repetitions !== 'number' || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > MAX_REPETITIONS) {
    return { ok: false, detail: `repetitions must be an integer in 1..${MAX_REPETITIONS}` };
  }
  const workload = value.workload;
  if (!plainObject(workload) || !onlyKeys(workload, ['flops', 'bytes_transferred'])) {
    return { ok: false, detail: 'workload must contain exactly flops and bytes_transferred' };
  }
  const flops = workload.flops;
  const bytes = workload.bytes_transferred;
  if (typeof flops !== 'number' || !Number.isSafeInteger(flops) || flops < 0) {
    return { ok: false, detail: 'workload.flops must be a non-negative safe integer' };
  }
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
    return { ok: false, detail: 'workload.bytes_transferred must be a non-negative safe integer' };
  }
  const hardware = value.hardware;
  if (!plainObject(hardware) || !onlyKeys(hardware, ['name', 'peak_compute_tflops', 'peak_bandwidth_gbps'])) {
    return { ok: false, detail: 'hardware must contain exactly name, peak_compute_tflops, peak_bandwidth_gbps' };
  }
  const name = hardware.name;
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 120) {
    return { ok: false, detail: 'hardware.name must be 1..120 characters' };
  }
  const peakCompute = hardware.peak_compute_tflops;
  const peakBandwidth = hardware.peak_bandwidth_gbps;
  for (const [label, peak] of [['peak_compute_tflops', peakCompute], ['peak_bandwidth_gbps', peakBandwidth]] as const) {
    if (typeof peak !== 'number' || !Number.isFinite(peak) || peak <= 0 || peak > MAX_PEAK) {
      return { ok: false, detail: `hardware.${label} must be finite, >0 and <=${MAX_PEAK}` };
    }
  }
  const workloadMode = value.workload_mode ?? 'protocol';
  if (workloadMode !== 'protocol' && workloadMode !== 'declared' && workloadMode !== 'challenge_theory') {
    return { ok: false, detail: 'workload_mode must be protocol, declared or challenge_theory' };
  }
  const challengeSlug = value.challenge_slug ?? null;
  if (challengeSlug != null && (typeof challengeSlug !== 'string' || !CHALLENGE_SLUG.test(challengeSlug))) {
    return { ok: false, detail: 'challenge_slug must be null or match ^[a-z0-9-]{3,64}$' };
  }
  if (workloadMode === 'challenge_theory' && challengeSlug == null) {
    return { ok: false, detail: 'workload_mode=challenge_theory requires challenge_slug' };
  }
  return {
    ok: true,
    request: {
      code,
      language,
      device,
      warmup,
      repetitions,
      workload_mode: workloadMode,
      workload: { flops, bytes_transferred: bytes },
      hardware: {
        name,
        peak_compute_tflops: peakCompute as number,
        peak_bandwidth_gbps: peakBandwidth as number,
      },
      challenge_slug: challengeSlug ?? null,
    },
  };
}

export interface BenchmarkResult {
  /** Filled once the gateway persists the row; null for local simulation. */
  short_id: string | null;
  latency_ms: number;
  memory_throughput_gbps: number;
  compute_tflops: number;
  arithmetic_intensity: number | null;
  attainable_tflops: number | null;
  bottleneck: Bottleneck | null;
  workload_source: WorkloadSource;
  ignored_metadata: boolean;
  pcie_transfer_ms: number | null;
  passed: boolean | null;
  correctness: Correctness;
  baseline: BaselineComparison | null;
  provenance: Provenance;
  hardware: HardwareSpec;
  samples_ms: number[];
}

/** Default comparison tolerances from the contract (torch.allclose defaults). */
export const ATOL = 1e-3;
export const RTOL = 1e-3;
/** A kernel that is not memory bound is compute bound. */
export function bottleneckFor(hardware: HardwareSpec, ai: number | null): Bottleneck | null {
  if (ai === null) return null;
  return ai < ridgePointAi(hardware) ? 'memory' : 'compute';
}

/** Which workload source a request implies, per `workload_mode`. */
export function workloadSourceFor(mode: WorkloadMode): WorkloadSource {
  if (mode === 'protocol') return 'protocol';
  if (mode === 'challenge_theory') return 'challenge_theory';
  return 'user_estimate';
}

export const MAX_CODE_BYTES = 65536;
export const MAX_PEAK = 1000000;
export const MAX_REPETITIONS = 100;
export const MAX_WARMUP = 10;

export function median(values: number[]): number {
  if (values.length === 0) throw new RangeError('median requires at least one sample');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** AI = Total FLOPs / Total Bytes Transferred (FLOP/byte). */
export function arithmeticIntensity(flops: number, bytes: number): number | null {
  return bytes === 0 ? null : flops / bytes;
}

/** Roofline boundary: min(Peak Compute, Peak Bandwidth * AI). */
export function attainableTflops(hardware: HardwareSpec, ai: number | null): number | null {
  if (ai === null) return null;
  return Math.min(hardware.peak_compute_tflops, (hardware.peak_bandwidth_gbps * ai) / 1000);
}

/** Arithmetic intensity where the memory and compute roofs intersect. */
export function ridgePointAi(hardware: HardwareSpec): number {
  return (hardware.peak_compute_tflops * 1000) / hardware.peak_bandwidth_gbps;
}

export function memoryThroughputGbps(bytes: number, latencyMs: number): number {
  return bytes / (latencyMs / 1000) / 1e9;
}

export function computeTflops(flops: number, latencyMs: number): number {
  return flops / (latencyMs / 1000) / 1e12;
}

export function evaluateResult(
  request: BenchmarkRequest,
  samplesMs: number[],
  timing: TimingProvenance = 'simulation',
): BenchmarkResult {
  if (samplesMs.length === 0 || samplesMs.some(value => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError('Samples must be finite and positive');
  }
  const latency = median(samplesMs);
  const { flops, bytes_transferred: bytes } = request.workload;
  const ai = arithmeticIntensity(flops, bytes);
  const result: BenchmarkResult = {
    short_id: null,
    latency_ms: latency,
    memory_throughput_gbps: memoryThroughputGbps(bytes, latency),
    compute_tflops: computeTflops(flops, latency),
    arithmetic_intensity: ai,
    attainable_tflops: attainableTflops(request.hardware, ai),
    bottleneck: bottleneckFor(request.hardware, ai),
    workload_source: workloadSourceFor(request.workload_mode),
    ignored_metadata: request.workload_mode === 'challenge_theory',
    pcie_transfer_ms: null,
    passed: null,
    correctness: { checked: false, passed: null, max_abs_error: null, atol: ATOL, rtol: RTOL },
    baseline: null,
    provenance: {
      timing,
      workload: workloadSourceFor(request.workload_mode),
      movement: timing === 'simulation' ? 'simulation' : 'derived',
    },
    hardware: request.hardware,
    samples_ms: [...samplesMs],
  };
  for (const value of Object.values(result)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new RangeError('Non-finite metric would break the JSON contract');
    }
  }
  return result;
}
export interface RooflineSample {
  ai: number;
  bound: number;
  region: 'bandwidth' | 'compute';
}

/** Log-spaced points for the roofline boundary line. */
export function rooflineCurve(
  hardware: HardwareSpec,
  minAi = 1e-3,
  maxAi = 1e4,
  points = 64,
): RooflineSample[] {
  if (!(minAi > 0) || !(maxAi > minAi) || points < 2) {
    throw new RangeError('rooflineCurve needs 0 < minAi < maxAi and points >= 2');
  }
  const ridge = ridgePointAi(hardware);
  const samples: RooflineSample[] = [];
  for (let index = 0; index < points; index += 1) {
    const ai = minAi * Math.pow(maxAi / minAi, index / (points - 1));
    samples.push({
      ai,
      bound: attainableTflops(hardware, ai) as number,
      region: ai < ridge ? 'bandwidth' : 'compute',
    });
  }
  return samples;
}

/** Powers of `base` inside [min, max]; always at least two ticks. */
export function logTicks(min: number, max: number, base = 10): number[] {
  if (!(min > 0) || !(max > min)) throw new RangeError('logTicks needs 0 < min < max');
  const first = Math.ceil(Math.log(min) / Math.log(base) - 1e-9);
  const last = Math.floor(Math.log(max) / Math.log(base) + 1e-9);
  const ticks: number[] = [];
  for (let exponent = first; exponent <= last; exponent += 1) {
    ticks.push(Math.pow(base, exponent));
  }
  return ticks.length >= 2 ? ticks : [min, max];
}

export function formatSi(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(value);
  const units: Array<[number, string]> = [
    [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''],
    [1e-3, 'm'], [1e-6, '\u00b5'], [1e-9, 'n'],
  ];
  for (const [scale, suffix] of units) {
    if (abs >= scale) {
      const scaled = value / scale;
      const text = Math.abs(scaled) >= 100 || Number.isInteger(scaled)
        ? scaled.toFixed(0)
        : scaled.toFixed(digits);
      return `${text}${suffix}`;
    }
  }
  return value.toExponential(2);
}

export function formatNumber(value: number | null, digits = 3, unit = ''): string {
  if (value === null) return 'n/a (bytes must be > 0)';
  return `${value.toFixed(digits)}${unit ? ` ${unit}` : ''}`;
}