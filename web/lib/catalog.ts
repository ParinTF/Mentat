import type { Device, Language } from '@/lib/roofline';

/**
 * Local mirror of the challenge catalog for offline UI work. The authoritative
 * list lives in `challenges/manifest.json` and will be served by the gateway;
 * keep this file in sync until that endpoint exists.
 */

export type TargetMetric = 'speedup' | 'bandwidth_efficiency' | 'compute_efficiency';

export interface ChallengeEntry {
  slug: string;
  title: string;
  concept: string;
  language: Language;
  device: Device;
  theory: string;
  theory_params: Record<string, number>;
  target_metric: TargetMetric;
  threshold: number;
  starter_code: string;
}

export interface ConceptNode {
  slug: string;
  title: string;
  description: string;
  prerequisites: string[];
  challenges: string[];
}

export const CHALLENGE_CATALOG: ChallengeEntry[] = [
  {
    slug: 'vector-add-1m',
    title: 'Coalesced vector add (N = 2^20)',
    concept: 'memory-coalescing',
    language: 'pytorch',
    device: 'cuda',
    theory: 'vector_add',
    theory_params: { n: 1_048_576, itemsize: 4 },
    target_metric: 'speedup',
    threshold: 1.5,
    starter_code: `import torch


def setup():
    global a, b, out, n
    n = 1 << 20
    a = torch.randn(n, device="cuda")
    b = torch.randn(n, device="cuda")
    out = torch.empty_like(a)


def benchmark():
    # TODO: write the add so that reads/writes stay coalesced.
    # Protocol: return the output plus the FLOP and byte counts.
    for index in range(n):
        out[index] = a[index] + b[index]
    return {"output": out, "flops": 0, "bytes": 0}
`,
  },
  {
    slug: 'matmul-1024',
    title: 'Matmul 1024^3 (be the naive baseline)',
    concept: 'roofline-model',
    language: 'pytorch',
    device: 'cuda',
    theory: 'matmul',
    theory_params: { n: 1024, itemsize: 4 },
    target_metric: 'speedup',
    threshold: 1.2,
    starter_code: `import torch


def setup():
    global a, b
    torch.manual_seed(0)
    a = torch.randn(1024, 1024, device="cuda")
    b = torch.randn(1024, 1024, device="cuda")


def benchmark():
    # TODO: replace the naive triple loop with a tiled kernel.
    # Protocol: return the output plus the FLOP and byte counts.
    out = torch.zeros(1024, 1024, device="cuda")
    return {"output": out, "flops": 0, "bytes": 0}
`,
  },
  {
    slug: 'bandwidth-sweep',
    title: 'Reach 60% of the memory roof',
    concept: 'memory-coalescing',
    language: 'pytorch',
    device: 'cuda',
    theory: 'vector_add',
    theory_params: { n: 4_194_304, itemsize: 4 },
    target_metric: 'bandwidth_efficiency',
    threshold: 0.6,
    starter_code: `import torch


def setup():
    global a, b, out, n
    n = 1 << 22
    a = torch.randn(n, device="cuda")
    b = torch.randn(n, device="cuda")
    out = torch.empty_like(a)


def benchmark():
    # TODO: keep the three streams coalesced and wide.
    # Protocol: return the output plus the FLOP and byte counts.
    out = a + b
    return {"output": out, "flops": n, "bytes": 3 * n * 4}
`,
  },
];

export const CONCEPT_TREE: ConceptNode[] = [
  {
    slug: 'roofline-model',
    title: 'Roofline model',
    description:
      'Attainable TFLOP/s = min(peak compute, peak bandwidth x AI). Arithmetic intensity (FLOP/byte) decides which roof binds.',
    prerequisites: [],
    challenges: ['matmul-1024'],
  },
  {
    slug: 'memory-coalescing',
    title: 'Memory coalescing',
    description:
      'Consecutive threads must touch consecutive addresses so one transaction serves many lanes; otherwise the kernel burns bandwidth.',
    prerequisites: ['roofline-model'],
    challenges: ['vector-add-1m', 'bandwidth-sweep'],
  },
  {
    slug: 'occupancy',
    title: 'Occupancy and tiling',
    description:
      'Shared-memory tiling raises arithmetic intensity per global byte and hides latency; too small a tile starves the SMs.',
    prerequisites: ['memory-coalescing'],
    challenges: ['matmul-1024'],
  },
  {
    slug: 'vectorization',
    title: 'Vectorized access',
    description:
      'Wider loads (float4, vectorized ld/st) cut instruction overhead and raise achieved bandwidth toward the roof.',
    prerequisites: ['memory-coalescing'],
    challenges: ['bandwidth-sweep'],
  },
];

export function challengesForConcept(slug: string): ChallengeEntry[] {
  return CHALLENGE_CATALOG.filter(entry => entry.concept === slug);
}