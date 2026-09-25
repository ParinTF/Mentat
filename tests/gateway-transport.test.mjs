import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayTransport, parseKernelEvent } from '../web/lib/gateway-transport.ts';
import { evaluateResult } from '../web/lib/roofline.ts';

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

class FakeSocket {
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  closed = false;
  constructor(url) { this.url = url; }
  open() { this.onopen?.({}); }
  message(payload) { this.onmessage?.({ data: JSON.stringify(payload) }); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }
  drop() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code: 1006 });
  }
}

class FakeClient {
  snapshots = 0;
  async createSubmission() {
    return { submission_id: 'submission', status: 'queued', websocket_url: '/api/v1/submissions/submission/events?after=0', mode: 'sandbox' };
  }
  async getSubmission() {
    this.snapshots += 1;
    return {
      submission_id: 'submission',
      status: 'completed',
      mode: 'sandbox',
      error: null,
      result: evaluateResult(request, [1], 'measured'),
    };
  }
  websocketUrl(path) { return `http://localhost:8000${path}`; }
}

function event(sequence, type, payload) {
  return { version: 1, submission_id: 'submission', sequence, timestamp: '2026-09-25T00:00:00.000Z', type, payload };
}

test('gateway transport rejects malformed event payloads', () => {
  assert.equal(parseKernelEvent(event(1, 'result', {})), null);
  assert.equal(parseKernelEvent(event(1, 'trace', { source: 'simulation', stage: 'unknown', progress: 1 })), null);
  assert.equal(parseKernelEvent({ ...event(1, 'heartbeat', {}), timestamp: 'not-a-date' }), null);
});

test('gateway transport ignores duplicate and heartbeat cursors and finishes on terminal status', async () => {
  const sockets = [];
  const client = new FakeClient();
  const transport = new GatewayTransport({
    client,
    webSocketFactory: url => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  const events = [];
  const handle = await transport.start(request, value => events.push(value));
  assert.equal(sockets.length, 1);
  assert.match(sockets[0].url, /after=0/);
  sockets[0].open();
  sockets[0].message(event(1, 'status', { status: 'queued' }));
  sockets[0].message(event(1, 'status', { status: 'queued' }));
  sockets[0].message(event(0, 'heartbeat', {}));
  const result = evaluateResult(request, [1], 'measured');
  sockets[0].message(event(2, 'result', result));
  sockets[0].message(event(3, 'status', { status: 'completed' }));
  await handle.finished;
  assert.deepEqual(events.map(value => value.type), ['status', 'heartbeat', 'result', 'status']);
  assert.equal(events.at(-1).payload.status, 'completed');
});

test('gateway transport reconnects from the last sequence', async () => {
  const sockets = [];
  const client = new FakeClient();
  const transport = new GatewayTransport({
    client,
    reconnectDelayMs: 0,
    webSocketFactory: url => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  const events = [];
  const handle = await transport.start(request, value => events.push(value));
  sockets[0].open();
  sockets[0].message(event(1, 'status', { status: 'queued' }));
  sockets[0].drop();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sockets.length, 2);
  assert.match(sockets[1].url, /after=1/);
  sockets[1].open();
  sockets[1].message(event(2, 'status', { status: 'running' }));
  sockets[1].message(event(3, 'result', evaluateResult(request, [1], 'measured')));
  sockets[1].message(event(4, 'status', { status: 'completed' }));
  await handle.finished;
  assert.deepEqual(events.map(value => value.sequence), [1, 2, 3, 4]);
});

test('gateway transport recovers a missing replay through the submission snapshot', async () => {
  const sockets = [];
  const client = new FakeClient();
  const transport = new GatewayTransport({
    client,
    reconnectDelayMs: 0,
    webSocketFactory: url => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  const events = [];
  const handle = await transport.start(request, value => events.push(value));
  sockets[0].open();
  sockets[0].message(event(4, 'status', { status: 'completed' }));
  await handle.finished;
  assert.equal(client.snapshots, 1);
  assert.deepEqual(events.map(value => value.type), ['result', 'status']);
  assert.equal(events.at(-1).payload.status, 'completed');
});
