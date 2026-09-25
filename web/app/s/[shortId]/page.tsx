import { notFound } from 'next/navigation';
import { ApiClient, ApiError } from '@/lib/api';
import type { ShareSnapshot } from '@/lib/api';
import { formatNumber } from '@/lib/roofline';

export const dynamic = 'force-dynamic';

const SHORT_ID = /^[0-9A-HJKMNP-TV-Z]{8}$/;

export default async function SharePage({ params }: { params: Promise<{ shortId: string }> }) {
  const { shortId } = await params;
  const shortIdNormalized = shortId.toUpperCase();
  if (!SHORT_ID.test(shortIdNormalized)) notFound();
  const base = (process.env.KF_INTERNAL_API ?? process.env.NEXT_PUBLIC_KF_API ?? '').trim();
  if (base === '') {
    return (
      <main className="mx-auto flex min-h-screen max-w-4xl items-center p-6 text-sm text-slate-300">
        KernelForge API is not configured for shared snapshots.
      </main>
    );
  }
  let snapshot: ShareSnapshot;
  const client = new ApiClient(base);
  try {
    snapshot = await client.getShare(shortIdNormalized, AbortSignal.timeout(5000));
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  let status: string | null = null;
  let errorMessage: string | null = null;
  if (snapshot.result === null) {
    try {
      const current = await client.getSubmission(snapshot.submission_id, AbortSignal.timeout(5000));
      status = current.status;
      errorMessage = current.error;
    } catch {
      status = 'unknown';
    }
  }
  const result = snapshot.result;
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 p-6">
      <header className="rounded-xl border border-slate-800 bg-[#0b1120] p-5">
        <p className="text-[11px] uppercase tracking-wide text-sky-400">KernelForge shared benchmark</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-100">{snapshot.short_id}</h1>
        <p className="mt-2 text-xs text-slate-400">
          {snapshot.language}/{snapshot.device} · created {new Date(snapshot.created_at).toLocaleString()}
        </p>
      </header>
      {result === null ? (
        <section className="rounded-xl border border-slate-800 bg-[#0b1120] p-5 text-sm text-amber-200">
          {status === 'failed' || status === 'timed_out'
            ? `Submission ${status === 'timed_out' ? 'timed out' : 'failed'}${errorMessage === null ? '' : `: ${errorMessage}`}`
            : 'This submission is still running.'}
        </section>
      ) : (
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Median latency" value={formatNumber(result.latency_ms, 3, 'ms')} />
          <Metric label="Memory bandwidth" value={formatNumber(result.memory_throughput_gbps, 4, 'GB/s')} />
          <Metric label="Compute" value={formatNumber(result.compute_tflops, 4, 'TFLOP/s')} />
          <Metric label="Arithmetic intensity" value={formatNumber(result.arithmetic_intensity, 4, 'FLOP/byte')} />
          <Metric label="Roofline bound" value={formatNumber(result.attainable_tflops, 4, 'TFLOP/s')} />
          <Metric label="Bottleneck" value={result.bottleneck ?? 'undefined'} />
          <Metric label="Timing" value={result.provenance.timing} />
          <Metric label="Workload" value={result.provenance.workload} />
        </section>
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-[#0b1120] p-4">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="kf-mono mt-1 truncate text-sm text-slate-100" title={value}>{value}</p>
    </section>
  );
}
