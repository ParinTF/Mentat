import type { BenchmarkRequest, BenchmarkResult, Device, Language } from './roofline';
import type { SubmissionStatus } from './transport';

export type BackendMode = 'simulation' | 'sandbox';

export interface ApiCapabilities {
  mode: BackendMode;
  devices: { cpu: boolean; cuda: boolean };
  languages: { python: boolean; pytorch: boolean; triton: boolean };
  limits: { max_code_bytes: number; max_repetitions: number; wall_time_s: number };
  host: { os: string; arch: string; cpu_cores: number; memory_gb: number };
}

export interface SubmissionAccepted {
  submission_id: string;
  status: 'queued';
  websocket_url: string;
  mode: BackendMode;
}

export interface SubmissionSnapshot {
  submission_id: string;
  status: SubmissionStatus;
  mode: BackendMode;
  result: BenchmarkResult | null;
  error: string | null;
}

export interface ShareSnapshot {
  short_id: string;
  submission_id: string;
  challenge_slug: string | null;
  language: Language;
  device: Device;
  created_at: string;
  result: BenchmarkResult | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly detail: unknown;

  constructor(status: number, detail: unknown) {
    const message = typeof detail === 'string'
      ? detail
      : isRecord(detail) && typeof detail.message === 'string'
        ? detail.message
        : `KernelForge API returned HTTP ${status}`;
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = isRecord(detail) && typeof detail.code === 'string' ? detail.code : null;
    this.detail = detail;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  if (typeof value[key] !== 'boolean') throw new TypeError(`${key} must be boolean`);
  return value[key];
}

function numberField(value: Record<string, unknown>, key: string): number {
  if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) throw new TypeError(`${key} must be a finite number`);
  return value[key];
}

function stringField(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== 'string') throw new TypeError(`${key} must be a string`);
  return value[key];
}

function nested(value: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!isRecord(value[key])) throw new TypeError(`${key} must be an object`);
  return value[key];
}

export function parseCapabilities(value: unknown): ApiCapabilities {
  if (!isRecord(value)) throw new TypeError('capabilities must be an object');
  if (value.mode !== 'simulation' && value.mode !== 'sandbox') throw new TypeError('mode is invalid');
  const devices = nested(value, 'devices');
  const languages = nested(value, 'languages');
  const limits = nested(value, 'limits');
  const host = nested(value, 'host');
  return {
    mode: value.mode,
    devices: { cpu: booleanField(devices, 'cpu'), cuda: booleanField(devices, 'cuda') },
    languages: {
      python: booleanField(languages, 'python'),
      pytorch: booleanField(languages, 'pytorch'),
      triton: booleanField(languages, 'triton'),
    },
    limits: {
      max_code_bytes: numberField(limits, 'max_code_bytes'),
      max_repetitions: numberField(limits, 'max_repetitions'),
      wall_time_s: numberField(limits, 'wall_time_s'),
    },
    host: {
      os: stringField(host, 'os'),
      arch: stringField(host, 'arch'),
      cpu_cores: numberField(host, 'cpu_cores'),
      memory_gb: numberField(host, 'memory_gb'),
    },
  };
}

function nullableNumber(value: unknown, label: string, positive = false): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) throw new TypeError(`${label} is invalid`);
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError(`${label} is invalid`);
  return value;
}

export function parseBenchmarkResult(value: unknown): BenchmarkResult {
  if (!isRecord(value)) throw new TypeError('result must be an object');
  if (value.short_id !== null && typeof value.short_id !== 'string') throw new TypeError('result.short_id is invalid');
  const latency = nullableNumber(value.latency_ms, 'result.latency_ms', true);
  const memory = nonNegativeNumber(value.memory_throughput_gbps, 'result.memory_throughput_gbps');
  const compute = nonNegativeNumber(value.compute_tflops, 'result.compute_tflops');
  const arithmeticIntensity = nullableNumber(value.arithmetic_intensity, 'result.arithmetic_intensity');
  const attainable = nullableNumber(value.attainable_tflops, 'result.attainable_tflops');
  const bottleneck = value.bottleneck;
  if (bottleneck !== null && bottleneck !== 'memory' && bottleneck !== 'compute') throw new TypeError('result.bottleneck is invalid');
  if (value.workload_source !== 'protocol' && value.workload_source !== 'challenge_theory' && value.workload_source !== 'user_estimate') throw new TypeError('result.workload_source is invalid');
  if (typeof value.ignored_metadata !== 'boolean') throw new TypeError('result.ignored_metadata is invalid');
  nullableNumber(value.pcie_transfer_ms, 'result.pcie_transfer_ms');
  if (value.passed !== null && typeof value.passed !== 'boolean') throw new TypeError('result.passed is invalid');
  const correctness = nested(value, 'correctness');
  if (typeof correctness.checked !== 'boolean' || (correctness.passed !== null && typeof correctness.passed !== 'boolean')) throw new TypeError('result.correctness is invalid');
  nullableNumber(correctness.max_abs_error, 'result.correctness.max_abs_error');
  nonNegativeNumber(correctness.atol, 'result.correctness.atol');
  nonNegativeNumber(correctness.rtol, 'result.correctness.rtol');
  const baseline = value.baseline;
  if (baseline !== null) {
    if (!isRecord(baseline) || typeof baseline.name !== 'string') throw new TypeError('result.baseline is invalid');
    nullableNumber(baseline.latency_ms, 'result.baseline.latency_ms', true);
    nonNegativeNumber(baseline.speedup, 'result.baseline.speedup');
  }
  const provenance = nested(value, 'provenance');
  if (provenance.timing !== 'measured' && provenance.timing !== 'simulation') throw new TypeError('result.provenance.timing is invalid');
  if (provenance.workload !== value.workload_source) throw new TypeError('result provenance workload is inconsistent');
  if (provenance.movement !== 'derived' && provenance.movement !== 'illustrative' && provenance.movement !== 'simulation') throw new TypeError('result.provenance.movement is invalid');
  const hardware = nested(value, 'hardware');
  stringField(hardware, 'name');
  const computePeak = numberField(hardware, 'peak_compute_tflops');
  const bandwidthPeak = numberField(hardware, 'peak_bandwidth_gbps');
  if (computePeak <= 0 || bandwidthPeak <= 0) throw new TypeError('result hardware peaks are invalid');
  if (!Array.isArray(value.samples_ms) || value.samples_ms.length === 0 || value.samples_ms.some(sample => typeof sample !== 'number' || !Number.isFinite(sample) || sample <= 0)) throw new TypeError('result.samples_ms is invalid');
  return value as unknown as BenchmarkResult;
}

function parseAccepted(value: unknown): SubmissionAccepted {
  if (!isRecord(value)) throw new TypeError('submission response must be an object');
  if (value.status !== 'queued') throw new TypeError('submission status must be queued');
  if (value.mode !== 'simulation' && value.mode !== 'sandbox') throw new TypeError('submission mode is invalid');
  return {
    submission_id: stringField(value, 'submission_id'),
    status: 'queued',
    websocket_url: stringField(value, 'websocket_url'),
    mode: value.mode,
  };
}

const STATUSES = new Set<SubmissionStatus>(['queued', 'compiling', 'running', 'completed', 'failed', 'timed_out']);

export function parseSubmissionSnapshot(value: unknown): SubmissionSnapshot {
  if (!isRecord(value)) throw new TypeError('submission snapshot must be an object');
  if (typeof value.status !== 'string' || !STATUSES.has(value.status as SubmissionStatus)) throw new TypeError('status is invalid');
  if (value.mode !== 'simulation' && value.mode !== 'sandbox') throw new TypeError('mode is invalid');
  if (value.result !== null) parseBenchmarkResult(value.result);
  if (value.error !== null && typeof value.error !== 'string') throw new TypeError('error must be a string or null');
  return {
    submission_id: stringField(value, 'submission_id'),
    status: value.status as SubmissionStatus,
    mode: value.mode,
    result: value.result as BenchmarkResult | null,
    error: value.error,
  };
}

export function parseShareSnapshot(value: unknown): ShareSnapshot {
  if (!isRecord(value)) throw new TypeError('share snapshot must be an object');
  if (value.language !== 'python' && value.language !== 'pytorch' && value.language !== 'triton') throw new TypeError('language is invalid');
  if (value.device !== 'cpu' && value.device !== 'cuda') throw new TypeError('device is invalid');
  if (value.challenge_slug !== null && typeof value.challenge_slug !== 'string') throw new TypeError('challenge_slug is invalid');
  if (value.result !== null) parseBenchmarkResult(value.result);
  return {
    short_id: stringField(value, 'short_id'),
    submission_id: stringField(value, 'submission_id'),
    challenge_slug: value.challenge_slug,
    language: value.language,
    device: value.device,
    created_at: stringField(value, 'created_at'),
    result: value.result as BenchmarkResult | null,
  };
}

type FetchImplementation = typeof fetch;

export class ApiClient {
  readonly baseUrl: string;
  private readonly fetchImplementation: FetchImplementation;
  private readonly runToken: string;

  constructor(baseUrl: string, fetchImplementation: FetchImplementation = fetch, runToken = '') {
    const normalized = baseUrl.trim().replace(/\/+$/, '');
    if (normalized === '') throw new TypeError('API base URL is required');
    this.baseUrl = normalized;
    this.fetchImplementation = fetchImplementation;
    this.runToken = runToken.trim();
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const headers = new Headers(init?.headers);
    headers.set('Accept', 'application/json');
    if (init?.method === 'POST' && this.runToken !== '') headers.set('X-KernelForge-Token', this.runToken);
    const response = await this.fetchImplementation(new URL(path, `${this.baseUrl}/`).toString(), {
      ...init,
      headers,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = isRecord(payload) && 'detail' in payload ? payload.detail : payload;
      throw new ApiError(response.status, detail);
    }
    return payload;
  }

  async getCapabilities(signal?: AbortSignal): Promise<ApiCapabilities> {
    return parseCapabilities(await this.request('/api/v1/capabilities', { signal }));
  }

  async createSubmission(request: BenchmarkRequest, signal?: AbortSignal): Promise<SubmissionAccepted> {
    return parseAccepted(await this.request('/api/v1/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    }));
  }

  async getSubmission(submissionId: string, signal?: AbortSignal): Promise<SubmissionSnapshot> {
    return parseSubmissionSnapshot(await this.request(`/api/v1/submissions/${encodeURIComponent(submissionId)}`, { signal }));
  }

  async getShare(shortId: string, signal?: AbortSignal): Promise<ShareSnapshot> {
    return parseShareSnapshot(await this.request(`/api/v1/s/${encodeURIComponent(shortId)}`, { signal }));
  }

  websocketUrl(path: string): string {
    const url = new URL(path, `${this.baseUrl}/`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }
}
