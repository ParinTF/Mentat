import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { calculateMetrics, validateSubmission } from '../demo/metrics.mjs';

// Real HTTP + FIFO + worker-thread transport; synthetic timing, no code execution.
if (!isMainThread) {
  parentPort.on('message', ({ id, request }) => {
    parentPort.postMessage({ id, result: calculateMetrics(request, [1.2]) });
  });
} else {
  const worker = new Worker(new URL(import.meta.url));
  const jobs = new Map();
  const queue = [];
  let busy = false;
  function drain() {
    if (busy || !queue.length) return;
    busy = true;
    const job = queue.shift();
    job.status = 'running';
    worker.postMessage({ id: job.submission_id, request: job.request });
  }
  worker.on('message', ({ id, result }) => {
    Object.assign(jobs.get(id), { result, status: 'completed' });
    busy = false;
    drain();
  });
  worker.on('error', error => {
    for (const job of jobs.values()) if (job.status !== 'completed') Object.assign(job, { status: 'failed', error: error.message });
  });
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const send = (status, body) => res.writeHead(status).end(JSON.stringify(body));
    if (req.method === 'GET') {
      const job = jobs.get(req.url.split('/').pop());
      return job ? send(200, { submission_id: job.submission_id, status: job.status, mode: 'simulation', result: job.result, error: job.error }) : send(404, { detail: 'Not found' });
    }
    if (req.method !== 'POST' || req.url !== '/smoke/submissions') return send(404, { detail: 'Not found' });
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 70000) return send(413, { detail: 'Body too large' });
      }
      const request = JSON.parse(body);
      if (!validateSubmission(request)) return send(422, { detail: 'Invalid submission' });
      const id = randomUUID();
      const job = { submission_id: id, request, status: 'queued', result: null, error: null };
      jobs.set(id, job);
      queue.push(job);
      send(202, { submission_id: id, status: 'queued', mode: 'simulation' });
      setImmediate(drain);
    } catch { send(400, { detail: 'Invalid JSON' }); }
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/smoke/submissions`;
    const payload = { code: 'def benchmark(): return 1', language: 'python', device: 'cpu', warmup: 0, repetitions: 1, workload_mode: 'declared', workload: { flops: 1000, bytes_transferred: 8000 }, hardware: { name: 'Example', peak_compute_tflops: 10, peak_bandwidth_gbps: 500 }, challenge_slug: null };
    const response = await fetch(url, { method: 'POST', body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 202);
    const { submission_id } = await response.json();
    let snapshot;
    for (let i = 0; i < 100; i++) {
      const poll = await fetch(`${url}/${submission_id}`, { signal: AbortSignal.timeout(1000) });
      assert.equal(poll.status, 200);
      snapshot = await poll.json();
      if (snapshot.status === 'completed' || snapshot.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(snapshot.status, 'completed');
    assert.equal(snapshot.result.arithmetic_intensity, 0.125);
    assert.equal(snapshot.result.attainable_tflops, 0.0625);
    assert.equal(snapshot.result.provenance.timing, 'simulation');
    console.log('PASS: HTTP 202 -> FIFO queue -> real worker thread -> GET completed; simulation only');
  } finally {
    await worker.terminate();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}
