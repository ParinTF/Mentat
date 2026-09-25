import { parseBenchmarkResult } from './api.ts';
import type { ApiClient, SubmissionSnapshot } from './api';
import type { BenchmarkRequest, BenchmarkResult } from './roofline';
import type {
  KernelEvent,
  KernelEventMap,
  KernelEventType,
  SubmissionHandle,
  KernelTransport,
  SubmissionStatus,
} from './transport';

export interface WebSocketLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface GatewayClient {
  createSubmission(request: BenchmarkRequest, signal?: AbortSignal): Promise<{
    submission_id: string;
    websocket_url: string;
  }>;
  getSubmission(submissionId: string, signal?: AbortSignal): Promise<SubmissionSnapshot>;
  websocketUrl(path: string): string;
}

export interface GatewayTransportOptions {
  client: ApiClient | GatewayClient;
  webSocketFactory?: WebSocketFactory;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  now?: () => string;
}

const STATUSES = new Set<SubmissionStatus>(['queued', 'compiling', 'running', 'completed', 'failed', 'timed_out']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validPayload(type: KernelEventType, payload: unknown): boolean {
  if (type === 'heartbeat') return isRecord(payload) && Object.keys(payload).length === 0;
  if (!isRecord(payload)) return false;
  if (type === 'status') return typeof payload.status === 'string' && STATUSES.has(payload.status as SubmissionStatus);
  if (type === 'log') {
    return (payload.stream === 'stdout' || payload.stream === 'stderr' || payload.stream === 'system')
      && typeof payload.text === 'string';
  }
  if (type === 'trace') {
    return (payload.source === 'measured' || payload.source === 'illustrative' || payload.source === 'simulation')
      && ['host_ram', 'pcie', 'vram', 'sram', 'cores'].includes(String(payload.stage))
      && typeof payload.progress === 'number'
      && payload.progress >= 0
      && payload.progress <= 1
      && (payload.bottleneck === undefined || payload.bottleneck === 'memory' || payload.bottleneck === 'compute');
  }
  if (type === 'error') {
    return (payload.code === 'execution_error'
      || payload.code === 'timeout'
      || payload.code === 'infrastructure_error'
      || payload.code === 'missing_workload_metadata')
      && typeof payload.message === 'string';
  }
  if (type === 'result') {
    try {
      parseBenchmarkResult(payload);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function parseKernelEvent(value: unknown): KernelEvent | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1 || typeof value.submission_id !== 'string' || typeof value.timestamp !== 'string' || Number.isNaN(Date.parse(value.timestamp))) return null;
  if (!Number.isInteger(value.sequence) || (value.sequence as number) < 0) return null;
  if (typeof value.type !== 'string' || !['status', 'log', 'trace', 'result', 'error', 'heartbeat'].includes(value.type)) return null;
  const type = value.type as KernelEventType;
  if (!validPayload(type, value.payload)) return null;
  return value as unknown as KernelEvent;
}

export class GatewayTransport implements KernelTransport {
  readonly mode = 'sandbox' as const;
  private readonly client: ApiClient | GatewayClient;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly now: () => string;

  constructor(options: GatewayTransportOptions) {
    this.client = options.client;
    this.webSocketFactory = options.webSocketFactory ?? (url => new WebSocket(url));
    this.reconnectDelayMs = options.reconnectDelayMs ?? 300;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 3;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(
    request: BenchmarkRequest,
    onEvent: (event: KernelEvent) => void,
  ): Promise<SubmissionHandle> {
    const controllers = new Set<AbortController>();
    const withDeadline = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const controller = new AbortController();
      controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        return await operation(controller.signal);
      } finally {
        clearTimeout(timeout);
        controllers.delete(controller);
      }
    };
    const accepted = await withDeadline(signal => this.client.createSubmission(request, signal));
    let lastServerSequence = 0;
    let lastUiSequence = 0;
    let hasResult = false;
    let terminal = false;
    let cancelled = false;
    let recovering = false;
    let reconnectAttempts = 0;
    let heartbeatCount = 0;
    let socket: WebSocketLike | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let resolveFinished: () => void = () => {};
    const finished = new Promise<void>(resolve => { resolveFinished = resolve; });

    const synthetic = <T extends KernelEventType>(type: T, payload: KernelEventMap[T]): void => {
      if (type === 'result') hasResult = true;
      lastUiSequence += 1;
      onEvent({
        version: 1,
        submission_id: accepted.submission_id,
        sequence: lastUiSequence,
        timestamp: this.now(),
        type,
        payload,
      } as KernelEvent);
    };

    const settle = (): void => {
      if (terminal) return;
      terminal = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      socket?.close(1000, 'terminal');
      resolveFinished();
    };

    const recover = async (): Promise<void> => {
      if (recovering || cancelled || terminal) return;
      recovering = true;
      socket?.close(1000, 'snapshot recovery');
      try {
        const snapshot = await withDeadline(signal => this.client.getSubmission(accepted.submission_id, signal));
        if (snapshot.result !== null) synthetic('result', snapshot.result as BenchmarkResult);
        if (snapshot.status === 'completed') {
          if (snapshot.result === null) {
            synthetic('error', { code: 'infrastructure_error', message: 'Completed snapshot has no result' });
            synthetic('status', { status: 'failed' });
          } else {
            synthetic('status', { status: 'completed' });
          }
          settle();
          return;
        }
        if (snapshot.status === 'failed' || snapshot.status === 'timed_out') {
          synthetic('error', {
            code: snapshot.status === 'timed_out' ? 'timeout' : 'execution_error',
            message: snapshot.error ?? 'submission failed',
          });
          synthetic('status', { status: snapshot.status });
          settle();
          return;
        }
        synthetic('status', { status: snapshot.status });
      } catch (error) {
        if (cancelled) return;
        synthetic('error', {
          code: 'infrastructure_error',
          message: error instanceof Error ? error.message : 'Could not recover submission snapshot',
        });
        synthetic('status', { status: 'failed' });
        settle();
      } finally {
        recovering = false;
      }
      if (!cancelled && !terminal) connect(lastServerSequence);
    };

    const scheduleReconnect = (): void => {
      if (cancelled || terminal || recovering) return;
      if (reconnectAttempts >= this.maxReconnectAttempts) {
        void recover();
        return;
      }
      reconnectAttempts += 1;
      timer = setTimeout(() => {
        timer = null;
        connect(lastServerSequence);
      }, this.reconnectDelayMs);
    };

    const connect = (after: number): void => {
      if (cancelled || terminal || recovering) return;
      const url = new URL(this.client.websocketUrl(accepted.websocket_url));
      url.searchParams.set('after', String(after));
      const nextSocket = this.webSocketFactory(url.toString());
      socket = nextSocket;
      nextSocket.onopen = () => {};
      nextSocket.onmessage = message => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(message.data));
        } catch {
          return;
        }
        const event = parseKernelEvent(parsed);
        if (event === null || event.submission_id !== accepted.submission_id) return;
        if (event.sequence === 0) {
          heartbeatCount += 1;
          onEvent(event);
          if (heartbeatCount >= 3) void recover();
          return;
        }
        if (event.sequence <= lastServerSequence) return;
        if (event.sequence > lastServerSequence + 1) {
          void recover();
          return;
        }
        lastServerSequence = event.sequence;
        lastUiSequence = Math.max(lastUiSequence, event.sequence);
        heartbeatCount = 0;
        if (event.type === 'result') hasResult = true;
        onEvent(event);
        if (event.type === 'status' && event.payload.status === 'completed' && !hasResult) {
          void recover();
          return;
        }
        if (event.type === 'status' && ['completed', 'failed', 'timed_out'].includes(event.payload.status)) settle();
      };
      nextSocket.onerror = () => nextSocket.close();
      nextSocket.onclose = event => {
        if (event.code === 4409) {
          void recover();
          return;
        }
        scheduleReconnect();
      };
    };

    const cancel = (): void => {
      cancelled = true;
      for (const controller of controllers) controller.abort();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      socket?.close(1000, 'cancelled');
      resolveFinished();
    };

    connect(0);
    return { submission_id: accepted.submission_id, cancel, finished };
  }
}
