'use client';

import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { BenchmarkResult, HardwareSpec } from '@/lib/roofline';
import { formatSi, logTicks, ridgePointAi, rooflineCurve } from '@/lib/roofline';

interface ChartPoint {
  ai: number;
  bound: number | null;
  achieved: number | null;
}

interface RooflineChartProps {
  hardware: HardwareSpec;
  result: BenchmarkResult | null;
}

/**
 * Log-log roofline: the boundary line is min(peak compute, peak bandwidth * AI)
 * evaluated from the peaks in the panel, and the marker is the submitted
 * workload's simulated operating point.
 */
export default function RooflineChart({ hardware, result }: RooflineChartProps) {
  const curve = rooflineCurve(hardware, 1e-3, 1e4, 80);
  const ridge = ridgePointAi(hardware);
  const bounds = curve.map(sample => sample.bound);
  const yMin = Math.max(1e-6, Math.min(...bounds) / 2);
  const yMax = Math.max(...bounds) * 2;

  const data: ChartPoint[] = curve.map(sample => ({ ai: sample.ai, bound: sample.bound, achieved: null }));
  const achievedAi = result?.arithmetic_intensity ?? null;
  if (result !== null && achievedAi !== null && achievedAi > 0) {
    data.push({ ai: achievedAi, bound: null, achieved: result.compute_tflops });
  }

  const xTicks = logTicks(1e-3, 1e4);
  const yTicks = logTicks(yMin, yMax);

  return (
    <div className="h-full w-full min-h-[240px]">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 16, right: 24, bottom: 28, left: 8 }}>
          <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
          <XAxis
            dataKey="ai"
            type="number"
            scale="log"
            domain={[1e-3, 1e4]}
            ticks={xTicks}
            allowDataOverflow
            tickFormatter={value => formatSi(Number(value))}
            stroke="#475569"
            tick={{ fill: '#94a3b8', fontSize: 11 }}
            label={{ value: 'Arithmetic intensity (FLOP/byte)', position: 'insideBottom', offset: -16, fill: '#94a3b8', fontSize: 11 }}
          />
          <YAxis
            dataKey="bound"
            type="number"
            scale="log"
            domain={[yMin, yMax]}
            ticks={yTicks}
            allowDataOverflow
            tickFormatter={value => formatSi(Number(value))}
            stroke="#475569"
            tick={{ fill: '#94a3b8', fontSize: 11 }}
            label={{ value: 'TFLOP/s', angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 11 }}
          />
          <Tooltip
            contentStyle={{ background: '#0b1120', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 }}
            labelFormatter={value => `AI = ${formatSi(Number(value))} FLOP/byte`}
            formatter={(value, name) => {
              if (value === null || value === undefined) return ['-', String(name)];
              return [`${Number(value).toFixed(4)} TFLOP/s`, String(name)];
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: '#94a3b8' }} />
          <Line
            type="monotone"
            dataKey="bound"
            name="Roofline bound: min(peak compute, peak BW x AI)"
            stroke="#38bdf8"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
          <Scatter
            dataKey="achieved"
            name="Submitted workload (model)"
            fill="#f97316"
            isAnimationActive={false}
          />
          <ReferenceLine x={ridge} stroke="#f59e0b" strokeDasharray="4 4" />
          <ReferenceLine y={hardware.peak_compute_tflops} stroke="#64748b" strokeDasharray="4 4" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
