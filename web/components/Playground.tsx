'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, AlertTriangle, Cpu, Gauge, History, Play, Square, Terminal, Zap } from 'lucide-react';
import ChallengePanel from './ChallengePanel';
import CodeEditor from './CodeEditor';
import MemoryPipeline from './MemoryPipeline';
import RooflineChart from './RooflineChart';
import type {
  BenchmarkRequest,
  BenchmarkResult,
  Device,
  HardwareSpec,
  Language,
  Stage,
} from '@/lib/roofline';
import { evaluateResult, formatNumber, formatSi, ridgePointAi, validateRequest } from '@/lib/roofline';
import { ApiClient } from '@/lib/api';
import type { ApiCapabilities } from '@/lib/api';
import { GatewayTransport } from '@/lib/gateway-transport';
import { HARDWARE_PRESETS, SAMPLES, sampleFor } from '@/lib/samples';
import type { KernelEvent, KernelTransport, SubmissionHandle, SubmissionStatus } from '@/lib/transport';
import { LocalSimulationTransport, PIPELINE_STAGES, workloadModeForExecution } from '@/lib/transport';

type Status = SubmissionStatus | 'idle';

interface LogLine {
  sequence: number;
  stream: string;
  text: string;
}

interface WorkloadState {
  flops: number;
  bytes: number;
}

function emptyProgress(): Record<Stage, number> {
  return PIPELINE_STAGES.reduce<Record<Stage, number>>((accumulator, stage) => {
    accumulator[stage] = 0;
    return accumulator;
  }, {} as Record<Stage, number>);
}

const API_BASE = (process.env.NEXT_PUBLIC_KF_API ?? '').trim();

export default function Playground() {
  const initialSample = sampleFor('python');
  const [language, setLanguage] = useState<Language>('python');
  const [code, setCode] = useState(initialSample.code);
  const [device, setDevice] = useState<Device>(initialSample.device);
  const [workload, setWorkload] = useState<WorkloadState>({
    flops: initialSample.workload.flops,
    bytes: initialSample.workload.bytes_transferred,
  });
  const [presetId, setPresetId] = useState(HARDWARE_PRESETS[0].id);
  const [hardware, setHardware] = useState<HardwareSpec>(HARDWARE_PRESETS[0].spec);
  const [warmup, setWarmup] = useState(2);
  const [repetitions, setRepetitions] = useState(10);
  const [status, setStatus] = useState<Status>('idle');
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [result, setResult] = useState<BenchmarkResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<Stage, number>>(emptyProgress);
  const handleRef = useRef<SubmissionHandle | null>(null);
  const consoleRef = useRef<HTMLDivElement | null>(null);
  const busy = status === 'queued' || status === 'compiling' || status === 'running';

  interface HistoryEntry {
    savedAt: string;
    language: Language;
    device: Device;
    hardwareName: string;
    latency_ms: number;
    arithmetic_intensity: number | null;
    bottleneck: 'memory' | 'compute' | null;
    code: string;
  }

  const HISTORY_KEY = 'kernelforge.history.v1';
  const [capabilities, setCapabilities] = useState<ApiCapabilities | null>(null);
  const [runToken, setRunToken] = useState('');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const apiClient = useMemo(() => API_BASE === '' ? null : new ApiClient(API_BASE, fetch, runToken), [runToken]);
  const sandboxReady = capabilities?.mode === 'sandbox'
    && capabilities.devices[device]
    && capabilities.languages[language];

  useEffect(() => {
    if (capabilities?.mode !== 'sandbox' || capabilities.devices.cuda || language !== 'triton') return;
    const sample = sampleFor('python');
    setCode(sample.code);
    setLanguage('python');
    setDevice('cpu');
    setWorkload({ flops: sample.workload.flops, bytes: sample.workload.bytes_transferred });
  }, [capabilities, language]);

  useEffect(() => {
    if (apiClient === null) return;
    let cancelled = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const load = async (): Promise<void> => {
      const currentController = new AbortController();
      controller = currentController;
      const timeout = setTimeout(() => currentController.abort(), 4000);
      try {
        const value = await apiClient.getCapabilities(currentController.signal);
        if (cancelled) return;
        setCapabilities(value);
        if (value.mode === 'sandbox' && !value.devices.cuda) {
          setDevice('cpu');
          setPresetId('cpu-socket');
          setHardware(HARDWARE_PRESETS.find(item => item.id === 'cpu-socket')?.spec ?? HARDWARE_PRESETS[0].spec);
        }
        if (value.mode === 'sandbox' && !value.devices.cpu) retryTimer = setTimeout(() => { void load(); }, 2000);
      } catch {
        if (!cancelled) setCapabilities(null);
      } finally {
        clearTimeout(timeout);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      controller?.abort();
    };
  }, [apiClient]);

  useEffect(() => {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (raw === null) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) setHistory(parsed as HistoryEntry[]);
    } catch {
      window.localStorage.removeItem(HISTORY_KEY);
    }
  }, []);

  const appendHistory = useCallback((entry: HistoryEntry) => {
    setHistory(previous => {
      const next = [entry, ...previous].slice(0, 20);
      try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* storage full or blocked */ }
      return next;
    });
  }, []);

  const restoreFromHistory = useCallback((entry: HistoryEntry) => {
    setCode(entry.code);
    setLanguage(entry.language);
    setDevice(entry.device);
  }, []);

  const loadStarter = useCallback((nextCode: string, nextLanguage: Language, nextDevice: Device) => {
    setCode(nextCode);
    setLanguage(nextLanguage);
    setDevice(nextDevice);
  }, []);

  const shareResult = useCallback(async () => {
    if (result === null || result.short_id === null) return;
    const url = `${window.location.origin}/s/${result.short_id}`;
    try {
      await navigator.clipboard.writeText(url);
      setShareNotice('Share link copied to the clipboard.');
    } catch {
      setShareNotice(url);
    }
  }, [result]);

  useEffect(() => {
    const node = consoleRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [logs]);

  const request = useMemo<BenchmarkRequest>(() => ({
    code,
    language,
    device,
    warmup,
    repetitions,
    workload_mode: workloadModeForExecution(sandboxReady ? 'sandbox' : 'simulation'),
    workload: { flops: workload.flops, bytes_transferred: workload.bytes },
    hardware,
    challenge_slug: null,
  }), [code, language, device, warmup, repetitions, workload, hardware, sandboxReady]);

  const validation = useMemo(() => validateRequest(request), [request]);

  const applySample = useCallback((next: Language) => {
    const sample = sampleFor(next);
    setLanguage(next);
    setCode(sample.code);
    setDevice(sample.device);
    setWorkload({ flops: sample.workload.flops, bytes: sample.workload.bytes_transferred });
  }, []);

  const onEvent = useCallback((event: KernelEvent) => {
    if (event.type === 'log') {
      const line: LogLine = {
        sequence: event.sequence,
        stream: event.payload.stream,
        text: event.payload.text,
      };
      setLogs(previous => [...previous, line].slice(-200));
    } else if (event.type === 'status') {
      setStatus(event.payload.status);
    } else if (event.type === 'trace') {
      setProgress(previous => ({ ...previous, [event.payload.stage]: event.payload.progress }));
    } else if (event.type === 'result') {
      setResult(event.payload);
      appendHistory({
        savedAt: new Date().toISOString(),
        language,
        device,
        hardwareName: event.payload.hardware.name,
        latency_ms: event.payload.latency_ms,
        arithmetic_intensity: event.payload.arithmetic_intensity,
        bottleneck: event.payload.bottleneck,
        code,
      });
    } else if (event.type === 'error') {
      setErrorMessage(event.payload.message);
    }
  }, [appendHistory, code, device, language]);

  const run = useCallback(async () => {
    if (!validation.ok) {
      setErrorMessage(validation.detail);
      return;
    }
    setErrorMessage(null);
    setLogs([]);
    setResult(null);
    setProgress(emptyProgress());
    let handle: SubmissionHandle | null = null;
    try {
      const transport: KernelTransport = sandboxReady && apiClient !== null
        ? new GatewayTransport({ client: apiClient })
        : new LocalSimulationTransport({ evaluate: evaluateResult });
      handle = await transport.start(validation.request, onEvent);
      handleRef.current = handle;
      await handle.finished;
    } catch (error) {
      setStatus('failed');
      setErrorMessage(error instanceof Error ? error.message : 'Submission failed');
    } finally {
      if (handleRef.current === handle) handleRef.current = null;
    }
  }, [apiClient, onEvent, sandboxReady, validation]);

  const cancel = useCallback(() => {
    handleRef.current?.cancel();
    handleRef.current = null;
    setStatus('idle');
    setLogs(previous => [...previous, { sequence: previous.length + 1, stream: 'system', text: 'Cancelled by user.' }]);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        if (!busy) void run();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, run]);

  return (
    <div className="flex min-h-screen flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-[#0b1120] px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400">
            <Zap size={18} />
          </span>
          <span>
            <h1 className="text-sm font-semibold text-slate-100">KernelForge Playground</h1>
            <p className="text-[11px] text-slate-400">Micro-benchmark roofline and data-movement visualizer</p>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={sandboxReady ? 'measured' : 'simulation'}>
            {sandboxReady ? 'transport: sandbox - submitted code runs in Docker' : 'transport: local simulation - code is never executed'}
          </Badge>
          <Badge tone={capabilities === null ? 'neutral' : 'measured'}>
            {capabilities === null
              ? 'backend: not reachable - local simulation'
              : `backend: ${capabilities.mode} - cuda ${capabilities.devices.cuda ? 'available' : 'unavailable'}`}
          </Badge>
          {capabilities?.mode === 'sandbox' && !capabilities.devices.cuda ? (
            <Badge tone="estimate">CPU-only worker - CUDA and Triton unavailable</Badge>
          ) : null}
          {API_BASE !== '' ? (
            <input
              type="password"
              value={runToken}
              onChange={event => setRunToken(event.target.value)}
              placeholder="run token (public mode)"
              aria-label="KernelForge run token"
              className="w-36 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200"
            />
          ) : null}
          <Badge tone="neutral" icon={<Gauge size={12} />}>{`status: ${status}`}</Badge>
          {busy ? (
            <button
              type="button"
              onClick={cancel}
              className="flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/20"
            >
              <Square size={14} /> {sandboxReady ? 'Detach' : 'Cancel'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { void run(); }}
              disabled={!validation.ok}
              className="flex items-center gap-2 rounded-lg bg-sky-500 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              <Play size={14} /> {sandboxReady ? 'Run benchmark' : 'Run simulation'} (Ctrl+Enter)
            </button>
          )}
        </div>
      </header>

      {!validation.ok ? (
        <p className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle size={14} /> Contract validation: {validation.detail}
        </p>
      ) : null}
      {errorMessage !== null ? (
        <p className="flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          <AlertTriangle size={14} /> {errorMessage}
        </p>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
        <div className="flex min-h-0 flex-col gap-3">
          <Panel
            title="Kernel source"
            icon={<Activity size={14} />}
            right={<LanguageControls
              language={language}
              device={device}
              capabilities={capabilities}
              onLanguage={applySample}
              onDevice={setDevice}
            />}
            contentClassName="min-h-[420px] p-0"
          >
            <CodeEditor value={code} language={language} onChange={setCode} />
          </Panel>

          <Panel title="Declared workload and hardware peaks" icon={<Cpu size={14} />}>
            <p className="mb-3 text-[11px] leading-5 text-slate-400">
              These are <span className="text-amber-300">estimates and specifications</span>, not measurements. FLOPs and
              transferred bytes describe the workload; the peaks describe a hardware class you declare yourself.
            </p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <NumberField
                label="FLOPs"
                value={workload.flops}
                step={1}
                onChange={value => setWorkload(previous => ({ ...previous, flops: Math.round(value) }))}
              />
              <NumberField
                label="Bytes transferred"
                value={workload.bytes}
                step={1}
                onChange={value => setWorkload(previous => ({ ...previous, bytes: Math.round(value) }))}
              />
              <NumberField label="Warmup iterations" value={warmup} step={1} onChange={value => setWarmup(Math.round(value))} />
              <NumberField label="Repetitions" value={repetitions} step={1} onChange={value => setRepetitions(Math.round(value))} />
              <NumberField
                label="Peak compute (TFLOP/s)"
                value={hardware.peak_compute_tflops}
                step={0.1}
                onChange={value => setHardware(previous => ({ ...previous, peak_compute_tflops: value }))}
              />
              <NumberField
                label="Peak bandwidth (GB/s)"
                value={hardware.peak_bandwidth_gbps}
                step={1}
                onChange={value => setHardware(previous => ({ ...previous, peak_bandwidth_gbps: value }))}
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {HARDWARE_PRESETS.map(preset => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => { setPresetId(preset.id); setHardware(preset.spec); }}
                  className={`rounded-lg border px-2 py-1 text-[11px] ${
                    presetId === preset.id
                      ? 'border-sky-500/60 bg-sky-500/10 text-sky-200'
                      : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <label className="mt-3 flex items-center gap-2 text-[11px] text-slate-400">
              Device label
              <input
                type="text"
                value={hardware.name}
                maxLength={120}
                onChange={event => setHardware(previous => ({ ...previous, name: event.target.value }))}
                className="kf-mono min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
              />
            </label>
          </Panel>

          <Panel title="Execution log" icon={<TerminalIcon />}>
            <div ref={consoleRef} className="kf-mono h-40 overflow-y-auto rounded-lg bg-slate-950 p-2 text-[11px] leading-5">
              {logs.length === 0 ? (
                <p className="text-slate-500">
                  No events yet. Run a benchmark to stream status, log, trace and result events.
                </p>
              ) : (
                logs.map(line => (
                  <p key={line.sequence} className={line.stream === 'stderr' ? 'text-rose-300' : 'text-slate-300'}>
                    <span className="text-slate-600">{String(line.sequence).padStart(3, '0')} </span>
                    {line.text}
                  </p>
                ))
              )}
            </div>
          </Panel>

          <ChallengePanel
            onLoadStarter={loadStarter}
            disabled={capabilities?.mode === 'sandbox'}
            disabledReason="Challenge execution is not in the CPU MVP"
          />

          <Panel title={`Run history (last ${history.length})`} icon={<History size={14} />}>
            {history.length === 0 ? (
              <p className="text-[11px] text-slate-500">
                No saved runs yet. Local history is stored in this browser only (localStorage, last 20); sandbox submissions are persisted by the gateway for results and sharing.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {history.map(entry => (
                  <li
                    key={`${entry.savedAt}-${entry.language}-${entry.latency_ms}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2"
                  >
                    <span className="kf-mono text-[11px] text-slate-300">
                      {`${new Date(entry.savedAt).toLocaleTimeString()} - ${entry.language}/${entry.device} - ${entry.latency_ms.toFixed(3)} ms - AI ${entry.arithmetic_intensity === null ? 'n/a' : entry.arithmetic_intensity.toFixed(3)} FLOP/byte - ${entry.bottleneck ?? 'n/a'}`}
                    </span>
                    <button
                      type="button"
                      onClick={() => restoreFromHistory(entry)}
                      className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-200 hover:border-slate-400"
                    >
                      Restore code
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="flex min-h-0 flex-col gap-3">
          <Panel title="Data movement pipeline" icon={<Activity size={14} />} contentClassName="p-2">
            <MemoryPipeline
              progress={progress}
              running={busy}
              device={device}
              bytesTransferred={workload.bytes}
              latencyMs={result === null ? null : result.latency_ms}
              timing={result === null ? null : result.provenance.timing}
              bottleneck={result === null ? null : result.bottleneck}
            />
          </Panel>

          <Panel title="Derived metrics" icon={<Gauge size={14} />}>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <MetricCard
                label="Median latency"
                value={result === null ? '-' : formatNumber(result.latency_ms, 3, 'ms')}
                hint={result?.provenance.timing === 'measured' ? 'median of synchronized samples' : 'median of simulated samples'}
              />
              <MetricCard
                label="Memory bandwidth"
                value={result === null ? '-' : formatNumber(result.memory_throughput_gbps, 4, 'GB/s')}
                hint="bytes / time / 1e9"
              />
              <MetricCard
                label="Compute"
                value={result === null ? '-' : formatNumber(result.compute_tflops, 4, 'TFLOP/s')}
                hint="FLOPs / time / 1e12"
              />
              <MetricCard
                label="Arithmetic intensity"
                value={result === null ? '-' : formatNumber(result.arithmetic_intensity, 4, 'FLOP/byte')}
                hint="FLOPs / bytes"
              />
              <MetricCard
                label="Roofline bound at AI"
                value={result === null ? '-' : formatNumber(result.attainable_tflops, 4, 'TFLOP/s')}
                hint="min(peak compute, BW x AI)"
              />
              <MetricCard
                label="Fraction of bound"
                value={
                  result === null || result.attainable_tflops === null || result.attainable_tflops <= 0
                    ? '-'
                    : `${((result.compute_tflops / result.attainable_tflops) * 100).toFixed(1)}%`
                }
                hint="achieved / bound (model)"
              />
              <MetricCard
                label="Bottleneck"
                value={result === null || result.bottleneck === null ? '-' : result.bottleneck === 'memory' ? 'memory roof' : 'compute roof'}
                hint="AI vs ridge point (derived)"
              />
              <MetricCard
                label="Workload source"
                value={result === null ? '-' : result.workload_source === 'user_estimate' ? 'declared (estimate)' : result.workload_source}
                hint={result !== null && result.ignored_metadata ? 'returned metadata was ignored' : 'protocol metadata'}
              />
              <MetricCard label="PCIe transfer" value="not measured" hint="no link instrumentation yet" />
              <MetricCard label="Challenge pass" value="n/a" hint="no evaluator or baseline kernel yet" />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge tone={result !== null && result.provenance.timing === 'measured' ? 'measured' : 'simulation'}>
                {`timing: ${result === null ? 'pending' : result.provenance.timing}`}
              </Badge>
              <Badge tone="estimate">{`workload: ${result === null ? 'user_estimate' : result.provenance.workload}`}</Badge>
              <Badge tone="simulation">{`movement: ${result === null ? 'simulation' : result.provenance.movement}`}</Badge>
              <Badge tone="neutral">{`hardware: ${hardware.name}`}</Badge>
            </div>
            {result !== null && result.correctness.checked ? (
              <p className={`mt-3 rounded-lg border px-3 py-2 text-[11px] ${result.correctness.passed ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-rose-500/40 bg-rose-500/10 text-rose-200'}`}>
                {`Correctness vs baseline: ${result.correctness.passed ? 'passed' : 'failed'} (max abs error ${result.correctness.max_abs_error === null ? 'n/a' : result.correctness.max_abs_error.toExponential(3)}, atol ${result.correctness.atol}, rtol ${result.correctness.rtol})`}
              </p>
            ) : null}
            {result !== null && result.baseline !== null ? (
              <p className="mt-3 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-[11px] text-sky-200">
                {`Baseline ${result.baseline.name}: ${result.baseline.latency_ms.toFixed(3)} ms median - speedup ${result.baseline.speedup.toFixed(2)}x`}
              </p>
            ) : null}
            {result !== null && result.short_id !== null ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => { void shareResult(); }}
                  className="rounded-lg border border-slate-600 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 hover:border-slate-400"
                >
                  Copy share link
                </button>
                {shareNotice !== null ? <span className="text-[11px] text-slate-400">{shareNotice}</span> : null}
              </div>
            ) : (
              <p className="mt-3 text-[11px] text-slate-500">
                Share links appear once a gateway persists the run and returns a short_id; local simulation runs stay in this browser only.
              </p>
            )}
            {sandboxReady ? (
              <p className="mt-3 text-[11px] leading-5 text-slate-400">
                Sandbox timing is measured by the isolated runner. FLOPs and bytes come from the benchmark protocol;
                movement remains derived from the returned workload, and the ridge point is {formatSi(ridgePointAi(hardware))} FLOP/byte.
              </p>
            ) : (
              <p className="mt-3 text-[11px] leading-5 text-slate-400">
                Simulation model: latency = max(FLOPs / peak compute, bytes / peak bandwidth) divided by an assumed
                efficiency (0.62 on cuda, 0.38 on cpu) with deterministic +/-6% jitter seeded from the source text. Ridge
                point sits at AI = peak compute x 1000 / peak bandwidth = {formatSi(ridgePointAi(hardware))} FLOP/byte.
                Nothing here is a hardware counter reading, and challenge pass cannot be decided from self-reported
                numbers.
              </p>
            )}
          </Panel>

          <Panel
            title="Roofline model (log-log)"
            icon={<Zap size={14} />}
            className="min-h-[320px] flex-1"
            contentClassName="p-2"
          >
            <RooflineChart hardware={hardware} result={result} />
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Panel({
  title,
  icon,
  right,
  children,
  className = '',
  contentClassName = 'p-3',
}: {
  title: string;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <section className={`flex min-h-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-[#0b1120] ${className}`}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-3 py-2">
        <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          {icon}
          {title}
        </h2>
        {right}
      </header>
      <div className={`min-h-0 flex-1 overflow-auto ${contentClassName}`}>{children}</div>
    </section>
  );
}

function Badge({
  tone,
  icon,
  children,
}: {
  tone: 'simulation' | 'measured' | 'estimate' | 'neutral';
  icon?: ReactNode;
  children: ReactNode;
}) {
  const tones: Record<typeof tone, string> = {
    simulation: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
    measured: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
    estimate: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
    neutral: 'border-slate-700 bg-slate-900 text-slate-300',
  };
  return (
    <span className={`flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] ${tones[tone]}`}>
      {icon}
      {children}
    </span>
  );
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="kf-mono truncate text-sm text-slate-100" title={value}>{value}</p>
      {hint === undefined ? null : <p className="text-[10px] text-slate-500">{hint}</p>}
    </div>
  );
}

function NumberField({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-slate-500">
      {label}
      <input
        type="number"
        step={step}
        value={Number.isFinite(value) ? value : ''}
        onChange={event => {
          const parsed = Number(event.target.value);
          if (event.target.value !== '' && Number.isFinite(parsed)) onChange(parsed);
        }}
        className="kf-mono rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs normal-case tracking-normal text-slate-100"
      />
    </label>
  );
}

function LanguageControls({
  language,
  device,
  capabilities,
  onLanguage,
  onDevice,
}: {
  language: Language;
  device: Device;
  capabilities: ApiCapabilities | null;
  onLanguage: (next: Language) => void;
  onDevice: (next: Device) => void;
}) {
  const sandbox = capabilities?.mode === 'sandbox';
  const selectClass = 'rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 disabled:opacity-60';
  return (
    <span className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
      <select
        aria-label="Language"
        value={language}
        onChange={event => onLanguage(event.target.value as Language)}
        className={selectClass}
      >
        {SAMPLES.map(sample => (
          <option
            key={sample.id}
            value={sample.language}
            disabled={sandbox && !capabilities.languages[sample.language]}
          >
            {sample.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Device"
        value={device}
        onChange={event => onDevice(event.target.value as Device)}
        className={selectClass}
        title={sandbox ? 'Devices reported by the isolated worker' : 'Declared execution device'}
      >
        <option value="cpu" disabled={sandbox && !capabilities.devices.cpu}>cpu</option>
        <option value="cuda" disabled={sandbox && !capabilities.devices.cuda}>cuda</option>
      </select>
    </span>
  );
}

function TerminalIcon() {
  return <Terminal size={14} />;
}
