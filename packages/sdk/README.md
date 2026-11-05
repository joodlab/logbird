# @trailmark/sdk

Dependency-free capture for Node 22+ and modern browsers with Fetch and Web Crypto.
The structural `EventInput` type is copied from contracts so publishing does not
require a private workspace package. Keep envelope additions synchronized with contracts.

```ts
import { Trailmark } from '@trailmark/sdk';
const audit = new Trailmark({
  endpoint: 'http://localhost:4601', apiKey: process.env.TRAILMARK_INGEST_KEY!,
  onError: error => console.error(error.message),
});
audit.track({ action: 'hotel.updated', actor: { type: 'user', id: 'user_42' } });
await audit.flush();
// On process exit, explicitly drain before exiting:
await audit.shutdown();
```

`track(event): void` never throws, even when `onError` throws. It snapshots the
event, assigns UUIDv7 and a timestamp when absent, and batches by rows, bytes and
time. `flush(): Promise<void>` drains the queue; `shutdown(): Promise<void>` closes
capture and drains. Defaults: 100 rows, 1000 ms, 5 retries. Events over 256 KB are
reported through `onError`; requests stay below 5 MB and 1000 rows. Timers are
unreferenced on Node; applications must call shutdown to ensure exit delivery.
Do not ship private ingest keys in a public browser bundle.

429, 5xx and network failures retry the same serialized batch with exponential
backoff and jitter (numeric Retry-After supported). A terminal failure leaves the
batch queued and rejects flush/shutdown. Background flush reports through onError;
an explicit later flush retries the retained batch. The queue is memory-only;
crashes before server acknowledgement can lose pending events. Server-side
idempotency arbitration remains necessary: stable IDs alone do not guarantee
exactly-once ClickHouse aggregate counts.

Carry the initiating actor and operation ID through job data:

```ts
const operationId = crypto.randomUUID();
const requestEventId = crypto.randomUUID();
const actor = { type: 'user', id: 'user_42', name: 'Demo operator' };
audit.track({ id: requestEventId, action: 'crm.sync.requested', actor,
  executor: { type: 'api', id: 'api-server' }, context: { operationId } });
// Pass { actor, operationId, parentEventId: requestEventId } into the job.
audit.track({ action: 'guest.updated', actor,
  executor: { type: 'worker', id: 'business-crm-worker', jobId: 'job_1', attempt: 2 },
  context: { operationId, parentEventId: requestEventId },
  changes: [{ field: 'status', before: 'pending', after: 'ready' }] });
// Scheduled work uses actor: { type: 'system', id: 'crm-scheduler' }.
```

## Outage backpressure

The SDK retains at most `maxQueueSize` queued events (default 10,000), plus one in-flight
batch (at most `batchSize`, default 100). Each event is capped at 256 KiB; this is an event
count limit, not a byte budget. Size the queue for your payloads and memory budget.
`dropPolicy: 'oldest'` (default) keeps recent events; `'newest'` preserves queued history.
`onDrop(event)` reports each overflow discard and `client.dropped` counts them;
`client.queueSize` reports queued events. Exceptions from diagnostic callbacks never escape
`track`. Failed batches re-enter the same bounded queue with the same drop policy.
`track` is best effort; `flush` and `shutdown` reject on delivery failure so callers must
handle them. Call shutdown in the host lifecycle and await it before exiting.

```ts
const client = new Trailmark({ endpoint, apiKey, maxQueueSize: 1000,
  dropPolicy: 'oldest', onDrop: () => metrics.increment('audit.dropped') });
```

Read adapters expose failures: Vue `useAuditTrail` sets `error` and clears `loading`;
render that error before treating an empty `data` array as success. Its `refresh()` resolves
with the error in reactive state, including SSR; never throw it from `serverPrefetch`.
The examples return 502 on read failure. Set `TRAILMARK_ENDPOINT` for both capture and read.
