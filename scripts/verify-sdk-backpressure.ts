import assert from 'node:assert/strict';
import { Trailmark } from '@trailmark/sdk';

// Fictional payloads, assigned closed example port; no service data is written.
const client = new Trailmark({ apiKey: 'fictional', endpoint: 'http://127.0.0.1:4875', batchSize: 1000, maxRetries: 1 });
const before = process.memoryUsage().heapUsed;
for (let i = 0; i < 50_000; i++) client.track({ action: 'validator.backpressure', metadata: { pad: 'x'.repeat(200) } });
await assert.rejects(client.flush());
assert.equal(client.queueSize, 10_000);
assert.equal(client.dropped, 40_000);
console.log(
  JSON.stringify({
    tracked: 50_000,
    queueLength: client.queueSize,
    dropped: client.dropped,
    heapGrowthMB: Math.round((process.memoryUsage().heapUsed - before) / 1e6),
  }),
);
await assert.rejects(client.shutdown());
assert.equal(client.queueSize, 10_000);
