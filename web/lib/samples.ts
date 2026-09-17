import type { Device, HardwareSpec, Language, WorkloadEstimate, WorkloadMode } from './roofline';

/**
 * Starter samples. FLOP/byte figures are hand-derived ESTIMATES for the
 * declared problem size, exactly as the tracing agent would report them for a
 * real run; they are inputs to the roofline model, not measurements.
 */
export interface Sample {
  id: string;
  label: string;
  language: Language;
  device: Device;
  code: string;
  workload_mode: WorkloadMode;
  workload: WorkloadEstimate;
  note: string;
}

const VECTOR_ADD_CPU = `import math


def setup():
    """Runs once before warmup on the runner. Keep allocations here."""
    global size, a, b, out
    size = 1 << 20
    a = [1.0] * size
    b = [2.0] * size
    out = [0.0] * size


def benchmark():
    """Timed region.

    KernelForge protocol: return a mapping with an "output" key plus the
    FLOP and byte counts this kernel actually moves. Pure-Python floats are
    IEEE double, so one add per element moves 3 arrays * 8 bytes.
    """
    for index in range(size):
        out[index] = a[index] + b[index]
    return {"output": out[:16], "flops": size, "bytes": 3 * size * 8}
`;

const MATMUL_TORCH = `import torch


def setup():
    """Runs once before warmup; CUDA tensors are created here."""
    global a, b
    torch.manual_seed(0)
    a = torch.randn(1024, 1024, device="cuda")
    b = torch.randn(1024, 1024, device="cuda")


def benchmark():
    """Timed region. The agent synchronises CUDA around this call.

    2 * n^3 FLOPs and 3 fp32 n^2 tiles (2 reads + 1 write) are moved.
    """
    out = a @ b
    n = a.shape[0]
    return {"output": float(out[0, 0]), "flops": 2 * n * n * n, "bytes": 3 * n * n * 4}
`;

const ADD_TRITON = `import torch
import triton
import triton.language as tl


@triton.jit
def add_kernel(x_ptr, y_ptr, out_ptr, n, BLOCK: tl.constexpr):
    pid = tl.program_id(0)
    offsets = pid * BLOCK + tl.arange(0, BLOCK)
    mask = offsets < n
    x = tl.load(x_ptr + offsets, mask=mask)
    y = tl.load(y_ptr + offsets, mask=mask)
    tl.store(out_ptr + offsets, x + y, mask=mask)


def setup():
    global x, y, out, n
    n = 1 << 22
    x = torch.randn(n, device="cuda")
    y = torch.randn(n, device="cuda")
    out = torch.empty_like(x)


def benchmark():
    """Timed region. One fp32 add per element moves 3 arrays * 4 bytes."""
    grid = (triton.cdiv(n, 1024),)
    add_kernel[grid](x, y, out, n, BLOCK=1024)
    return {"output": float(out[0]), "flops": n, "bytes": 3 * n * 4}
`;

export const SAMPLES: Sample[] = [
  {
    id: 'vector-add-cpu',
    label: 'Vector add (pure Python)',
    language: 'python',
    device: 'cpu',
    workload_mode: 'protocol',
    code: VECTOR_ADD_CPU,
    workload: { flops: 1_048_576, bytes_transferred: 25_165_824 },
    note: 'N=2^20 fp64 adds: 1 FLOP/element, 3 arrays x 8 bytes -> AI 0.042 FLOP/byte (memory bound).',
  },
  {
    id: 'matmul-pytorch',
    label: 'Matmul 1024^3 (PyTorch)',
    language: 'pytorch',
    device: 'cuda',
    workload_mode: 'protocol',
    code: MATMUL_TORCH,
    workload: { flops: 2_147_483_648, bytes_transferred: 12_582_912 },
    note: '2*1024^3 FLOPs (2.1 GFLOP), 3 fp32 1024^2 tiles -> AI ~171 FLOP/byte (compute bound).',
  },
  {
    id: 'vector-add-triton',
    label: 'Vector add (Triton)',
    language: 'triton',
    device: 'cuda',
    workload_mode: 'protocol',
    code: ADD_TRITON,
    workload: { flops: 4_194_304, bytes_transferred: 50_331_648 },
    note: 'N=2^22 fp32 adds with a @triton.jit kernel -> AI 0.083 FLOP/byte (memory bound).',
  },
];

export interface HardwarePreset {
  id: string;
  label: string;
  spec: HardwareSpec;
  note: string;
}

/**
 * NOMINAL datasheet-class values, NOT detected hardware. T4 comes first
 * because it matches the free Google Colab GPU, so results can be compared
 * against a well-known card. On a real deployment the runner probes the
 * device; here the user picks a class and may edit the numbers.
 */
export const HARDWARE_PRESETS: HardwarePreset[] = [
  {
    id: 't4',
    label: 'NVIDIA T4 (Colab class)',
    spec: { name: 'NVIDIA T4 (nominal)', peak_compute_tflops: 8.1, peak_bandwidth_gbps: 320 },
    note: 'Free-tier Colab GPU: 16 GB GDDR6, ~8.1 TFLOP/s fp32 and ~320 GB/s nominal. Edit to match your device.',
  },
  {
    id: 'datacenter-gpu',
    label: 'A100 class',
    spec: { name: 'A100 class (nominal)', peak_compute_tflops: 19.5, peak_bandwidth_gbps: 1555 },
    note: 'Nominal fp32 peaks of an A100 40GB accelerator. Edit to match your device.',
  },
  {
    id: 'consumer-gpu',
    label: 'Consumer GPU class',
    spec: { name: 'Consumer GPU class (nominal)', peak_compute_tflops: 82.6, peak_bandwidth_gbps: 1008 },
    note: 'Nominal fp32 peaks of a flagship consumer GPU. Edit to match your device.',
  },
  {
    id: 'cpu-socket',
    label: 'CPU socket class',
    spec: { name: 'CPU socket class (nominal)', peak_compute_tflops: 0.8, peak_bandwidth_gbps: 60 },
    note: 'Nominal scalar fp32 throughput and DDR bandwidth for a server socket.',
  },
];

export function sampleFor(language: Language): Sample {
  return SAMPLES.find(sample => sample.language === language) ?? SAMPLES[0];
}
