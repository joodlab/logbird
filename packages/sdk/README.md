# @logbird/sdk

Dependency-free capture for Node 20+ and modern browsers with Fetch and Web Crypto.
The structural `EventInput` type is copied from contracts so publishing does not
require a private workspace package. Keep envelope additions synchronized with contracts.

## Install

`@logbird/sdk` is not on npm yet. Each [GitHub Release](https://github.com/joodlab/logbird/releases)
attaches it as `logbird-sdk-X.Y.Z.tgz` (built JavaScript and type declarations) with a
`SHA256SUMS` file. Download both, verify, and install the file. The commands are one
chain, so a failed download or a checksum that does not match stops it before the install
(on macOS, use `shasum -a 256 --check` for `sha256sum --check`; with npm, `npm install` for
`pnpm add`):

```sh
version=X.Y.Z
base="https://github.com/joodlab/logbird/releases/download/v$version"
mkdir -p vendor/logbird && cd vendor/logbird &&
  curl -fsSLO "$base/SHA256SUMS" && curl -fsSLO "$base/logbird-sdk-$version.tgz" &&
  grep " logbird-sdk-$version.tgz\$" SHA256SUMS | sha256sum --check &&
  cd ../.. && pnpm add "./vendor/logbird/logbird-sdk-$version.tgz"
```

Commit `vendor/logbird/` and the lockfile; the lockfile pins the tarball's SHA-512 integrity.
You can also depend on the Release URL directly:
`pnpm add https://github.com/joodlab/logbird/releases/download/vX.Y.Z/logbird-sdk-X.Y.Z.tgz`,
or the same with `npm install` (npm 12 first needs `allow-remote=root` in the project's
`.npmrc`). With `@logbird/hono` as well, an override makes it use the same SDK tarball: see
[Install the SDK](https://github.com/joodlab/logbird/blob/master/docs/integrating-a-backend.md#install-the-sdk)
for that recipe for pnpm and npm. `@logbird/vue`, `@logbird/nuxt` (which also depends on `@logbird/vue`) and
`@logbird/tanstack-start` are attached to the same release and type-checked from those tarballs, but there is
no tested install recipe for them yet.

Requirements: Node 20 or later (`engines.node` `>=20`), or a runtime with Fetch and Web
Crypto. ES modules only (no CommonJS build); the declarations are checked with TypeScript
6 and 7 under `moduleResolution` `nodenext` and `bundler`. A source
checkout of this repository is for contributors ([CONTRIBUTING.md](https://github.com/joodlab/logbird/blob/master/CONTRIBUTING.md)).

## Capture

```ts
import { Logbird } from '@logbird/sdk';
const audit = new Logbird({
  // Your Logbird public origin, e.g. https://audit.example.com (http://localhost:4600 for a local stack).
  endpoint: (process.env.LOGBIRD_ENDPOINT)!, apiKey: (process.env.LOGBIRD_INGEST_KEY)!,
  onError: () => console.warn('Audit delivery failed'),
});
audit.track({ action: 'hotel.updated', actor: { type: 'user', id: 'user_42' } });
await audit.flush();
// On process exit, explicitly drain before exiting:
await audit.shutdown();
```

`track(event): void` never throws, even when `onError` throws. It snapshots the
event, assigns UUIDv7 and a timestamp when absent, and batches by rows, bytes and
time. `flush(): Promise<void>` covers events queued or already sending at the
call, including a call made during shutdown. It settles independently of later
captures and rejects with unresolved events retained for retry. Await the adapter's `audit.pending()` first to include
pending preparation in a direct flush. `shutdown(): Promise<void>` closes capture
and drains under one `shutdownTimeoutMs` budget (default 10,000 ms, 0 to stop
immediately). The budget includes pending integration context resolution, an active
batch, retries and the queued tail.
If delivery fails or takes too long, shutdown reports each remaining event as a
`shutdown` drop and rejects. Always await shutdown in the host's lifecycle.

Pass plain JSON data with own enumerable fields to `track()`. Call `flush()`
and `shutdown()` from the host lifecycle outside `beforeSend`, `onDrop` and
`onError`. An event still inside `beforeSend` when shutdown starts can be
refused and counted as a `shutdown` drop.

The defaults are 100 rows, a 1000 ms batching interval and 5 retries. Requests
stay below 5 MB and 1000 rows, with a 256 KiB per-event limit. Each request has
up to 30 seconds and each batch send has up to five minutes. On Node, batching
and background request and backoff timers are unreferenced. An explicit flush
or shutdown keeps the active delivery timers referenced while it waits.

Ingest and read requests use manual redirect handling. Configure the endpoint
as the serving origin. A redirect produces a status-only error. Ingest
acknowledgements are limited to 4 MiB and read pages to 64 MiB. The SDK cancels
unused or oversized bodies. An unreadable or oversized acknowledgement leaves
the covered events eligible for retry. Reads validate the returned event shape
and have a 30-second deadline. Before each dispatch, a fetch transport with
four pending cancellations or abandoned reads refuses the new read until cleanup
completes. Callers control read concurrency. Simultaneous aborts of reads already
dispatched can put more than four operations into cleanup.

Do not ship private ingest keys in a public browser bundle.

`endpoint` is the public origin that serves the console, the same value as the server's `APP_URL`.
It forwards `/v1` to the API, which stays on a private listener (never expose `:4601`). The API
reference is at `<origin>/docs` and the OpenAPI document at `<origin>/openapi.json`.

429, 5xx and network failures retry the same serialized batch with exponential
backoff and jitter (numeric Retry-After supported). Missing acknowledgements
are retried too. After retry exhaustion, flush rejects and retains unresolved
events. Background flush reports through `onError`. An explicit later flush
retries the retained batch. The queue is memory-only;
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
  executor: { type: 'worker', id: 'guest-sync-worker', jobId: 'job_1', attempt: 2 },
  context: { operationId, parentEventId: requestEventId },
  changes: [{ field: 'status', before: 'pending', after: 'ready' }] });
// Scheduled work uses actor: { type: 'system', id: 'crm-scheduler' }.
```

Send change values as their JSON types. Use `10` for a number and `null` for an explicit
null. Omit `before` when creating a field or `after` when removing it. Reads include
`beforeKind` and `afterKind` when the server recorded them.

Do not log raw SDK error objects, events, headers or credentials. Use safe diagnostic messages as above.

## What search can find

Logbird stores each event exactly as sent, up to the 256 KB event limit (event detail returns
it unless a field mask hides it, and the `jsonl-evidence` export carries it), and indexes it
for search with caps. The known fields are columns
cut to a length in UTF-16 code units (`action` 200, ids 256, names 512, `description` 4,096), with the
first 64 `targets` and 256 `changes`. Every other field (`metadata.*`, other top-level
fields, extra keys on the actor, executor, tenant, context or a target) becomes an attribute
searched by its dotted path, such as `metadata.plan:pro`: flattened to six path segments
(arrays and deeper objects as JSON text), at most 256 from your fields per event, each text value's first 2 KB.
A field past a cap is not searchable but stays in the stored event. So an event whose
`metadata` holds `importer` and a 300-key `settings` object indexes `metadata.importer` and
the first 255 settings keys; the other 45 are only in event detail and the `jsonl-evidence` export. The
[backend guide](https://github.com/joodlab/logbird/blob/master/docs/integrating-a-backend.md#what-search-can-find)
lists every cap.

## Outage backpressure

The SDK retains at most `maxQueueSize` queued or preparing events (default 10,000), plus one in-flight
batch (at most `batchSize`, default 100). Each event is capped at 256 KiB; this is an event
count limit, not a byte budget. Size the queue for your payloads and memory budget.
`dropPolicy: 'oldest'` (default) keeps recent events; `'newest'` preserves queued history.
`client.dropped` counts every drop, and `client.droppedByReason` gives the counts
by reason. `onDrop(event, details)` receives `details.reason`, `mayBeStored`, and
the approved rejection code or HTTP status when available. Queued drops carry
the full serialized event snapshot. Local refusals before enqueue carry only
bounded id and action fields. Keep these snapshots out of operational logs.
If `mayBeStored` is true and you replay from an outbox, reuse the original id and
content, including the original timestamp.
`client.possiblyStoredDropsByReason` counts uncertain drops even when a notification
could not be delivered. Pending resolver captures reserve queue capacity. A
reservation that is already preparing cannot be displaced by a newer capture.

`client.queueSize` reports queued events. Failed batches re-enter the same bounded
queue with the same drop policy. Diagnostic callbacks run after queue mutations.
The SDK observes rejected callback promises and counts failures in
`client.failedNotifications`. It skips new notifications when 1024 are outstanding
or 1024 have already been posted in the same event loop turn and counts those
in `client.skippedNotifications`. Capture attempted synchronously inside a client
diagnostic callback is counted as `diagnostic_reentry`. Flush and shutdown allow scheduled
callbacks to start before settling. Callers own any asynchronous work in their callbacks.

```ts
const client = new Logbird({ endpoint, apiKey, maxQueueSize: 1000,
  dropPolicy: 'oldest', onDrop: () => metrics.increment('audit.dropped') });
```

A trail always names its time window. `range: { from }` reads from `from` (inclusive) to `to` (exclusive; now when
absent), on the event's timestamp. Without `from` the server reads only the 24 hours before `to`, and a short history
would look complete, so `trailQuery` throws a `TrailQueryError` for a trail without `range` or without `range.from`.
To read that default window on purpose, pass `range: SERVER_DEFAULT_RANGE`. Every page states the window the server
applied as `page.range` (absent from servers older than that field). `order: 'asc'` reads oldest first (default
`desc`); events in the same millisecond are ordered by id, not by cause, so read causation from
`context.parentEventId`.

```ts
import { iterateAuditTrail, readAuditEvent, readAuditTrail, trailQuery } from '@logbird/sdk/read';

// A tenant-scoped read key: detail and its parents stay inside the tenant too (a project-wide key's detail can
// include another tenant's parent).
const options = { endpoint, readKey: tenantScopedReadKey };
const trail = { target: { type: 'booking', id: 'bk_1042' }, tenant: 'biz_7', range: { from: '2026-01-01T00:00:00Z' } };
const page = await readAuditTrail(options, trailQuery({ ...trail, order: 'asc' })); // one page; page.range is the window
for await (const event of iterateAuditTrail(options, { ...trail, order: 'asc' })) render(event); // every page
const first = page.data[0];
const detail = first ? await readAuditEvent(options, first.id) : null; // parents, childCount, payload; null when unknown
```

### Reading a whole trail

The [reading guide](https://github.com/joodlab/logbird/blob/master/docs/reading-history.md) shows how to rebuild a
record's complete history step by step, with these helpers and with plain HTTP.

Use `https` for any endpoint that leaves a trusted network: the read key is sent as a bearer header.

The console's record page shows a record's history; `iterateAuditTrail` with that record as `target: { type, id }` (a
`record:` selector) and an explicit `range` is its programmatic equivalent, and the `range` each page reports is the
window the server applied.

`iterateAuditTrail(options, trail)` needs `range: { from }` with `Z` or an offset (or `Date`s); `to` is optional. It reads
the trail and options once, when called, and every page through the same bounded read as `readAuditTrail`. **A pass
that completes** has yielded, once each, every event the server returned for the window the first page reported, which
must be the window asked for (the server may only move a bound onto its store limits, 1900 to 2299): every later page
is sent with that window and must report it, every yielded event lies in it, and the pass ends only when a page reports
no next cursor. A page that fails any of these checks fails the pass with a `LogbirdError` (`read_window_unverified`
or `read_invalid_response`) before any of its events is yielded, so a pass never yields a row twice or from outside the
window, and never stops early without an error. Against a server that does not report its window, a trail without
`to` fails before yielding anything. **It does not guarantee** a snapshot: each page is read when it is requested, so an
event stored during the pass with a timestamp behind your position (or before `from`) is not returned, and a relative
time in `q` (`receivedAt:>now-1h`) moves with each request. To pick up late arrivals, read again later over a window
that covers when they can have occurred, with `receivedAt:>=` in `q` starting well before the last `receivedAt` you saw
(receipt times are not a strict sequence), and skip ids you already have. Breaking out of the loop stops the pass before
its next request. To drop repeats, a pass keeps every id it has yielded (roughly 100 bytes per event), so its memory grows with the
trail: split a very large window into several passes.

`readAuditEvent(options, id)` returns one event with its nearest ancestors (`parents`, furthest first), how many events
name it as their parent (`childCount`; list them with `parent:` and the id quoted by the query language rules, over a
window that covers them), how many share its operation, and its original `payload` (null under a field mask), or
`null` for a 404. It uses the same bounded read and `LogbirdError` codes; where a runtime has no `JSON.rawJSON`, a
payload holding a number a double cannot keep fails with `read_inexact_number` instead of being rounded.

`readHistoryHorizon(options)` returns how far back the key's history reaches: `oldestEventAt`, the timestamp of the
oldest event the key or viewer token can find through search (within its scope), or null when it finds none, and the
project's `retentionDays` policy. For a whole-history pass, read from `oldestEventAt` to a `to` more than a day after
now (an event can be dated up to one day after it was received, and without `to` the window ends at the server clock).
`oldestEventAt` describes what is stored now: an empty history before it does not prove that nothing happened, since
retention deletes, for good, events dated more than `retentionDays` before each run. It can also move back: an event
dated before it can arrive later, and a pass from the earlier value misses it, so read the horizon again before each
whole-history pass. It uses the same bounded read and
`LogbirdError` codes; a server without the route answers `read_http_error` with status 404.

```ts
import { iterateAuditTrail, readHistoryHorizon } from '@logbird/sdk/read';

const horizon = await readHistoryHorizon(options); // { retentionDays, oldestEventAt }
if (horizon.oldestEventAt) {
  const range = { from: horizon.oldestEventAt, to: new Date(Date.now() + 2 * 86_400_000) };
  for await (const event of iterateAuditTrail(options, { ...trail, range, order: 'asc' })) render(event);
}
```

`trailQuery` throws a `TypeError` rather than return a project-wide query: a trail needs a target, actor, tenant or
query, and a selector key passed without a value (say `tenant: undefined`) is an error, not an absent filter. A `q` must
parse as one complete Logbird query on its own; it is ANDed with the selectors.
`trailQuery` and `readAuditTrail` first copy their input into a frozen snapshot of strings and numbers, reading each
property once (getters, inherited and non-enumerable properties included), and throw a `TrailQueryError` (a `TypeError`;
test with `isTrailQueryError`) for a value of the wrong type. Selectors, `q` and `cursor` are strings; a range bound is
a `Date`, whole epoch milliseconds or an ISO 8601 string (checked by the server); a trail's `range` needs `from`;
`limit` is an integer or its decimal digits; the options, `target`, `range` and query are plain objects or class
instances whose fields are named properties. Containers that keep entries elsewhere are refused: anything with an
iterator, or with a method named `get`, `getTime`, `getReader` or `then` (arrays, `Map`s, `URLSearchParams`, `Headers`,
`FormData`, Map-like stores, streams, promises, `Date`s). Whatever the input, `readAuditTrail` never sends a request
without a non-blank `q`: build it with `trailQuery`, or pass `q: 'timestamp:*'` to read a whole project on purpose. `readAuditTrail` sends only the known search
fields (`q`, `lang`, `from`, `to`, `limit`, `cursor`, `order`).
The read helpers require Logbird 0.2.0 or later: against an older server a selector value containing `*` is read as a
prefix, so it can match more than the named tenant, actor or record.
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
durably inserted. SDK partial rejections invoke `onDrop` once per rejected position with its code when recognized
and `onError` with the rejection count. Permanent
HTTP errors (except 429) drop the batch and report; transient failures retain it for retry.

## Host context options (0.2)

```ts
import { Logbird } from '@logbird/sdk';
const client = new Logbird({
  endpoint: process.env.LOGBIRD_ENDPOINT,
  apiKey: process.env.LOGBIRD_INGEST_KEY,
  enabled: Boolean(process.env.LOGBIRD_INGEST_KEY),
  defaults: { environment: 'staging' },
  onError: () => console.warn('Audit delivery failed'),
});
client.track({ action: 'record.updated', metadata: { token: 'never stored' } });
await client.shutdown();
```

An unset key requires `enabled: false`. Disabled clients require neither endpoint nor key;
track does nothing and flush/shutdown resolve immediately. Enabled clients require both.
Defaults are shallow merged under events; context and metadata merge one level deep.
Explicit undefined values override defaults. beforeSend runs after defaults and id/time
stamping. Redaction runs next, followed by the 256 KiB check on the resulting JSON.
Returning null/undefined records a `filtered` drop. A throwing hook records a
`before_send_failed` drop and reports through `onError`.

Before copying input or invoking `beforeSend`, the SDK checks a 1 MiB lower
bound of its JSON size and a depth of 1,000 levels within metadata and each
change value. The lower bound counts one
byte per UTF-16 code unit of keys and values, plus JSON framing and literals.
The guard is an approximation. A few hundred bytes of SDK-added framing can
affect results near the limit, and TypeScript and .NET also estimate numeric
values differently.
An event outside those limits is reported as `input_too_large` or
`input_too_deep`, even if redaction would have reduced the output. Supply
ordinary JSON data and convert accessor-backed values to plain data at capture.
The final 256 KiB cap measures the actual serialized UTF-8 bytes. A redaction
result that exceeds this output limit is reported as `too_large`.

`onWarning` receives a `party_id_normalization` code and the field name when
party identifiers or target types may be indexed differently because of
whitespace, length or lone surrogates, or when there are more than 64 targets.
The SDK sends the values as supplied. The server decides whether to accept
the event.

`LogbirdError` supports a stable `code` and safe numeric `status` and `count`
fields when applicable. Use these fields for operational logs. The SDK reports
approved rejection codes through `onDrop` and leaves its event snapshot
available for recovery. A read cancelled before dispatch rejects with the
caller's abort reason. Cancellation after dispatch uses a standard `AbortError`
with a fixed message.

## Redaction

Every event passes through client redaction, including events from framework
adapters, `createAudit`, and BullMQ's `jobAudit`. The SDK applies the rules to the
value returned by `beforeSend` and checks the size of the redacted JSON. It
reports preparation, redaction and size failures through `onError` and counts
them by reason. A redaction failure is `redaction_failed`. These refusals supply
only bounded action and event ID fields to `onDrop` with `mayBeStored: false`.

Redaction is on by default. `DEFAULT_SECRET_KEYS` matches passwords, secrets,
tokens, OTPs, API keys, authorization, cookies, credentials and private keys.
Pass `redaction: false` to disable client redaction. Use these options to set
your policy.

| Option | Behavior |
| --- | --- |
| `keys` | A regular expression that replaces the default pattern. It matches any part of a key at any depth unless you anchor it, as in `/^token$/`. The default also matches keys such as `tokenCount` and `secretary`. |
| `addKeys` | Extra literal substrings checked separately from `keys`. ASCII letter case is ignored. Non-ASCII characters match exactly, and characters such as `.` are literal. |
| `changeFields` | A regular expression for the `field` name of a change. This rule replaces its present `before` and `after` values and keeps the field name. Omit it to use `keys` and `addKeys` for matching change fields. |
| `replacement` | A string that replaces each matched value. The console recognises the default `[redacted]` in change values and displays “value redacted”. Custom replacement strings appear as recorded. |
| `paths` | Exact locations to redact regardless of their key. |
| `keepPaths` | Exact locations exempt from the key match at that node. Descendants still get checked. |

After protecting the identifier fields, the SDK applies these rules in order.

1. An explicit `paths` match forces redaction.
2. A matching change field forces redaction of its present `before` and `after` values.
3. A whole-party match redacts the party's non-identifier fields. For example,
   `keys: /actor/` redacts the staff email even with `keepPaths: ['actor.email']`.
4. A `keepPaths` match exempts the node from its own key match. For example,
   keeping `actor` prevents `/actor/` from triggering whole-party redaction.
5. The `keys` and `addKeys` rules redact matching keys and indices.

Paths start at the event root. Each dot separates a case-sensitive segment.
A segment of `*` matches exactly one object key or array index.
For example, `targets.*.name` addresses every target's display name and
`changes.0.after.email` addresses an object within the first change.
Use `\.`, `\*` or `\\` in a path to match a literal dot, star or backslash.
Double the backslashes in a JavaScript string, as in `'metadata.guest\\.email'` for
the key `guest.email`. Paths match existing JSON locations. They support
one-segment wildcards only and do not match value contents or select changes
by field name. Invalid paths throw during setup with code `redaction_options_invalid`.

The SDK preserves top-level `id` and `action` and the party identifiers listed in
`IDENTIFIER_FIELDS`. It reports rules that directly match identifiers once via
`onError` when the client is constructed. An identifier that serializes to a
JSON object or array causes the event to be refused. Matching an entire `actor`,
`impersonator`, `executor`, `tenant`, or target object redacts all its other
fields while preserving its identifiers. Matching `targets` applies that rule
to every target. Malformed scalar party values can be replaced in full.

This configuration keeps staff names and email addresses, redacts default secrets
throughout the event, and masks guest personal data in metadata and changes.

```ts
const client = new Logbird({
  endpoint,
  apiKey,
  redaction: {
    addKeys: ['email', 'phone', 'notes', 'name'],
    keepPaths: ['actor.name', 'actor.email', 'impersonator.name', 'impersonator.email'],
  },
});
client.track({
  action: 'guest.updated',
  actor: { id: 'staff_42', name: 'Fictional Operator', email: 'staff@example.invalid' },
  metadata: { guest: { email: 'guest@example.invalid', phone: '555-0100', notes: 'Fictional note' } },
  changes: [{ field: 'guest.email', after: 'guest@example.invalid' }],
});
```

The added names apply to every event location and to change field names, with the
four staff identity exemptions shown here. Filter outgoing data at the source as
well, especially personal data in free text or under other key names.

The exported `redact(options)` helper uses the same rules to produce a redacted
copy and still works as a `beforeSend` hook. Client rules run on the hook result,
so a value already replaced by the hook cannot be recovered by a client
exemption. For hooks that must remain the sole redaction policy, set
`redaction: false`. Redaction operates on the JSON representation, including
values returned by `toJSON`. Supply plain data and serialization methods without
side effects. If a change field comes from a getter, an inherited or
non-enumerable property, a boxed string, a bigint, or a value with a `toJSON`
method, the SDK redacts its change values.

The default rules and literal `addKeys` matching use the same ASCII case rules
in both SDKs. Custom `keys` and `changeFields` run on each platform's regex engine
and agree where the engines interpret the pattern the same way. For example,
`^label$` matches a key ending in a line feed in .NET, where `$` also matches
before a final line feed. JavaScript requires the actual end for this pattern.
For a strict end anchor in a shared expression, use a pattern such as
`^label(?![\s\S])` (equivalent to `^label\z` in .NET). Prefer `addKeys` whenever
a literal substring is enough.

## Standard Webhooks

`signWebhook`, `verifyWebhook`, `generateWebhookSecret` and
`WebhookVerificationError` are exported from `@logbird/sdk`. Signing and verification
are async and use Web Crypto HMAC-SHA256, which Node 20+, browsers and edge runtimes
all provide, so there are no runtime dependencies. Verification computes one HMAC of
the body per secret and compares it with each claimed signature (at most 10) in
constant time.

Verify the **raw body** before parsing it. `verifyWebhook` authenticates the body,
parses it as JSON and returns it as `unknown`, or as the type you pass
(`verifyWebhook<MyType>(…)`); it does not validate the shape:

```ts
import { Hono } from 'hono';
import { verifyWebhook, WebhookVerificationError } from '@logbird/sdk';

const app = new Hono();
const secret = process.env.LOGBIRD_WEBHOOK_SECRET!; // whsec_...; keep on the receiver

app.post('/webhooks/logbird', async (c) => {
  try {
    const event = await verifyWebhook<{ id: string }>({
      payload: await c.req.text(), // never JSON.stringify(await c.req.json())
      headers: c.req.raw.headers,
      secret,
    });
    // Durably enqueue/process event before returning 2xx. Deduplicate using
    // webhook-id within this receiver: retries can carry the same event again.
    console.log(event.id);
    return c.body(null, 204);
  } catch (error) {
    // A bad request: answer 400. Anything else (a malformed secret is a TypeError) is your bug: let it surface.
    if (error instanceof WebhookVerificationError) return c.text('Invalid webhook', 400);
    throw error;
  }
});
```

Headers may be a Fetch `Headers` (or anything with a `get` method) or a plain record
such as Node's `req.headers`; names are case-insensitive, and a webhook header sent
twice counts as missing. The default
timestamp tolerance is 300 seconds in either direction, including the exact edges.
`toleranceSeconds` overrides it; optional `now` is Unix time **in seconds** for a
controlled clock. Keep the receiver's clock synchronized. During rotation, supply
`secrets: [oldSecret, newSecret]` instead of `secret`; any valid `v1` signature
matching any configured secret succeeds. Unknown versions and malformed signatures
are skipped. All configured secrets must be valid `whsec_` base64 keys containing
24–64 bytes, as specified by [Standard Webhooks](https://www.standardwebhooks.com/).

`WebhookVerificationError.reason` is one of `missing_header`, `invalid_timestamp`,
`timestamp_out_of_tolerance`, `no_matching_signature` or `invalid_payload`
(authenticated body is not JSON). A receiver misconfiguration is not a verification
failure: a malformed or missing secret throws a `TypeError`, and an invalid `now` or
`toleranceSeconds` a `RangeError`, so it reaches your error monitoring instead of
answering every delivery with 400. Do not log the raw body, secrets or signature headers on errors.

Senders generate a secret once, store it securely and sign the exact serialized body:

```ts
import { generateWebhookSecret, signWebhook } from '@logbird/sdk';

const secret = generateWebhookSecret(); // whsec_ + 32 random bytes, base64 encoded
// Save this secret securely for the endpoint; do not regenerate it per delivery.
const id = 'evt_example'; // stable across retries; no dots or newlines
const timestamp = Math.floor(Date.now() / 1000); // refresh on each attempt
const payload = JSON.stringify({ action: 'hotel.updated' });
const signature = await signWebhook({ id, timestamp, payload, secrets: [secret] });
const headers = {
  'content-type': 'application/json',
  'webhook-id': id,
  'webhook-timestamp': String(timestamp),
  'webhook-signature': signature,
};
// Send payload unchanged with these headers. During overlap, sign with both secrets.
```

## Requests and workers

`createAudit(options, hostContext, request)` from `@logbird/sdk/integration` captures
stable correlation ids once. Unless an id set on the event or a `requestId` / `operationId`
resolver supplies one, each is a generated UUID, or the inbound `x-logbird-operation` and
`x-request-id` header when you set `useOperationHeader` and `useRequestIdHeader` (both off by
default): any caller can send these headers, so enable them only behind a trusted ingress that sets them itself or strips or overwrites what a client sent. actor/impersonator/tenant/executor/ip/requestId/operationId
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

Large numbers: a JavaScript `number` cannot hold integers above 2^53 − 1, and the SDK copies events through JSON.
Send 64-bit ids and long decimals as strings. Numeric entity ids within the safe range (`actor: { id: 42 }`) are fine
and are indexed as `"42"`. See
[numbers and ids](../../docs/integrating-a-backend.md#numbers-and-ids).


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
The SDK calls `onDrop` with the approved rejection code and gives `onError` a count.

`503 ingest_pending` and `503 ingest_unavailable` mean retry unsettled events,
honoring `Retry-After`. Healthy siblings commit before a pending response and remain
idempotent on retry. Pending details include `accepted`, `ids`, `rejected`, `warnings`,
`indices` and `eventIds`. Every index outside `indices` is settled. Each rejected
entry has a `code` plus a code-first explanation in `reason`. On an exact-row storage
parse failure, the server checks every named row alone as a canary. A written
canary is accepted and the rest of that attempt uses bisection; a failed canary permits
exact-row rejection and prefix writes. All share the original isolation budgets
(about three statements per bad row).
The SDK validates the acknowledgement envelope, credits each accepted id once
per occurrence and settles each rejected position once. It retries only the
remaining events with their cached JSON (including id and occurredAt)
in every subset body. Response indices are mapped back to the original events,
so rejections call `onDrop` once per event. Incomplete 503 details keep the
previous retry body, and valid rejections are still reported. A partial 2xx
can settle unambiguous accepted rows. The SDK refuses
to dispatch when four transport operations are still outstanding after cancellation.
After its retry budget, only unsettled events stay
queued and `flush()` rejects. The SDK always sends `Logbird-Retry: subset`. About
five leading bad rows fit per attempt under the server's byte budget; subset retries
converge. An attempt settling events and shrinking the body does not consume
`maxRetries`; total attempts remain bounded by batch length plus retries and five minutes
per send. At that time limit, `flush()` rejects and requeues only unsettled events.
After `beforeSend`, missing, blank or non-string ids (numbers included) get a fresh uuidv7,
as the server would mint; valid string ids stay unchanged so subset retries can match accepted events.

Raw HTTP clients declaring `Logbird-Retry: subset` must honor settled rejections and resend only `details.indices`
or the remaining unsettled events to make progress. Preserve each event's JSON
byte-identically, including id and occurredAt; response indices then refer to the
smaller request. Clients without that capability (old SDKs and raw HTTP without the
header) instead receive terminal 202: proven-bad rows `invalid_event`, written rows
accepted, unchecked rows rejected with distinct code/reason `unverified_after_parse_failure`
and guidance to resend individually if needed. Unchecked rows are not proven invalid.
If other rows still need retry, including ambiguous writes or held-claim conflicts,
everyone gets 503 and unchecked rows stay unresolved. Identical retries skip confirmed
rows; after recovery settles pending writes, the next legacy request reaches terminal 202.
A proxy stripping `Logbird-Retry` safely selects that fallback but rejects unchecked rows;
allow this header through proxies to preserve subset retries.

Every stored attribute key must be valid Unicode; keys beyond the 256-attribute cap are
not stored or checked. Lone surrogates in stored keys are rejected before INSERT as
`invalid_event: Attribute keys must be valid Unicode`. Valid surrogate pairs are kept.
Parse isolation remains defence in depth for unknown future triggers after this validation.

Retry `flush()` later. Unresolved writes recover automatically per project after a
bounded lease and ClickHouse queue drain. An id containing NUL, a lone surrogate,
or more than 256 UTF-16 code units after trimming is rejected individually as
`invalid_event_id`. Earlier releases truncated long ids; this release rejects them.
Use string ids: a numeric id gets a fresh UUID (the SDK mints a uuidv7; raw HTTP
requests get one from the server, with a warning), so convert a numeric source id
with `String(id)` before sending it.

Rejection codes appear in `rejected[].code`; retryable HTTP codes appear in
`error.code`. Every index outside pending `indices` is settled. Use the full
`details` response (`accepted`, `ids`, `rejected`, `warnings`, `indices`, `eventIds`).

| Code | Meaning | What to do / expected timing |
| --- | --- | --- |
| `invalid_event` | Invalid event fields or a proven storage parse failure. | Fix the reported indices in `rejected`. Healthy siblings are accepted (202); all rejected gives `accepted: 0`. |
| `unverified_after_parse_failure` | Isolation stopped before checking this proven-unwritten row. | Terminal 202 fallback without `Logbird-Retry: subset`; resend individually if needed. With the header, unchecked rows stay retryable in `503 ingest_pending`. |
| `invalid_event_id` | Unsafe or oversized string id. | Use valid Unicode without NUL, at most 256 UTF-16 units after trimming. |
| `duplicate_id_conflict` | The id belongs to different content. | Keep the original; send corrections with a new id and context.parentEventId. |
| `stored_event_unreadable` | Retained evidence cannot be compared. | Keep the evidence. Send a correction with a new id; ask the operator to inspect storage. |
| `ingest_pending (503)` | Some writes remain unresolved. | Retry unsettled events with Retry-After: one second for unchecked rows (five seconds when storage also refused rows and no claims are held), about 70 seconds for ambiguity, up to 10 minutes for a ready claim. |
| `ingest_unavailable (503)` | Identity lookup or storage is unavailable. | Retry unsettled events with Retry-After; when storage definitely refused rows and no claims are held, it is five seconds. The operator may need to restore service. |
| `project_busy (503)` | A project maintenance lock is held. | Retry with Retry-After after the current operation releases its lock. |
| `retention_unavailable (503)` | Project data is being rebuilt. | Retry reads with Retry-After. Interrupted repairs resume through the worker; the hourly sweep is the fallback. |

Automatic recovery also runs hourly. Persistent service or permission errors must
be fixed before recovery can settle the claim; honor the server's Retry-After.
