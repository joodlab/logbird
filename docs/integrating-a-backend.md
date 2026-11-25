# Integrating an existing backend

Send audit events from your Node backend after an authorized business operation
commits. Keep credentials on the server. Start with a few meaningful actions and
verify their stored contents before expanding coverage.

Using C# and .NET? Start with [Logbird for .NET](sdk-dotnet.md); the advice below on
what to record and how to model events applies to it too.

## Configure delivery

Create a project and ingest key in Logbird. Set these server environment variables:

```sh
LOGBIRD_ENDPOINT=https://audit.example.com
LOGBIRD_INGEST_KEY=<project ingest key>
```

`LOGBIRD_ENDPOINT` is your public Logbird origin without `/v1/events`. This application
variable is passed to `endpoint`; the SDK does not read it automatically.

`@logbird/sdk` is not published on npm yet: `pnpm add @logbird/sdk` returns 404.
Use the source package at `packages/sdk`. Inside this repository, add it to a
workspace app with:

```sh
pnpm --filter <your-workspace-app> add '@logbird/sdk@workspace:*'
```

For a backend outside the workspace, clone Logbird beside it. Run `pnpm install`
in the Logbird clone first so the linked source can resolve its dependencies. Then
run this command from your backend project:

```sh
pnpm add @logbird/sdk@link:../logbird/packages/sdk
```

The source exports TypeScript; use `tsx` (for example, `pnpm exec tsx server.ts`)
or a bundler such as Vite or esbuild. Native Node type stripping cannot handle the
SDK's constructor parameter property.
See the [SDK README](../packages/sdk/README.md) for its runtime requirements.

```ts
import { Logbird } from '@logbird/sdk';

const audit = new Logbird({
  endpoint: process.env.LOGBIRD_ENDPOINT!,
  apiKey: process.env.LOGBIRD_INGEST_KEY!,
  redaction: {
    addKeys: ['email', 'phone', 'notes', 'name'],
    keepPaths: ['actor.name', 'actor.email', 'impersonator.name', 'impersonator.email'],
  },
  maxQueueSize: 1000,
  onError: () => console.warn('Audit delivery failed'),
  onDrop: () => console.warn('Audit event dropped'),
});
```

Validate required configuration at startup. To disable capture deliberately in
development, pass `enabled: false`. Never log keys, request headers, raw events or
SDK error objects that may contain sensitive details.

## Model the event

| Field | Meaning | Example |
| --- | --- | --- |
| `action` | Stable name for what happened; the only required field | `document.updated` |
| `actor` | Who initiated it, resolved from authenticated state | A user ID or scheduler |
| `executor` | API or worker performing the change | API ID, job ID and attempt |
| `tenant` | Business scope, resolved after authorization | `tenant_demo` |
| `targets` | Affected records | Document ID and safe display name |
| `context.operationId` | Correlation across a request and its jobs | A UUID carried through job data |
| `context.parentEventId` | The event that caused this event | The request event ID |
| `source` | Upstream system supplying the change. Values beginning with `logbird-` are reserved for events Logbird generates (sample data, console tests): they are stored, but do not count toward the Setup integration steps, and removing sample data deletes rows tagged `logbird-sample`. | `catalog-service` |
| `changes` | Allowed before/after values | Draft changing to published |

Copy only allowlisted fields. Avoid request bodies, session objects, customer
messages and full database rows. Prefer IDs over personal information.
The client redacts common secret keys by default, after `beforeSend` and
before checking the size of the outgoing JSON. The configuration above also
redacts keys containing `email`, `phone`, `notes`, or `name` wherever they occur,
while keeping the staff names and emails at the four listed paths. A change
whose `field` is `guest.email` has its present `before` and `after` values replaced
and keeps the field name. The extra key names are literal substrings that ignore
ASCII case. Use `paths` to redact a specific location such as
`metadata.guest.contact` regardless of its key. An exemption applies at its exact path.
Inspect the stored raw payload as well as indexed attributes.
See [SDK redaction options](../packages/sdk/README.md#redaction).

### Numbers and ids

Logbird stores every number with its exact value, including 64-bit integers and long
decimals, and returns them as JSON numbers with those digits (the spelling may change:
`19.90` comes back as `19.9`, `1e3` as `1000`). Search matches them exactly:
`metadata.orderId:9007199254740993`. Equality on a number is exact; greater-than and
less-than comparisons (`metadata.orderId:>9007199254740992`) compare at double precision,
so for 64-bit ids use equality. Entity ids may be numbers, so integer primary keys
work as sent. A numeric id is stored as the plain decimal text of its exact value (`42`,
`42.0` and `4.2e1` are all stored as `"42"`) when that adds at most 32 zeros to its
digits and is at most 254 characters long; otherwise as its scientific spelling (`1e33`,
`1e300`) when that is at most 254 characters; otherwise the id is not indexed (never
truncated: a longer string id cut to the 256-character cap can never equal an indexed
number), and such a target, with its extra fields, is left out of the record columns
and attributes. The spelling depends only on the value, never on how it was sent.
Numeric attribute values follow the same rule with a 2,044-character limit (string
values are cut at 2 KB). A composite
attribute value (an array, or an object deeper than the flattening limit) is indexed as
its first 2 KB; a number cut by that limit is left out of the indexed copy instead of
keeping partial digits; digits inside strings are text and follow the usual 2 KB prefix
(cut at a UTF-8 boundary, so a character at the edge, including U+FFFD, can drop). The normalized `executor.attempt` is the whole part of its exact
value. A string id is indexed as sent, with surrounding whitespace trimmed and a
256-character cap (the original payload always keeps it exactly). An event nested more
than 1,000 levels deep that holds a number a double cannot keep (anywhere in the event)
is rejected on its own
(`invalid_event: numbers nested deeper than 1,000 levels cannot be stored exactly`); its
siblings in the batch are stored. An event's own `id` must be a string (a numeric event
id gets a fresh id and a warning).

Send `occurredAt` as an ISO-8601 string or as an integer number of epoch milliseconds,
never as a fractional epoch value: a sub-millisecond fraction (`1763800000000.99999`)
is resolved at double precision and can land on the next millisecond.

JavaScript numbers cannot hold integers above 2^53 − 1 (`Number.MAX_SAFE_INTEGER`):
`9007199254740993` is already `9007199254740992` in your process before any SDK sees it.
From TypeScript, send such ids **as strings** (`String(row.id)` from a `bigint` or a
database driver's string mode). The TypeScript SDK copies events through JSON, so it does
not carry `JSON.rawJSON` values or other exact-number wrappers; use strings. Backends with
exact 64-bit types (.NET `long` and `decimal`, Java `long`, Go `int64`) can send numbers
directly over HTTP. Logbird never rounds a number it stores; what a client rounded
before sending cannot be recovered.

An event first stored before this release that contains such a number had its digits
rounded; a retry of it now answers `duplicate_id_conflict` (its content differs from what
was stored). Retries normally happen within minutes, so this only affects retries across
the upgrade.

## Capture a committed change

Call this helper from an existing authenticated route after its write commits.
The caller resolves identity and tenant after checking access to the document.
The example supplies no authentication implementation.

```ts
import { uuidv7 } from '@logbird/sdk';

function recordDocumentUpdate(input: {
  eventId: string;
  occurredAt: string;
  operationId: string;
  userId: string;
  tenantId: string;
  documentId: string;
  previousStatus: string;
  status: string;
}) {
  audit.track({
    id: input.eventId,
    occurredAt: input.occurredAt,
    action: 'document.updated',
    actor: { type: 'user', id: input.userId },
    executor: { type: 'api', id: 'api-server' },
    tenant: { id: input.tenantId },
    targets: [{ type: 'document', id: input.documentId }],
    source: 'document-service',
    context: { operationId: input.operationId },
    changes: [{ field: 'status', before: input.previousStatus, after: input.status }],
  });
}

// Called by the authenticated update handler after each document change commits.
function onDocumentChangeCommitted(
  change: Omit<Parameters<typeof recordDocumentUpdate>[0], 'eventId' | 'occurredAt'>,
) {
  recordDocumentUpdate({
    ...change,
    eventId: uuidv7(),
    occurredAt: new Date().toISOString(),
  });
}
```

Use the SDK's exported `uuidv7()` to generate the event ID, and generate its timestamp once per committed change. Persist both with
the event if delivery will be replayed. Carry the initiating actor, operation ID
and parent event ID through trusted job data; the worker records its own executor
and attempt. See the [Hono adapter](../packages/integrations/hono/README.md) and
[worker guide](../packages/sdk/README.md#requests-and-workers).

## Fail-open delivery and retries

`track()` queues synchronously and never throws; it does not wait for storage.
Keep delivery failure separate from a committed business change's success.
Monitor errors, drops and queue size without logging payloads. The bounded queue
is in memory: overflow and process crashes can lose events. For durable capture,
write an outbox row in the business transaction and deliver the saved event from
your own dispatcher.

The SDK retries network failures, 429 and 5xx with backoff and jitter. It retains
the identical serialized event, including ID, timestamp and job attempt. After
the retry budget, `flush()` rejects and only unsettled events remain queued; retry later.
Non-retryable HTTP 4xx responses (all except 429) drop remaining unsettled events and
invoke `onDrop` for each plus `onError`; `flush()` then continues. Successful
responses can still reject individual events, reported through the same callbacks.
Monitor both callbacks with safe messages, without logging their event/error arguments.

On graceful shutdown, stop accepting requests, finish in-flight work, then await
`audit.shutdown()` within your host's shutdown budget and handle rejection.
Your backend's HTTP response alone does not prove audit delivery.

An ID identifies one immutable event within a project while retained. Exact
retries do not add rows or increment rollups; different content with the same ID
is rejected as `duplicate_id_conflict`. Corrections use a new ID and may reference
the original through `context.parentEventId`. See [event identity](ingest-identity.md).

## Send through HTTP instead

Save an envelope as `event.json`, keeping its ID and timestamp stable for retries:

```json
{
  "id": "document-demo-update-1",
  "occurredAt": "2026-11-08T10:00:00.000Z",
  "action": "document.updated",
  "actor": { "type": "user", "id": "user_demo" },
  "targets": [{ "type": "document", "id": "document_demo" }],
  "context": { "operationId": "operation_demo" },
  "source": "document-service"
}
```

```sh
curl --fail-with-body "$LOGBIRD_ENDPOINT/v1/events" \
  -H "Authorization: Bearer $LOGBIRD_INGEST_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @event.json
```

Use a current timestamp when creating an event. Send a single event, an array or
`{ "events": [...] }` with at most 1000 entries. Limits are 256 KB per event and
5 MB per request (256 * 1024 and 5 * 1024 * 1024 bytes). An event over 256 KB is
rejected on its own and the rest of the batch is stored; an otherwise valid event gets
`invalid_event: event exceeds 256 KB` (a missing `action` or an unsafe `id` is reported
first); more than 1000 events or more than 5 MB refuses the whole request with
`413 payload_too_large`. Inspect even a 202 response:
`rejected` lists individual failures and `warnings` reports normalization, including
one entry per cut (`targets_truncated`, `changes_truncated`, `change_fields_truncated`) when an event has more than
64 targets or 256 changes, or a change field name longer than 256 UTF-16 code units: the event is stored whole but only the
first ones are searchable. See [limits](limits.md).
Definite native storage parse failures are isolated into `invalid_event` rejections
with zero-based indices and code-first reasons. Healthy siblings remain accepted;
the server checks every named row alone as a canary, then inserts the parse-proven
prefix before continuing with the suffix. If the canary writes, it is accepted and
the rest of the attempt uses bisection. Canary and prefix writes consume the same budgets,
at about three statements per bad row.
An all-rejected batch still returns 202 with `accepted: 0`. Isolation is bounded; if
it runs out of its 64-extra-statement, four-original-body byte budget for additional
statements, ten-second wall-clock or lease budget,
unchecked, proven-unwritten events release their claims. Clients declaring exactly
`Logbird-Retry: subset` receive them as retryable `503 ingest_pending` indices with
settled 202 fields; unresolved-only Retry-After is one second. About five leading bad
rows fit per attempt under the byte budget, so capable clients converge via subset retries.
Every other client (including old SDKs and raw HTTP without the header) gets terminal
202 instead: proven-bad rows use `invalid_event`, written rows are accepted, unchecked
rows use distinct code/reason `unverified_after_parse_failure` with guidance to resend
individually if needed. Unchecked rows are not proven invalid.
Ambiguous siblings keep their claims and determine lease-aware Retry-After.
If ambiguous writes, held-claim conflicts or other failures still need retry, everyone
gets 503 and unchecked rows remain unresolved; they are not rejected inside that 503.
Identical retries skip confirmed rows, recovery resolves pending writes, and once
nothing else needs retry, the next legacy request returns terminal 202.
A `503 ingest_pending` response means some immutable event IDs are still being
settled. Its `details` include the settled 202 response fields plus pending
`indices` (zero-based batch positions) and `eventIds`; every index outside
`indices` is settled. Retry the saved events on transient errors and honor
`Retry-After`; do not mark pending outbox entries delivered. The SDK retries the
previous body unless complete 503 details settle some events; then its next attempt
resends only unsettled events. It caches each event's serialized JSON once per send,
preserving every event byte-identically (including id and occurredAt), and maps each
response's indices back to the original events. Incomplete or malformed details
keep the previous body unchanged. The SDK sends individually rejected rows to
`onDrop` once per send, including rejections on a 503. With the capability header
preserved, unchecked healthy rows stay retryable. After retry exhaustion (`onError`),
only unsettled events are requeued.
Attempts that settle events and shrink the body do not consume `maxRetries`;
total attempts remain bounded by batch length plus retries and five minutes per send.
Fix permanent validation failures instead of retrying indefinitely.

For raw HTTP clients opting into `Logbird-Retry: subset`, honor settled rejections and resend only `details.indices`
(or the remaining unsettled events), keeping each event's JSON byte-identical,
including id and occurredAt. Indices in the next response refer to that smaller
request. This makes progress through isolation limits. A proxy that strips the header
causes safe fallback to terminal 202, but unchecked rows are rejected; allow `Logbird-Retry`
through your proxies to retain subset retry. Definite non-parse storage failures with no held
claims use a five-second Retry-After; claim-held responses retain lease-aware timing.

Search columns use `toWellFormed()` to replace invalid Unicode, including changes,
target arrays and rejected occurredAt copies. Payload and v1 identity retain raw
input. Every stored attribute key must be valid Unicode; keys beyond the 256-attribute cap
are not stored or checked. Stored keys containing a lone surrogate are rejected before INSERT
as `invalid_event: Attribute keys must be valid Unicode`; valid pairs remain verbatim.
After #153 there is no known public parse-isolation trigger. Isolation remains defence
in depth for unknown future triggers, tested with injected storage faults before real INSERTs.

Verify the event in the console by ID, actor, target and operation ID. Exercise
repeated delivery, an outage and shutdown with fictional data. If customers read
history, keep read keys server-side and authorize tenant and target on every
request, including cursor requests. A search filter alone is not authorization.
See [framework integrations](integrations.md).

## Show customers their own audit trail

To show each business or website only its own events, keep one `read` key on your server and mint short-lived
viewer tokens for each dashboard view. The server enforces the scope on search, detail, facets and export. See
[scoped read access](scoped-read-access.md).
