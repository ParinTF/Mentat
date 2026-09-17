/**
 * KernelForge transport layer.
 *
 * `KernelTransport` is the seam between the playground and the execution
 * backend. `LocalSimulationTransport` is the only implementation shipped in
 * this milestone: it NEVER executes the submitted code and never reads
 * hardware counters. It models latency from the user-supplied workload and
 * hardware peaks, emits the exact WebSocket event envelope from
 * `contracts/API.md`, and labels every payload as simulation. A WebSocket
 * transport for the gateway can implement the same interface without touching
 * the UI.
 *
 * Only type imports reference other modules so that this file stays loadable
 * by `node --test` after type stripping.
 */

import type { BenchmarkRequest, BenchmarkResult, Bottleneck, Stage, TimingProvenance } from './roofline';

export type SubmissionStatus =
  | 'queued' | 'compiling' | 'running' | 'completed' | 'failed' | 'timed_out';

export interface StatusPayload { status: SubmissionStatus }
export interface LogPayload { stream: 'stdout' | 'stderr' | 'system'; text: string }
export interface TracePayload {
  source: 'measured' | 'illustrative' | 'simulation';
  stage: Stage;
  progress: number;
  /** Set on the final trace event; derived from the roofline position. */
  bottleneck?: Bottleneck;
}
export interface ErrorPayload {
  code: 'execution_error' | 'timeout' | 'infrastructure_error';
  message: string;
}

export interface KernelEventMap {
  status: StatusPayload;
  log: LogPayload;
  trace: TracePayload;
  result: BenchmarkResult;
  error: ErrorPayload;
  heartbeat: Record<string, never>;
}

export type KernelEventType = keyof KernelEventMap;

export interface KernelEventEnvelope<T extends KernelEventType> {
  version: 1;
  submission_id: string;
  sequence: number;
  timestamp: string;
  type: T;
  payload: KernelEventMap[T];
}

export type KernelEvent = { [K in KernelEventType]: KernelEventEnvelope<K> }[KernelEventType];

export const PIPELINE_STAGES: Stage[] = ['host_ram', 'pcie', 'vram', 'sram', 'cores'];

export type EvaluateFn = (
  request: BenchmarkRequest,
  samplesMs: number[],
  timing?: TimingProvenance,
) => BenchmarkResult;

export interface SimulationClock {
  /** Resolves after roughly `ms`; tests inject an instant clock. */
  sleep(ms: number): Promise<void>;
}

export const realClock: SimulationClock = {
  sleep: (ms) => new Promise(resolve => { setTimeout(resolve, ms); }),
};

export interface SubmissionHandle {
  submission_id: string;
  cancel: () => void;
  finished: Promise<void>;
}

export interface KernelTransport {
  readonly mode: 'simulation' | 'sandbox';
  start(request: BenchmarkRequest, onEvent: (event: KernelEvent) => void): Promise<SubmissionHandle>;
}

/** Deterministic PRNG so identical submissions simulate identically. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Ideal (roofline) time for the declared workload: the slower of the memory
 * roof and the compute roof. Units: seconds.
 */
export function idealSeconds(request: BenchmarkRequest): number {
  const { flops, bytes_transferred: bytes } = request.workload;
  const computeSeconds = flops / (request.hardware.peak_compute_tflops * 1e12);
  const memorySeconds = bytes / (request.hardware.peak_bandwidth_gbps * 1e9);
  return Math.max(computeSeconds, memorySeconds);
}

/** Fraction of the roofline roof this model assumes. Not a measurement. */
export const SIMULATED_EFFICIENCY: Record<BenchmarkRequest['device'], number> = {
  cuda: 0.62,
  cpu: 0.38,
};

/** Minimum simulated latency so every sample stays strictly positive. */
export const MIN_SIMULATED_LATENCY_MS = 0.05;

/**
 * Mirrors `bottleneckFor` in `./roofline.ts` (memory bound below the ridge
 * point, compute bound at or above it). Duplicated here only because this
 * module must stay importable by `node --test` after type stripping, and
 * tests/vectors.test.mjs asserts both implementations agree.
 */
export function deriveBottleneck(request: BenchmarkRequest): Bottleneck | null {
  const { flops, bytes_transferred: bytes } = request.workload;
  if (bytes === 0) return null;
  const ai = flops / bytes;
  const ridge = (request.hardware.peak_compute_tflops * 1000) / request.hardware.peak_bandwidth_gbps;
  return ai < ridge ? 'memory' : 'compute';
}
export interface LocalSimulationOptions {
  evaluate: EvaluateFn;
  clock?: SimulationClock;
  /** Delay between simulated stages in ms (0 keeps unit tests instant). */
  stepDelayMs?: number;
  now?: () => string;
  idFactory?: () => string;
}

export class LocalSimulationTransport implements KernelTransport {
  readonly mode = 'simulation' as const;
  private readonly evaluate: EvaluateFn;
  private readonly clock: SimulationClock;
  private readonly stepDelayMs: number;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(options: LocalSimulationOptions) {
    this.evaluate = options.evaluate;
    this.clock = options.clock ?? realClock;
    this.stepDelayMs = options.stepDelayMs ?? 140;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
  }

  async start(
    request: BenchmarkRequest,
    onEvent: (event: KernelEvent) => void,
  ): Promise<SubmissionHandle> {
    const submission_id = this.idFactory();
    let sequence = 0;
    let cancelled = false;

    const emit = <T extends KernelEventType>(type: T, payload: KernelEventMap[T]): void => {
      if (cancelled) return;
      sequence += 1;
      // The correlation between `type` and `payload` is guaranteed by the
      // helper wrappers below, which TypeScript cannot express through a
      // generic object literal.
      const event = {
        version: 1,
        submission_id,
        sequence,
        timestamp: this.now(),
        type,
        payload,
      } as KernelEvent;
      onEvent(event);
    };
    const status = (value: SubmissionStatus): void => emit('status', { status: value });
    const log = (text: string): void => emit('log', { stream: 'system', text });
    const step = (): Promise<void> => this.clock.sleep(this.stepDelayMs);

    const run = async (): Promise<void> => {
      status('queued');
      log('Local simulation mode: submitted code is NOT executed and no hardware counters are read.');
      await step();
      status('compiling');
      log('Simulation: container start, import and compiler stages are skipped locally.');
      await step();
      status('running');
      log(`Simulated plan: warmup=${request.warmup}, repetitions=${request.repetitions}, device=${request.device}, workload_source=${request.workload_mode === 'declared' ? 'user_estimate' : request.workload_mode}.`);
      for (const stage of PIPELINE_STAGES) {
        for (const progress of [0.35, 0.7, 1]) {
          emit('trace', { source: 'simulation', stage, progress });
          await step();
        }
      }
      const samples = simulateSamples(request);
      const bottleneck = deriveBottleneck(request);
      emit('trace', {
        source: 'simulation',
        stage: bottleneck === 'compute' ? 'cores' : 'vram',
        progress: 1,
        bottleneck: bottleneck ?? undefined,
      });
      await step();
      const result = this.evaluate(request, samples, 'simulation');
      emit('result', result);
      log(`Simulated samples (ms): min=${Math.min(...samples).toFixed(3)} median=${result.latency_ms.toFixed(3)} max=${Math.max(...samples).toFixed(3)}`);
      log(bottleneck === null
        ? 'Bottleneck: undefined because the declared traffic is zero.'
        : `Bottleneck: ${bottleneck} roof binds (derived from the roofline position, not from a counter).`);
      log('Result is a roofline MODEL prediction, not a hardware measurement.');
      status('completed');
    };

    const finished = run().catch((error: unknown) => {
      emit('error', {
        code: 'infrastructure_error',
        message: error instanceof Error ? error.message : 'Simulation failed',
      });
      status('failed');
    });

    return { submission_id, cancel: () => { cancelled = true; }, finished };
  }
}

export function simulateSamples(request: BenchmarkRequest): number[] {
  const idealMs = idealSeconds(request) * 1000;
  const random = mulberry32(seedFrom(`${request.language}:${request.device}:${request.code}`));
  const samples: number[] = [];
  for (let index = 0; index < request.repetitions; index += 1) {
    const jitter = 0.94 + random() * 0.12;
    samples.push(Math.max(MIN_SIMULATED_LATENCY_MS, (idealMs / SIMULATED_EFFICIENCY[request.device]) * jitter));
  }
  return samples;
}