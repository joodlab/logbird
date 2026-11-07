# @logbird/sdk

Dependency-free capture for Node 22+ and modern browsers with Fetch and Web Crypto.
The structural `EventInput` type is copied from contracts so publishing does not
require a private workspace package. Keep envelope additions synchronized with contracts.

```ts
import { Logbird } from '@logbird/sdk';
const audit = new Logbird({
  endpoint: 'http://localhost:4601', apiKey: (process.env.LOGBIRD_INGEST_KEY)!,
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
crashes before server acknowledgement can lose pending events. The server arbitrates immutable ids; exact retries do not repeat ClickHouse rollups.

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
const client = new Logbird({ endpoint, apiKey, maxQueueSize: 1000,
  dropPolicy: 'oldest', onDrop: () => metrics.increment('audit.dropped') });
```

Read adapters expose failures: Vue `useAuditTrail` sets `error` and clears `loading`;
render that error before treating an empty `data` array as success. Its `refresh()` resolves
with the error in reactive state, including SSR; never throw it from `serverPrefetch`.
The examples return 502 on read failure. Set `LOGBIRD_ENDPOINT` for both capture and read.

Ingest accepts a single event object, `{ "events": [...] }`, or a bare JSON array (1-1000 events).
`occurredAt` defaults to receive time when omitted. Supplied values should be ISO-8601 or epoch milliseconds within
receive time minus 3650 days through plus 24 hours. Only `action` is required, so an unusable `occurredAt` (unparsable,
epoch **seconds** — numbers below 1e11 —, or outside that window) never drops the event: it is stored at receive time,
the original value is kept in `attributes['logbird.occurredAt.rejected']` and the payload, and the response lists it
in `warnings[]` with the reason. Events without an `action` are per-event `rejected[]` entries; valid siblings are
durably inserted. SDK partial rejections invoke `onDrop` for rejected indices and `onError` with reasons. Permanent
HTTP errors (except 429) drop the batch and report; transient failures retain it for retry.

## Host context options (0.2)

```ts
import { Logbird, redact } from '@logbird/sdk';
const client = new Logbird({
  endpoint: process.env.LOGBIRD_ENDPOINT,
  apiKey: process.env.LOGBIRD_INGEST_KEY,
  enabled: Boolean(process.env.LOGBIRD_INGEST_KEY),
  defaults: { environment: 'staging' },
  beforeSend: redact(),
  onError: console.error,
});
client.track({ action: 'record.updated', metadata: { token: 'never stored' } });
await client.shutdown();
```

An unset key requires `enabled: false`. Disabled clients require neither endpoint nor key;
track does nothing and flush/shutdown resolve immediately. Enabled clients require both.
Defaults are shallow merged under events; context and metadata merge one level deep.
Explicit undefined values override defaults. beforeSend runs after defaults and id/time
stamping, before serialization and size checks. Returning null/undefined silently filters;
a throwing hook fails closed and reports onError. Neither counts as an overflow drop.

`redact({ keys?, changeFields?, replacement? })` deep copies the event, redacts matching
object keys throughout objects/arrays (except top-level id/action), and replaces present
before/after values of matching change fields. Default replacement is `[redacted]`.
`DEFAULT_SECRET_KEYS` matches passwords, secrets, tokens, OTPs, API keys, authorization,
cookies, credentials and private keys. Add email/phone patterns for your PII policy;
the default secret pattern does not cover all PII. Hooks compose:

```ts
const hide = redact({ keys: /email|phone|token|secret/i });
const beforeSend = event => event.action === 'health.checked' ? null : hide(event);
```

## Requests and workers

`createAudit(options, hostContext, request)` from `@logbird/sdk/integration` captures
stable header/UUID correlation fallbacks once. actor/impersonator/tenant/executor/ip/requestId/operationId
resolvers run at each audit call, including after route authentication. Explicit partial
fields skip their resolver, even when undefined. Resolver failures report onError and omit
only that field. audit(action, partial?) synchronously returns the stamped event id and
never awaits delivery; occurredAt is stamped at call time. `audit.pending()` waits for
resolution/tracking, not transport. Adapter shutdown waits for resolution then delivery.
The host owns Node lifecycle hooks; edge adapters use waitUntil.

```ts
import { jobAudit } from '@logbird/sdk/integration';
const parentEventId = audit('export.requested');
const carrier = await audit.carrier({ parentEventId }); // JSON-serializable job data
// On the worker, using job.data.carrier:
const workerAudit = jobAudit({ client, job, carrier: job.data.carrier });
const childId = workerAudit('export.completed');
const nestedCarrier = await workerAudit.carrier({ parentEventId: childId });
await workerAudit.pending();
await client.shutdown();
```

AuditCarrier carries operationId, requestId, traceId, parentEventId, actor, impersonator and tenant.
Treat carriers as trusted internal data, not authentication. Worker executor uses queue/name,
string jobId and attemptsMade + 1. Explicit actor/impersonator/tenant override the carrier; absent actor
uses system/scheduler. No BullMQ dependency is required. Use integration `shutdown(options)`
when pending captures may still exist rather than calling client.shutdown directly.

## Event ids and retries

An id names one immutable event within a project, across every timestamp. An exact
retry is accepted without inserting or incrementing rollups again. Object keys may
be reordered recursively; array order and string contents must stay identical.
Identity includes the full input, including values outside indexing caps, and the
resolved timestamp. Omitted or invalid `occurredAt` keeps the first receipt's clock.

The SDK generates ids and timestamps once before queuing. If you use deterministic
ids across separate `track()` calls, resend identical content, including `occurredAt`
and `executor.attempt`; a new call otherwise gets a fresh timestamp. A different
event with the same id is rejected with `duplicate_id_conflict: ...`; the original
is kept. Send a correction with a new id and `context.parentEventId` pointing to it.
The SDK calls `onDrop` for that event and `onError` with the reason.

`503 ingest_pending` and `503 ingest_unavailable` mean retry the identical batch,
honoring `Retry-After`. Healthy siblings commit before a pending response and remain
idempotent on retry. Pending details include `accepted`, `ids`, `rejected`, `warnings`,
`indices` and `eventIds`. Every index outside `indices` is settled. Each rejected
entry has a `code` plus a code-first explanation in `reason`. The SDK retries these
responses; after its retry budget, the batch stays queued and `flush()` rejects.
Retry `flush()` later. Unresolved writes recover automatically per project after a
bounded lease and ClickHouse queue drain. An id containing NUL, a lone surrogate,
or more than 256 UTF-16 code units after trimming is rejected individually as
`invalid_event_id`. Earlier releases truncated long ids; this release rejects them.
Use string ids: numeric ids generate a fresh UUID and a warning, so convert a
numeric source id with `String(id)` before sending it.

Rejection codes appear in `rejected[].code`; retryable HTTP codes appear in
`error.code`. Every index outside pending `indices` is settled. Use the full
`details` response (`accepted`, `ids`, `rejected`, `warnings`, `indices`, `eventIds`).

| Code | Meaning | What to do / expected timing |
| --- | --- | --- |
| `invalid_event` | Invalid event fields. | Fix the reported event. A native parse error may return 422 for the batch. |
| `invalid_event_id` | Unsafe or oversized string id. | Use valid Unicode without NUL, at most 256 UTF-16 units after trimming. |
| `duplicate_id_conflict` | The id belongs to different content. | Keep the original; send corrections with a new id and context.parentEventId. |
| `stored_event_unreadable` | Retained evidence cannot be compared. | Keep the evidence. Send a correction with a new id; ask the operator to inspect storage. |
| `ingest_pending (503)` | Some writes remain unresolved. | Retry the identical batch with Retry-After: about 70 seconds for ambiguity, up to 10 minutes for a ready claim. |
| `ingest_unavailable (503)` | Identity lookup or storage is unavailable. | Retry the identical batch with Retry-After; the operator may need to restore service. |
| `project_busy (503)` | A project maintenance lock is held. | Retry with Retry-After after the current operation releases its lock. |
| `retention_unavailable (503)` | Project data is being rebuilt. | Retry reads with Retry-After. Interrupted repairs resume through the worker; the hourly sweep is the fallback. |

Automatic recovery also runs hourly. Persistent service or permission errors must
be fixed before recovery can settle the claim; honor the server's Retry-After.
