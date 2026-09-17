import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { calculateMetrics, validateSubmission } from '../demo/metrics.mjs';

// HTTP transport smoke test only: never executes the submitted code.
const payload = {
  code: 'def benchmark():\n    return {"output": 1.0, "flops": 1000, "bytes": 8000}\n',
  language: 'python', device: 'cpu', warmup: 2, repetitions: 10,
  workload_mode: 'protocol',
  workload: { flops: 1000, bytes_transferred: 8000 },
  hardware: { name: 'Example specification', peak_compute_tflops: 10, peak_bandwidth_gbps: 500 },
  challenge_slug: null,
};
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST' || req.url !== '/smoke/submissions') {
    res.writeHead(404).end(JSON.stringify({ detail: 'Not found' }));
    return;
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 70000) {
        res.writeHead(413).end(JSON.stringify({ detail: 'Body too large' }));
        return;
      }
      chunks.push(chunk);
    }
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!validateSubmission(request)) {
      res.writeHead(422).end(JSON.stringify({ detail: 'Invalid submission' }));
      return;
    }
    res.writeHead(200).end(JSON.stringify({
      mode: 'simulation', result: calculateMetrics(request, [1.2], 'simulation'),
    }));
  } catch {
    res.writeHead(400).end(JSON.stringify({ detail: 'Invalid request' }));
  }
});

try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/smoke/submissions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const { mode, result } = await response.json();
  assert.equal(mode, 'simulation');
  assert.equal(result.provenance.timing, 'simulation');
  assert.equal(result.latency_ms, 1.2);
  assert.equal(result.arithmetic_intensity, 0.125);
  assert.ok(Math.abs(result.memory_throughput_gbps - 0.006666666666666667) < 1e-15);
  assert.ok(Math.abs(result.compute_tflops - 0.0000008333333333333334) < 1e-18);
  assert.equal(result.attainable_tflops, 0.0625);
  assert.equal(result.pcie_transfer_ms, null);
  assert.equal(result.passed, null);
  console.log('PASS: real HTTP POST on ephemeral loopback port returned 200');
  console.log('PASS: latency=1.2 ms, AI=0.125 FLOPs/byte');
  console.log('PASS: bandwidth=0.006666666666666667 GB/s, compute=8.333333333333334e-7 TFLOP/s');
  console.log('PASS: roofline=0.0625 TFLOP/s; timing explicitly simulation');
} finally {
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}
