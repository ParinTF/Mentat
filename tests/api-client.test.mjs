import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, ApiError, parseCapabilities } from '../web/lib/api.ts';

const request = {
  code: 'def benchmark():\n    return {"output": 1, "flops": 1000, "bytes": 8000}\n',
  language: 'python',
  device: 'cpu',
  warmup: 1,
  repetitions: 2,
  workload_mode: 'protocol',
  workload: { flops: 1000, bytes_transferred: 8000 },
  hardware: { name: 'CPU', peak_compute_tflops: 1, peak_bandwidth_gbps: 20 },
  challenge_slug: null,
};

const capabilities = {
  mode: 'sandbox',
  devices: { cpu: true, cuda: false },
  languages: { python: true, pytorch: true, triton: false },
  limits: { max_code_bytes: 65536, max_repetitions: 100, wall_time_s: 60 },
  host: { os: 'Linux', arch: 'x86_64', cpu_cores: 4, memory_gb: 8 },
};

test('API client normalizes the gateway origin and uses the locked routes', async () => {
  const calls = [];
  const client = new ApiClient('http://127.0.0.1:8000/', async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/v1/capabilities')) return Response.json(capabilities);
    if (url.endsWith('/api/v1/submissions') && init.method === 'POST') {
      return Response.json({ submission_id: 'id', status: 'queued', websocket_url: '/api/v1/submissions/id/events?after=0', mode: 'sandbox' }, { status: 202 });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  });
  assert.deepEqual(await client.getCapabilities(), capabilities);
  const accepted = await client.createSubmission(request);
  assert.equal(accepted.submission_id, 'id');
  assert.equal(calls[0].url, 'http://127.0.0.1:8000/api/v1/capabilities');
  assert.equal(calls[1].url, 'http://127.0.0.1:8000/api/v1/submissions');
  assert.deepEqual(JSON.parse(calls[1].init.body), request);
});

test('API client reads the public share projection without exposing code', async () => {
  let requestedUrl = '';
  const client = new ApiClient('http://localhost:8000', async url => {
    requestedUrl = url;
    return Response.json({
      short_id: '8K4QZ2M7',
      submission_id: 'submission',
      challenge_slug: null,
      language: 'python',
      device: 'cpu',
      created_at: '2026-09-25T00:00:00.000Z',
      result: null,
    });
  });
  const snapshot = await client.getShare('8K4QZ2M7');
  assert.equal(requestedUrl, 'http://localhost:8000/api/v1/s/8K4QZ2M7');
  assert.equal(snapshot.short_id, '8K4QZ2M7');
  assert.equal('code' in snapshot, false);
});

test('API client sends a run token only on write requests', async () => {
  const calls = [];
  const client = new ApiClient('http://localhost:8000', async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST') return Response.json({ submission_id: 'id', status: 'queued', websocket_url: '/events', mode: 'sandbox' }, { status: 202 });
    return Response.json(capabilities);
  }, 'run-secret');
  await client.createSubmission(request);
  await client.getCapabilities();
  assert.equal(calls[0].init.headers.get('X-KernelForge-Token'), 'run-secret');
  assert.equal(calls[1].init.headers.has('X-KernelForge-Token'), false);
});

test('API client exposes structured HTTP errors and rejects malformed capabilities', async () => {
  const client = new ApiClient('http://localhost:8000', async () => Response.json(
    { detail: { code: 'unsupported_device', message: 'CUDA unavailable' } },
    { status: 422 },
  ));
  await assert.rejects(() => client.createSubmission(request), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 422);
    assert.equal(error.code, 'unsupported_device');
    return true;
  });
  assert.throws(() => parseCapabilities({ ...capabilities, mode: 'remote' }));
});
