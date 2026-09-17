'use client';

import type { Device, Stage } from '@/lib/roofline';

interface StageNode {
  stage: Stage;
  label: string;
  detail: string;
  usedByCpu: boolean;
}

const NODES: StageNode[] = [
  { stage: 'host_ram', label: 'Host RAM', detail: 'pinned host buffers', usedByCpu: true },
  { stage: 'pcie', label: 'PCIe', detail: 'host <-> device link', usedByCpu: false },
  { stage: 'vram', label: 'VRAM', detail: 'device global memory', usedByCpu: false },
  { stage: 'sram', label: 'SRAM / L2', detail: 'shared memory + cache', usedByCpu: true },
  { stage: 'cores', label: 'SM Cores', detail: 'compute units', usedByCpu: true },
];

const BOX_WIDTH = 120;
const BOX_HEIGHT = 100;
const BOX_Y = 80;
const BOX_STEP = 180;
const BOX_X0 = 20;
const CENTER_Y = BOX_Y + BOX_HEIGHT / 2;

interface MemoryPipelineProps {
  progress: Record<Stage, number>;
  running: boolean;
  device: Device;
  bytesTransferred: number;
  latencyMs: number | null;
}

function formatBytes(bytes: number): string {
  const units: Array<[number, string]> = [[1e9, 'GB'], [1e6, 'MB'], [1e3, 'kB']];
  for (const [scale, suffix] of units) {
    if (bytes >= scale) return `${(bytes / scale).toFixed(2)} ${suffix}`;
  }
  return `${bytes} B`;
}

export default function MemoryPipeline({
  progress,
  running,
  device,
  bytesTransferred,
  latencyMs,
}: MemoryPipelineProps) {
  return (
    <section className="flex h-full flex-col gap-2">
      <svg viewBox="0 0 900 250" role="img" aria-label="Illustrated data movement path" className="w-full">
        {NODES.map((node, index) => {
          const x = BOX_X0 + index * BOX_STEP;
          const inapplicable = !node.usedByCpu && device === 'cpu';
          const value = progress[node.stage] ?? 0;
          const active = running && value > 0 && value < 1 && !inapplicable;
          const complete = value >= 1 && !inapplicable;
          const stroke = active ? '#f59e0b' : complete ? '#10b981' : '#1e293b';
          const barWidth = Math.max(0, Math.min(1, inapplicable ? 0 : value)) * (BOX_WIDTH - 28);
          return (
            <g key={node.stage} opacity={inapplicable ? 0.45 : 1}>
              <rect
                x={x}
                y={BOX_Y}
                width={BOX_WIDTH}
                height={BOX_HEIGHT}
                rx={10}
                fill="#0b1120"
                stroke={stroke}
                strokeWidth={active ? 2 : 1.5}
              />
              <text x={x + BOX_WIDTH / 2} y={BOX_Y + 30} textAnchor="middle" fontSize={13} fill="#e2e8f0" fontWeight={600}>
                {node.label}
              </text>
              <text x={x + BOX_WIDTH / 2} y={BOX_Y + 48} textAnchor="middle" fontSize={10} fill="#94a3b8">
                {inapplicable ? 'not used on CPU' : node.detail}
              </text>
              <text
                x={x + BOX_WIDTH / 2}
                y={BOX_Y + 68}
                textAnchor="middle"
                fontSize={10}
                fill={active ? '#fbbf24' : complete ? '#34d399' : '#64748b'}
              >
                {inapplicable ? 'n/a' : `${Math.round(value * 100)}%`}
              </text>
              <rect x={x + 14} y={BOX_Y + 76} width={BOX_WIDTH - 28} height={6} rx={3} fill="#1e293b" />
              {barWidth > 0 ? (
                <rect x={x + 14} y={BOX_Y + 76} width={barWidth} height={6} rx={3} fill={complete ? '#10b981' : '#f59e0b'} />
              ) : null}
            </g>
          );
        })}

        {NODES.slice(0, -1).map((node, index) => {
          const from = BOX_X0 + index * BOX_STEP + BOX_WIDTH;
          const inapplicable = !node.usedByCpu && device === 'cpu';
          const flowing = running && !inapplicable;
          return (
            <g key={`link-${node.stage}`}>
              <line
                x1={from}
                y1={CENTER_Y}
                x2={from + 60}
                y2={CENTER_Y}
                stroke={flowing ? '#38bdf8' : '#1e293b'}
                strokeWidth={3}
                className={flowing ? 'kf-dash' : undefined}
                strokeDasharray="8 8"
              />
              {[0, 1, 2].map(packet => (
                <circle
                  key={packet}
                  cx={from + 2}
                  cy={CENTER_Y}
                  r={5}
                  fill="#38bdf8"
                  className={flowing ? `kf-packet${packet === 0 ? '' : `-${packet + 1}`}` : 'kf-packet-idle'}
                />
              ))}
            </g>
          );
        })}

        <text x={BOX_X0} y={30} fontSize={12} fill="#94a3b8">
          {'Illustrated path: synthetically advanced - no memory counters were read'}
        </text>
        <text x={BOX_X0} y={214} fontSize={11} fill="#64748b">
          {`device=${device}  |  declared traffic=${formatBytes(bytesTransferred)}  |  ${
            latencyMs === null ? 'latency: not measured yet' : `simulated median latency=${latencyMs.toFixed(3)} ms`
          }`}
        </text>
      </svg>
    </section>
  );
}
