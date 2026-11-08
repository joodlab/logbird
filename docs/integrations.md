# First-party integrations

We maintain integrations for the stacks we use first: Hono, TanStack Start, Vue and Nuxt.
Express, Next.js, Laravel and Django follow when we use them. Generated clients remain deferred;
these adapters use the hand-maintained TypeScript SDK.

For an existing Node service, start with [Integrating an existing backend](integrating-a-backend.md).

## Design

Ingest runs only on servers. Never put an ingest or read key in public runtime config, client
components or browser bundles. Vue only calls an application-owned, authenticated backend.
The backend must authorize the requested tenant/record, including every cursor request.
A project read key is project-wide; a query filter is not authorization.

Actor means who caused the action; executor means the API or worker performing it. Resolve
actor and tenant from authenticated server state, never directly from untrusted headers.
Each request gets an operationId (x-logbird-operation or UUID), requestId and validated W3C
trace ID. Propagate operationId and parentEventId explicitly into jobs; this is correlation,
not proof of identity. Forwarded IP headers are deliberately ignored: supply a trusted IP through the optional ip(context) resolver.

The synchronous audit(action, partialEvent) queues an envelope through Logbird.track. It never
awaits delivery. Resolver and capture failures call onError; diagnostic failures cannot crash the host.
SDK transport errors use the SDK's own onError hook. Request context is isolated per request;
partial events can override actor/executor for delegated work and add parentEventId.
Node hosts call the adapter shutdown method on their own lifecycle; no process handlers are installed.
Edge hosts register flush with executionCtx.waitUntil. A returned response alone is not proof of delivery.

Hono exposes c.var.audit and optional non-GET autoTrack. TanStack exposes request and function
middleware with context.audit; install request middleware once to share correlation across functions.
Nuxt installs a Nitro request plugin and close hook. Its /api/_logbird/events proxy denies by
default: configure a server-only authorization module exporting authorize(event, query) and optional
actor/tenant/executor resolvers. Authorization returns a trusted SearchQuery or false; only the trusted
query is forwarded, allowing enforced tenant scope without unsafe string concatenation.
Vue useAuditTrail accepts a typed fetcher plus reactive selectors/range; it exposes loading, error,
refresh and loadMore, discards stale responses and renders through an optional headless AuditTimeline.

## Local examples

See examples/hono, examples/tanstack-start, examples/vue and examples/nuxt. Run one at a time on
4730 with Logbird on 4731. Supply keys through server environment variables only. Examples use
fictional records and are not production authorization policies. See each README for commands.

## Console snippets and maintenance

The in-app setup/key snippets remain in apps/app/src/lib/snippets.ts (search for
`X-Logbird-SDK` if this file moves); they demonstrate direct SDK/HTTP capture. Framework setup
lives in these package READMEs, so integrations do not change the console or copy secret values.
The SDK's structural read types are compile-checked against packages/contracts in read.test.ts.
Run `node --env-file=.env --import tsx scripts/verify-integrations.ts` to provision only a disposable
project, run all examples, assert real readback and remove its keys/events/project in finally.
The runner must have ports 4872/4871 free and uses existing shared services. Private diagnostics
stay in .tmp; the credential-free receipt is docs/verification/sdk-integrations/runtime-results.json.

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

## SDK 0.2 host context and jobs

Request resolvers run lazily per audit call so per-route guards can populate identity.
requestId/operationId resolvers can use host logging context; headers/UUIDs supply stable
fallbacks. Explicit partial fields skip resolution. A failed resolver reports onError and
omits its field while capture continues. Audit now returns the event id synchronously.
Use audit.pending() before direct flush; adapter shutdown and Hono/Nitro edge hooks drain
pending resolutions automatically. No API contract change (SDK-only).

Use client defaults for environment and beforeSend for filtering/redaction; disabled local
clients require `enabled: false` when no key is configured. See [SDK README](../packages/sdk/README.md)
for merge rules, fail-closed hooks, redaction patterns and carrier/jobAudit examples.
The verification runner also exercises a global Hono capture with late route identity,
host request IDs, redacted attributes/raw payload, and worker causation/attempt readback.

For event identity and retry semantics, see [Event ids and retries](concepts.md#event-ids-and-retries).
Deterministic ids require stable content, including occurredAt and executor.attempt;
corrections use a fresh id and context.parentEventId.
