# Logbird — product & technical spec (v0)

Logbird is an **open-source (MIT), self-hostable audit-log / activity-history platform** with a hosted cloud
offering (same model as our reference app: one codebase, self-host or cloud). Products send events through an SDK or HTTP
API; Logbird stores them in ClickHouse, keeps them for a per-project retention window, and gives the operating
team a fast console to search, follow and understand *who did what, to which record, through which worker, and
what changed*.

> Audience: developers / operators of the product that sends events (e.g. the StayDesk team). It is **not** an
> end-customer portal. Products that want to show history to their own users consume the read API.

## 1. Principles

1. **Accept anything.** Any JSON object with an `action` string is a valid event. Nothing is rejected for missing
   recommended fields. We *recommend* an envelope (§3) and surface a per-event **conformance score** so teams can
   improve their instrumentation, but we never drop data for being off-standard.
2. **Capture is the client's job.** We ship an SDK, docs and recommended patterns. The guarantee starts at our
   `202`: once acknowledged, an event is durably in ClickHouse and searchable within seconds.
3. **History starts the day capture starts.** No backfill / reconstruction tooling.
4. **Retention = permanent deletion.** Each project has `retentionDays`; older events are deleted for good.
   Lowering retention requires typing the project slug and immediately purges data beyond the new window.
5. **Dogfood.** Logbird records its own management actions (project created, key created/revoked, retention
   changed, member invited…) as events into a per-organization *workspace activity* stream.
6. **Fast at scale.** Design for 10M+ events/day per project: wide flat table, LowCardinality, bloom-filter skip
   indexes, materialized rollups for dashboards, cursor pagination, no `FINAL` on hot paths.

## 2. Architecture

```
apps/app      TanStack Start (React 19, TanStack Router/Query/Table/Virtual/Form), shadcn design system  :4600
apps/server   Hono on Node: better-auth, internal /api, public /v1 ingest+read, OpenAPI (+Scalar docs) :4601
apps/worker   BullMQ workers (Dragonfly): retention purge (hourly + on-demand), receipt expiry (minute)
packages/contracts   zod schemas + route table shared by server and app (source of truth for the API)
packages/database    Prisma 7 + @prisma/adapter-pg (Postgres): auth tables, orgs, projects, keys, views
packages/clickhouse  @clickhouse/client wrapper, SQL migrations, query builder, query-language parser
packages/auth        better-auth server/client config (email OTP, organization plugin)
packages/email       react-email templates (OTP sign-in, invitation) + SMTP sender (Mailpit locally)
packages/ui          shadcn design system (Base UI variant like our reference app), tokens, charts, shared components
packages/sdk         `@logbird/sdk` TypeScript client: batching, retries, idempotent ids, flush on exit
packages/seed        StayDesk-shaped synthetic data generator that sends through the public ingest API
```

Development dependencies and production deployment are documented in [self-hosting.md](self-hosting.md). Configuration comes from environment variables; see the root .env.example.

**Owner decisions** that shape self-hosting, releases and hosting are recorded in [decisions.md](decisions.md). As of
2026-11-08: the public origin proxies the read-only `/docs` and `/openapi.json` reference (and no other new server
path); role images are named `ghcr.io/joodlab/logbird-<role>` but nothing is published until the repository is
open-sourced; the hosted instance's transactional email will use Postmark SMTP with required STARTTLS (self-hosters
choose their own SMTP provider); the hosted instance will run on Coolify
behind Cloudflare at `logbird.joodlab.com` after open-sourcing.

Ingestion path (v0): `POST /v1/events` → validate/normalize → ClickHouse `INSERT` with
`async_insert=1, wait_for_async_insert=1` (ack only after ClickHouse has the rows) → 202. Large batches are
inserted in one statement. A Postgres/queue buffer can be added later behind the same API.

Ingestion reserves immutable ids in Postgres before ClickHouse writes. Confirmed
receipts form a ten-minute cache; older ids use the additive `event_ids` MergeTree
index, fetching full payload only for hits. Sorted bulk claims arbitrate across
API processes without a transaction spanning ClickHouse I/O. A 60-second lease
and bounded async flush permit exclusive per-project recovery of ambiguous writes.
Recovery checks raw evidence, repairs partial destinations, confirms stored rows
or readies absent writes for an exact retry with the original receipt clock. Ready
claims expire under exclusive recovery after the ten-minute grace period; ordinary
retention never releases unresolved claims. `503 ingest_pending` includes settled
202 response fields plus pending `indices`/`eventIds` and a lease-aware Retry-After.
Rollup-backed console reads (entities, overview, suggestions; fields is also guarded)
read a monotonic project maintenance generation and fence before and after ClickHouse.
Maintenance increments the generation in the same short transaction that persists its
running fence, before any destructive statement. Changed generations or an unfinished
fence discard the response with `503 retention_unavailable` and Retry-After, including
repairs that finish during a read. Readers hold neither a project lock nor a Postgres
connection across ClickHouse I/O. Raw-event reads retain the existing **not a snapshot**
semantics: concurrent ingest/retention can change results, and rebuilds do not empty raw events.

The SDK retries the identical body. See [ingest-identity.md](ingest-identity.md) for
migration, failure classification, permissions, cleanup and proof limits.

## 3. Recommended event envelope

Supplied `occurredAt` should be ISO-8601 or epoch milliseconds between receive time minus 3650 days
and plus 24 hours. Because only `action` is required, an unusable value (unparseable, out of window, or epoch seconds
— numeric magnitudes below 1e11) never drops the event: it is stored at receive time, the original is kept in
`attributes['logbird.occurredAt.rejected']`, and the ingest response reports it in `warnings[]` (additive field).
Omitted values use receive time.

```jsonc
{
  "id": "01J…",                     // stable event id; retries resend identical content. Generated when absent.
  "action": "hotel.policy.updated", // REQUIRED. dot-namespaced: <entity>.<sub>.<verb>
  "occurredAt": "2026-11-04T14:32:10.123Z",
  "environment": "production",
  "outcome": "success",             // success | failure | denied | partial | unknown
  "severity": "info",               // info | notice | warning | critical
  "description": "Lina changed the cancellation policy of Hotel Sunrise",
  "actor":        { "type": "user", "id": "usr_42", "name": "Lina Haddad", "email": "lina@example.com" },
  "impersonator": { "id": "usr_1", "name": "Lina (support)" },
  "executor":     { "type": "worker", "id": "crm-worker", "name": "CRM worker", "jobId": "456", "attempt": 2 },
  "tenant":       { "id": "biz_7", "name": "Azure Hotels" },
  "source": "channel-manager",           // external system that supplied the change, if any
  "targets": [ { "type": "hotel", "id": "hotel_123", "name": "Hotel Sunrise" },
               { "type": "website", "id": "web_a", "name": "azurehotels.com" } ],
  "changes": [ { "field": "cancellationHours", "before": 24, "after": 48 } ],
  "context": { "operationId": "op_101", "parentEventId": "evt_…", "requestId": "req_abc",
               "traceId": "4bf92f…", "ip": "203.0.113.9", "userAgent": "Mozilla/5.0…" },
  "metadata": { "anything": { "you": "want" } },
  "schemaVersion": "1"
}
```

Semantics worth documenting to users:
- **id is immutable within a project**, regardless of `occurredAt`. Exact retries
  appear in `ids` as accepted, without another raw insert or rollup increment.
  Conflicting canonical full input or resolved timestamp is reported in `rejected`
  with `code: duplicate_id_conflict` and a code-first reason; the original is kept. Recursively
  reordered object keys are equivalent; array order and all string contents matter,
  including values beyond indexing caps. SDK headers do not participate. Omitted
  or invalid `occurredAt` uses the first receipt clock. Identity digests are versioned.
  Corrections need a fresh id and may link through `context.parentEventId`.
  Unconfirmed competing claims return `503 ingest_pending` with a lease-aware
  Retry-After. Details include the settled 202 response fields plus `indices` and
  `eventIds`; every index outside `indices` is settled. Healthy siblings commit first. Identity lookup
  failures return retryable `503 ingest_unavailable`. Expired leases reconcile under
  the exclusive project lock after draining the async queue. Ordinary retention
  never releases unresolved receipts. After confirmed retention deletion and cleanup,
  an id may be used again. Unsafe ids (NUL, lone surrogates or >256 trimmed UTF-16 units)
  are per-event `invalid_event_id` rejections, so healthy siblings can proceed.
- **actor = who caused it** (person, API key, scheduler…); **executor = who performed it** (api, worker, job,
  attempt). A worker doing work requested by Lina has `actor=Lina`, `executor=crm-worker`. Scheduled runs use
  `actor.type=system`.
- **operationId** groups a request, the jobs it spawned and every record they changed; **parentEventId** forms
  the causation tree.
- **changes**: only permitted before/after values. Never send secrets; send `{field, before:"[redacted]",
  after:"[redacted]"}` to record that a secret changed.

Normalization rules (server):
- Lift recognized fields into columns. Strings are trimmed/capped; non-string `before/after` are JSON-stringified.
- Every other top-level key and everything under `metadata` (and unknown keys inside actor/tenant/executor/
  targets/context) is flattened to `attributes` with dot paths (`metadata.plan.tier`), max depth 6, max 256 keys,
  values stringified and capped at 2 KB. Arrays become JSON strings.
- Raw document (as received, ≤ 256 KB) is stored in `payload` (ZSTD).
- `conformance` = % of {occurredAt, actor.id, actor.type, outcome, targets[≥1], tenant.id, executor.type,
  context.operationId|requestId, description} present.
- Unknown `outcome`/`severity` strings are kept verbatim (accept anything) — UI shows them neutrally.

## 4. ClickHouse schema (`packages/clickhouse/migrations`)

```sql
CREATE TABLE events
(
  project_id        LowCardinality(String),
  event_id          String,
  timestamp         DateTime64(3, 'UTC'),
  received_at       DateTime64(3, 'UTC') DEFAULT now64(3),
  environment       LowCardinality(String) DEFAULT 'production',
  action            LowCardinality(String),
  category          LowCardinality(String) MATERIALIZED splitByChar('.', action)[1],
  outcome           LowCardinality(String) DEFAULT 'success',
  severity          LowCardinality(String) DEFAULT 'info',
  description       String,
  actor_type        LowCardinality(String),
  actor_id          String,
  actor_name        String,
  actor_email       String,
  impersonator_id   String,
  impersonator_name String,
  executor_type     LowCardinality(String),
  executor_id       String,
  executor_name     String,
  job_id            String,
  job_attempt       UInt16,
  tenant_id         String,
  tenant_name       String,
  source            LowCardinality(String),
  target_types      Array(LowCardinality(String)),
  target_ids        Array(String),
  target_names      Array(String),
  changes_fields    Array(String),
  changes_before    Array(String),
  changes_after     Array(String),
  operation_id      String,
  parent_event_id   String,
  request_id        String,
  trace_id          String,
  ip                String,
  user_agent        String,
  attributes        Map(LowCardinality(String), String),
  payload           String CODEC(ZSTD(3)),
  conformance       UInt8,
  schema_version    LowCardinality(String),
  sdk               LowCardinality(String),

  INDEX idx_event_id   event_id        TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_actor      actor_id        TYPE bloom_filter(0.01)  GRANULARITY 1,
  INDEX idx_tenant     tenant_id       TYPE bloom_filter(0.01)  GRANULARITY 1,
  INDEX idx_executor   executor_id     TYPE bloom_filter(0.01)  GRANULARITY 1,
  INDEX idx_targets    target_ids      TYPE bloom_filter(0.01)  GRANULARITY 1,
  INDEX idx_operation  operation_id    TYPE bloom_filter(0.01)  GRANULARITY 1,
  INDEX idx_parent     parent_event_id TYPE bloom_filter(0.01)  GRANULARITY 1,
  INDEX idx_request    request_id      TYPE bloom_filter(0.01)  GRANULARITY 1,
  INDEX idx_attr_keys  mapKeys(attributes)   TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_attr_vals  mapValues(attributes) TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX idx_text       lower(concat(description, ' ', actor_name, ' ', tenant_name, ' ', arrayStringConcat(target_names, ' ')))
                       TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(received_at)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (project_id, timestamp, event_id)
TTL toDateTime(least(received_at + INTERVAL 3650 DAY, toDateTime64('2106-02-07 06:28:15', 3, 'UTC'))) DELETE   -- hard cap; per-project retention is enforced by the worker
SETTINGS index_granularity = 8192;
```

Rollups (materialized views, populated on insert):
- `events_by_minute` (SummingMergeTree): `project_id, environment, bucket DateTime('UTC') = toStartOfMinute,
  action, outcome, actor_type, executor_type, events UInt64` → overview charts, KPIs, facets on low-card fields.
- `entities` (AggregatingMergeTree, ORDER BY (project_id, kind, entity_id)): kind ∈ actor|tenant|executor|target
  with `anyLast(type)`, `anyLast(name)`, `min(first_seen)`, `max(last_seen)`, `sum(events)` (SimpleAggregateFunction).
  Targets use ARRAY JOIN with entity_id = `type:id`. Powers pickers, fuzzy lookup (ngramSearchCaseInsensitive /
  positionCaseInsensitive on id+name), entity directory pages.
- `attribute_keys` (AggregatingMergeTree): `project_id, key, count, max(last_seen), groupUniqArray(5)(value)`
  → Fields page and query autocomplete.

Retention: `apps/worker` runs hourly and immediately after retention decreases. Each run is logged
(`RetentionRun` in Postgres) and shown in Settings. Project deletion purges all of its rows.

Retention skips mutations and exclusive locking when no expired row exists, recording a completed zero-deletion run.
Retention increases do not trigger a purge. Actual purges delete minute buckets up to the cutoff minute and
recompute that partial minute exactly from survivors. Only entities and attribute keys present in expired
rows are recomputed, preserving exact counts and extrema without rebuilding unaffected histories.
The hard TTL uses receipt time plus 3650 days; event-time policy remains enforced by the retention worker.
The migration changes TTL metadata without materializing it or removing existing rows.

TTL arithmetic stays in DateTime64 until the final cast and clamps to the DateTime ceiling in 2106, avoiding UInt32 overflow.

Failed/abandoned runs use a full aggregate rebuild on retry, including when their raw deletion already
finished. This repair path is the exception to the no-op optimization.

Runs heartbeat every 30 seconds with a ten-minute lease (legacy null heartbeats use startedAt).
Recovery under the project ingestion lock marks expired running runs failed with error `abandoned`.
Requests recover lazily and enqueue a retry; worker startup revisits running projects and the hourly
sweep retries all projects, continuing past individual failures. Live running runs return 503 retention_unavailable with Retry-After: 1 for project data reads
and project setup, including retention status while its project read fence is active. Readiness checks are short non-transactional
statements, and no read holds a project lock or a Postgres connection during ClickHouse I/O.
Raw-event reads and exports are not snapshots and may overlap a purge. Rollup-backed reads compare
maintenance generation and fence before/after querying; an overlapping rebuild returns 503 even if completed.
Writers use session advisory locks held on a separate pool (16 connections per process), never a transaction:
ingest (including Logbird's own audit writes) takes a **shared** data lock, so concurrent ingests for one project
coexist; maintenance (retention, sample replacement/removal, deletion, policy changes) takes it **exclusive**. A
second "gate" lock gives maintenance writer preference: while maintenance waits or runs, new ingests cannot pass the
gate, so a steady ingest stream cannot starve it, and in-flight ingests (tens of ms) drain first. Every acquisition is
a non-blocking try with a bounded retry (default 3 s); on timeout the caller gets HTTP 503 project_busy with
Retry-After: 1 (the SDK retries), and no Prisma connection ever waits behind a purge.
The lock statements also have a one-second lock timeout and two-second statement/connection budgets.
No Postgres transaction spans ClickHouse work. Prisma uses its own independent pool; connection_limit
in DATABASE_URL sets that pool size (default 10). Callbacks are exclusive sections, not transactions.
Sample removal persists the same ingest-repair fence and generation before rebuilding rollups.
Once rebuilt, rollups reflect surviving rows exactly because concurrent writers never enter the exclusive section.
Failed ordinary retention runs allow reads and ingestion; aggregates may be incomplete until a successful retry.
Failed ingest-repair runs keep project reads fenced while healthy ingestion can continue. The queued retention
job owns their retry; matching ingest requests do not repeat the failed rebuild and poll with Retry-After: 60.
The retention status endpoint exposes ordinary retention failures once the project read fence allows access.
Recovery never restores expired events. Workspace setup reports `retentionBusy: true` per affected
project instead of failing the workspace; its progress is a placeholder (0, nextStep null,
firstEventAt null), not measured emptiness.

Hot-path rules: always filter `project_id` + time range first; never `FINAL` on search; dedupe in the result
set by `event_id` when needed; cursor = `(timestamp, event_id)` keyset; `total` via `count()` with
`max_execution_time` guard (fall back to "10k+").

## 5. Server API

Ingest bodies may be one event, `{ "events": [...] }`, or a bare JSON array of 1-1000 events.
SDK partial rejections invoke `onDrop` for rejected indices and `onError` with reasons. Permanent HTTP
errors (except 429) drop the batch and report; transient failures retain it for retry.


The **route table and every request/response schema live in `packages/contracts`** — implement them exactly.
- Internal API (`/api/*`, better-auth session cookie, org membership enforced, project must belong to the
  active org). Public API (`/v1/*`, project-bound API keys: `lb_ingest_<random>` may only ingest, `lb_read_<random>`
  may only read). Keys are stored as SHA-256 hash + display prefix; full secret shown once.
- Errors: `{ error: { code, message, details? } }` with proper HTTP status.
- `GET /openapi.json` (hono-openapi) + Scalar reference at `/docs`. Both are read-only, unauthenticated and proxied
  by the console on the public origin (owner decision, [decisions.md](decisions.md)).
- Size limits on ingest: 1000 events or 5 MB per request.
- Public fixed-window limits are shared in Redis across replicas: 3000 ingest requests/minute
  and 1200 read requests/minute per project (all keys of the same kind share a bucket).
  Configure `INGEST_RATE_LIMIT_PER_MINUTE` and `READ_RATE_LIMIT_PER_MINUTE`.
  Authenticated responses include `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`
  (seconds until reset). A 429 uses the normal error envelope and `Retry-After` in seconds.
  `PUBLIC_RATE_LIMIT_PER_MINUTE` (600) counts only failed authentication attempts per peer.
  Exhausted peers with malformed/wrong-kind credentials are rejected before lookup; well-formed
  credentials still undergo lookup so valid keys remain usable behind shared NAT. Unknown/revoked
  well-formed keys therefore still incur lookup. Public limits fail open on Redis errors and log
  `rate_limit.storage_error`; auth limits remain fail closed.
- Dev: the app's Nitro handler (`apps/app/server/proxy.ts`, the same one production uses; there is no Vite proxy)
  forwards `/api`, `/v1`, the health checks and the read-only reference to `http://127.0.0.1:4601`, so cookies are
  same-origin. better-auth `baseURL` = app origin (`http://localhost:4600`), `trustedOrigins` includes it.

`GET /api/projects/:projectId/retention?preview=30` returns retentionDays,
oldestEventAt (null for an empty project), nextPurgeAt (next registered scheduler
occurrence, null when unregistered), and lastRun for kind=retention only (startedAt, finishedAt, status,
cutoff, deletedEvents, error). Status uses the worker values running/completed/failed.
previewDeletedEvents counts stored rows older than the candidate cutoff, or is null
when preview is omitted. This is an approximate logical event count because storage
is at least once; this endpoint never deletes data. Preview accepts integer days 1-3650.

Live polling `/live?since=<ISO>` uses arrival time received_at inclusively, orders
newest arrivals first, and dedupes IDs within the response. Clients overlap polls
and dedupe IDs across responses. Event timestamp and receivedAt remain unchanged.
Histograms zero-fill UTC buckets overlapping the half-open requested range; missing
outcome counts are zero. Requests exceeding 10000 buckets are rejected. Without an explicit
`interval` the server picks the smallest step of the ladder 1m, 5m, 10m, 15m, 30m, 1h, 3h, 6h,
12h, 1d that keeps the range at ≤ 120 buckets (whole days beyond that); buckets are aligned to
UTC multiples of their size, so ≥ 1h buckets start on whole hours (24h → 15m, 7d → 3h, 30d → 6h).

`GET /api/projects/:projectId/entities?kind=…&sort=events|lastSeen|name` lists a directory.
`events` (default) is most active first, ties broken by most recently seen; `lastSeen` is most
recent first; `name` is A→Z (unnamed entities by id). `nextCursor` is an opaque keyset cursor
bound to its sort.

Session-authenticated `GET /api/projects/:projectId/setup` reports the computed integration checklist;
`GET /api/workspace/setup` summarizes active-workspace projects and resumable onboarding.
Postgres facts are fresh; ClickHouse facts may be cached for 30 seconds after a real first event.
`POST /api/projects/:projectId/sample-data` replaces 2000 fictional events over seven days;
`DELETE` removes them. The reserved source `logbird-sample` never counts toward setup.
Replacement is limited to projects with at most 100000 stored rows. Sample mutations hold the
project ingestion lock and synchronously rebuild project rollups from surviving events.

`POST /api/projects/:projectId/keys/:keyId/roll` (owners/admins) rotates a key: it creates a replacement with the same
name and kind under the project lock, returns its secret once (`CreateApiKeyResponse`, 201) and links it with
`replacesKeyId`. The old key **keeps working until it is revoked** with the normal `DELETE …/keys/:keyId`, so the new
secret can be deployed first; rolling a revoked key returns 409 `key_revoked`. It is audited as `api_key.created` with
`reason: rotation` and the replaced key as an extra target. Public API requests sample the caller's `User-Agent`
(≤ 256 chars) into `lastUsedUserAgent` together with `lastUsedAt` (at most once a minute per key), so the keys list can
say which client last used a key before it is revoked.

`DELETE /api/projects/:projectId` runs under the exclusive project lock (ingest waits on its shared lock) and first
proves that nothing can land in ClickHouse after the purge:
1. **Maintenance writes.** Every maintenance statement for a project (rollup rebuilds, index repair, retention and
   sample purges, ingest recovery including `scripts/reconcile-ingest.ts`) carries
   `query_id = logbird-maint:<base64url(projectId)>:<suffix>`, because ClickHouse keeps executing a statement after its
   HTTP call fails. The tag is applied inside the shared helpers (`purgeProject`, `rebuildProjectRollups`,
   `repairEventIndex`, recovery and read-model rebuild), so every caller inherits it; the encoded id never contains
   `:`, so one project's prefix never matches another's. Deletion stops every such statement still in
   `system.processes` with `KILL QUERY … SYNC` and checks none is left; otherwise it answers 503 `maintenance_pending`
   with `Retry-After: 10` and deletes nothing. **Single node only:** `system.processes` and `KILL QUERY` see the node
   the server talks to, so a multi-replica ClickHouse (a cluster, or replicas behind a load balancer) is not covered;
   the supported self-host topology is one node.
2. **Ingest writes** (ingest, test events, sample data) hold a claimed receipt. While the newest unresolved claim is
   younger than its lease + async-flush bound (70 s) the delete answers 503 `ingest_pending` with `Retry-After` and
   deletes nothing; once it is older, a `SYSTEM FLUSH ASYNC INSERT QUEUE` settles any queued insert (a failed flush
   aborts the delete).

Then it purges. Only the ClickHouse mutations are conditional: once in-flight writes are settled as above (or, for
callers that do not settle, when no unresolved claim exists) and no project-scoped ClickHouse table (discovered from
`system.columns`: events, rollups, event ids) holds a row for the project, they are skipped and an empty project
deletes in well under a second. Every non-ClickHouse cleanup step runs on both paths — in particular the project's
PostgreSQL ingest receipts are always removed, so none can outlive the project and fail recovery. Operator tools that
write ClickHouse directly (the seed CLI's `--sink direct`, benchmarks, migrations) are outside this guarantee, as
documented for the ingest-identity fence.

`GET /api/onboarding/workspace-name` (session, self) returns `{ name }`: a workspace name derived from the registrable
domain of the signed-in user's email (`lina@eu.acme.co.uk` → "Acme"), or `null` for personal mailbox providers and for
domains where a member or a pending invitation already exists (teammates should join that workspace instead). It
reveals no workspace names or ids.

When onboarding is done, `GET /api/workspace/setup` returns as `onboarding.projectId` the most active project: most
events in the last 24 hours, then the most recent event, then the oldest project.

`GET /api/invitations/:invitationId` is public (the id is the secret sent only to the invited address) and returns an
`InvitationPreview` for the accept page: invited email, role, workspace, inviter name, `expiresAt` and a derived
`state` (pending / accepted / rejected / canceled / expired). Accepting still goes through better-auth with a session
whose email matches the invitation.

### 5.1 Query language (`q`)

Full reference: [query language and SQL expressions](query-language.md).
```
action:hotel.policy.updated        exact
action:hotel.*                     prefix wildcard
outcome:failure  -env:staging      negation with leading -
actor:usr_42  actor.type:user  actor.name:"Lina Haddad"
tenant:biz_7  tenant.name:"Azure Hotels"  executor:crm-worker  executor.type:worker
executor.name:"CRM worker"  actor.email:lina@example.com  impersonator:usr_1
parent:evt_123  job:456
target:hotel_123  target.type:hotel  operation:op_101  request:req_abc  trace:…  source:channel-manager
attr.metadata.plan:pro             attribute map lookup (wildcard * allowed at end)
impersonator:*  -tenant:*          field:* = field present (non-empty value); -field:* = missing.
                                  Works for every core column and attribute key; x* stays a prefix match
severity:critical  category:hotel  id:<event id>
"free text"  or  bare words        token search over description/actor/tenant/target names
a OR b, (a OR b) c                OR and parentheses; implicit AND binds more tightly
                                  max 4096 UTF-8 bytes, 64 terms, 16 nesting levels
```
Parser lives in `packages/clickhouse/src/query` → parameterized SQL (never string-concatenate user input).
Unknown `field:` prefixes are treated as `attr.<field>`. Ship unit tests for the parser.

#### 5.1.1 Query language v2 (2026-11-05)
Additive; every v0 query keeps its meaning. Field catalog (keys, aliases, types, columns): `QUERY_FIELDS` in
`packages/contracts/src/query.ts`.
```
attempt:>2  attempt:>=2  conformance:<50  attempt:<=3        comparisons on number/date fields and attributes
duration_ms:[100 TO 500]   duration_ms:{100 TO 500}           inclusive / exclusive range; * = open end ([2 TO *])
occurredAt:>2026-11-01  occurredAt:[2026-11-01 TO 2026-11-03T12:00:00Z]
                                  dates: YYYY-MM-DD (UTC midnight) or ISO-8601; the explorer time range still applies
action:/booking\.(created|cancelled)/   RE2 regex, Lucene semantics: anchored to the whole value
action:(booking.created OR booking.cancelled)   value group = IN list (OR only; members may use trailing *)
-outcome:(failure OR denied)      negated group = NOT IN
metadata.channel:whatsapp         unknown dotted keys are attributes (= attr.metadata.channel)
attributes.foo.bar:x              `attributes.` is an alias of `attr.`
a AND b,  NOT a                   explicit AND / NOT keywords (upper-case), same as adjacency / leading -
```
Attribute values are strings; with comparisons/ranges they are read as numbers
(`toFloat64OrNull(attributes[k])`), or as dates when the bound is a date. Rows whose value does not convert never
match. Array fields (`target`, `target.type`, `target.name`, `changes.field`) match when any element matches.

Errors: HTTP 422 `invalid_query`, `details` = `QueryErrorDetails` (`lang`, `reason`, `start`/`end` UTF-16 offsets,
`hint`), e.g. `attempt:>abc` → reason `type`, span of `abc`, hint `attempt is a number`.

Server follow-ups: `_exists_:field` aliases `field:*` (including NOT). Date bounds accept
`now`, `now-7d`, `now+1h`, units s/m/h/d/w and optional `/d` UTC-day rounding; one clock
instant per compilation, values remain parameters. Query errors may include optional
`replacement: { start, end, text }` for KQL `f = v`, `f != v`, `!f:v`, `&&`, `||`.
Suggestions accept q/lang/from/to and return `complete`; see the query-language reference
for sample bounds and counts. Execution SQL syntax errors use UTF-16 spans as validation does.

#### 5.1.2 SQL mode (`lang=sql`)
`q` is a ClickHouse boolean expression only (`job_attempt > 2 AND attributes['metadata.channel'] = 'whatsapp'`).
The server never runs anything but its own statement: `SELECT … FROM logbird.events WHERE project_id = {p} AND
timestamp >= {from} AND timestamp < {to} AND (<expr>)`. Before running, it validates `<expr>` by asking ClickHouse
for `EXPLAIN AST` of the wrapped statement and walking the tree: the tree must be exactly our template (one SELECT,
one table, no SETTINGS/FORMAT/UNION/JOIN/WITH), and `<expr>` may contain only literals, identifiers in
`SQL_ALLOWED_COLUMNS` (plus lambda parameters), and functions in `SQL_ALLOWED_FUNCTIONS`. Subqueries, table
functions, query parameters, `system.*`, dictionaries, `arrayJoin`, and comments/semicolons are rejected. Queries
run as ClickHouse user `logbird_query` (readonly=2 CONST, SELECT on `logbird.events` + rollups only, settings profile
with CONST resource/safety limits including max_execution_time, max_rows_to_read, max_memory_usage, max_result_rows). Console endpoints only; `/v1`
rejects `lang=sql`. A free-form SQL console is out of scope for the cloud product (possibly a future self-host
instance-admin feature).

Isolation is layered: (1) query-language values compile to parameterized SQL; (2) SQL expressions pass the lexical
scan, EXPLAIN AST baseline comparison and allowlists; (3) the readonly query account has SELECT-only grants and
CONST safety/resource limits; (4) row policies on events, events_by_minute, entities and attribute_keys enforce
`project_id = getSetting('SQL_logbird_project')` for `logbird_query`. Each restricted query sends its authorized
project in `clickhouse_settings`; validation-only EXPLAIN uses a sentinel project. Missing bindings fail closed.
Companion `USING 1 TO ALL EXCEPT logbird_query` policies preserve the main user's access. The binding is trusted
server input, not a substitute for HTTP authorization; holders of database credentials can choose the binding.
Keep the SQL guard, including rejection of SETTINGS. Self-hosters re-run
`pnpm --filter @logbird/clickhouse create-query-user` in a maintenance window before restarting the updated
server. The idempotent script preserves credentials and checks the accepted `SQL_` custom prefix without changing
server configuration. See the query-language security model for the verification and operational boundaries.

## 6. Postgres model (Prisma)

better-auth tables (user, session, account, verification) + organization plugin (organization, member,
invitation) + app tables:
- `Project { id, organizationId, name, slug (unique per org), description?, retentionDays=90, maintenanceGeneration BigInt=0, createdAt, updatedAt }`
- `ApiKey { id, projectId, name, kind (ingest|read), prefix, hash (unique), createdById?, createdAt, lastUsedAt?, lastUsedUserAgent?, replacesKeyId?, revokedAt? }`
  (`replacesKeyId`: set on a rolled key, pointing at the key it replaces; `lastUsedUserAgent`: sampled with `lastUsedAt`)
- `SavedView { id, projectId, name, description?, state Json, createdById?, createdAt }` — `state` = `{ q?, lang?, range?,
  columns?, labels? }`; `labels` (≤ 20) are display names for entity terms of `q` (`tenant:biz_5` → "Bayt Al Rimal"),
  purely presentational
- `RetentionRun { id, projectId, kind=retention (retention|ingest_repair), retentionDays, cutoff, startedAt, heartbeatAt?, finishedAt?, status, deletedEvents?, error? }`

## 7. Auth

better-auth with **email OTP sign-in only** (`emailOTP` plugin, `disableSignUp: false` → first OTP creates the
user) + `organization` plugin. OTP + invitation emails are react-email templates in `packages/email`, sent via
SMTP (Mailpit locally). After first sign-in the user has no org → onboarding creates one.

### 7.1 Console authorization

The explicit mutation policy is `apps/server/src/middlewares/require-role.ts`.
Roles are resolved from current membership in the project's organization, which must
match the active workspace. Comma-separated better-auth roles grant the union of
recognized permissions; unknown roles grant nothing. Unlisted console mutations
are denied, including for owners. Authentication endpoints under `/api/auth/*`
are delegated to better-auth (self-service profile/session/workspace creation and
invitation acceptance remain available; organization administration uses its role ACL).

| /api operation | Owner | Admin | Member |
|---|---|---|---|
| better-auth organization update | yes | yes | no |
| better-auth organization delete | yes | no | no |
| better-auth invite/cancel invitation, manage members | yes | yes (owner safeguards apply) | no |
| better-auth profile/session, create workspace, accept/reject invitation, leave workspace | self-service | self-service | self-service (last-owner safeguards apply) |
| POST projects | yes | yes | no |
| PATCH project: name, description, retentionDays, setupDismissed, retentionReviewed | yes | yes | no |
| DELETE project | yes | yes | no |
| POST project keys / POST project key roll / DELETE project key | yes | yes | no |
| POST project views | yes | yes | yes |
| DELETE project view | any | any | own only (others return 404) |
| POST / DELETE project sample-data | yes | yes | no |
| POST project test-event | yes | yes | no |
| POST workspace invite-links / DELETE workspace invite-link | yes | yes | no |
| POST invite-links/:token/accept | valid invitation | valid invitation | valid invitation |
| GET export, workspace activity and other workspace/project reads | yes | yes | yes |
| GET workspace invite-links | yes | yes | no (contains bearer invitations) |

Link acceptance requires a session and valid token, domain, expiry and remaining
uses, independent of an existing workspace role. Public invitation previews remain
public. Role denials return 403 with code `forbidden` and message
`Workspace owner or admin access required.` Tenancy misses return 404 without project data.
`GET /api/me` exposes fresh stored membership roles, including comma-separated roles.
All project updates are administrative, even setup flags. Saved views are shared
for reading, but members can delete only their own; admins can moderate any view.

Both lowering retention (PATCH body `confirm`) and project deletion (DELETE query
`?confirm=<slug>`) require the exact project slug. Missing or incorrect confirmation
returns 422 `confirmation_required` before any destructive work. Deletion confirmation
is an additive request field with newly enforced validation; clients must send it.

## 8. UI / UX (apps/app) — the bar is "Linear / Vercel / PostHog quality" on shadcn

Design: shadcn (Base UI variant, same conventions as our reference app `packages/design-system`), Geist + Geist Mono,
neutral palette with one accent, light + dark (system default), dense-but-calm tables, monospace for ids/actions,
consistent outcome colors (success=emerald, failure=red, denied=amber, partial=orange, unknown=slate,
critical severity=red badge). Every async surface has skeleton, empty, and error states. Keyboard-first: ⌘K
command palette, `/` focuses search, `j/k` moves in the event list, `esc` closes panels. All explorer state lives
in TanStack Router search params (shareable URLs, back/forward works). Responsive down to tablet; usable on phone.

User journeys (each must work end-to-end against the real server):
1. **Sign in**: `/login` email → `/login/verify` 6-digit OTP (input-otp, paste support, resend with cooldown) →
   redirect to the onboarding step that is missing, else to the project this browser visited last, else to the most
   active project of the workspace (see `GET /api/workspace/setup`).
2. **Onboarding** (resumable): you (name) → create workspace (org) → create first project (name, retention) →
   "Send your first event". `/` and every post-sign-in redirect follow `GET /api/workspace/setup` →
   `onboarding.next`, so leaving and coming back resumes at the missing step; the wizard's progress reflects real
   state. The first-event step reuses the Setup page's component: ingest key shown once (copy), curl / SDK / fetch
   snippets pre-filled, a **live waiting indicator** that polls setup every 2.5 s and flips to the received event,
   "Send a test event", "Load sample data" (never counts) and "Skip for now" → Overview. The workspace step pre-fills
   the name from `GET /api/onboarding/workspace-name` (selected, so typing replaces it). The full-screen wizard is only
   for a workspace's first project: later projects are created from a dialog inside the app shell (Projects page and
   switcher → New project) that lands on the new project's Setup page.
   Invited people land on `/accept-invitation/$invitationId` (signed-out preview → OTP as the invited email → accept /
   decline; expired, accepted, canceled and wrong-account states).
3. **Overview dashboard** (`/p/$projectId`): KPI cards with deltas (events, active actors, tenants, failure rate,
   conformance), stacked area chart of events by outcome (click a band → explorer filtered), top actions / actors /
   tenants / executors lists (click → filter or entity page), recent problems feed, ingestion health (last event,
   events/min sparkline). Time range picker shared across pages.
4. **Explorer** (`/p/$projectId/events`): query bar with syntax highlighting + autocomplete (fields, values from
   facets/entities), time range picker (presets 15m/1h/24h/7d/30d + custom), histogram (drag to zoom), facet
   sidebar (collapsible; counts; click to include, alt-click to exclude), virtualized table (TanStack Table +
   Virtual) with configurable columns and infinite scroll, live-tail toggle. Row → right **event sheet**:
   human sentence, outcome/severity, actor vs executor vs impersonator cards, tenant, targets (each clickable →
   follow), changes diff table, causation breadcrumb + "view operation", context ids (copy), attributes table,
   raw JSON (collapsible, copy), "copy as curl / link".
5. **Follow anything**: entity pages for actors (`/p/$projectId/actors/$id`), tenants, executors (workers/jobs) and
   targets (records): header + stats, activity chart, top actions, outcome split, related entities, full timeline
   (same explorer component, pre-filtered). Directory pages list entities with fuzzy search.
6. **Operation view** (`/p/$projectId/operations/$operationId`): causation tree (parent → children), each node
   with outcome dot, executor, timing; waterfall-style timing bar.
7. **Saved views**: save current explorer state, list in sidebar, share by URL ("Copy link" on each card and on the
   open-view banner). Entity pages save "<name> — <range>" in one click (with Undo); views show entity terms by name
   ("Tenant: Bayt Al Rimal") from their stored labels.
8. **Fields** (`/p/$projectId/fields`): discovered core + attribute fields with coverage bars and samples;
   conformance explainer linking to the recommended envelope docs.
9. **Settings**: project general (name, description, slug), **retention** (select from options; lowering opens a
   destructive confirm dialog requiring the slug, explains permanent deletion; shows last purge + oldest event),
   **API keys** (create dialog → secret shown once with copy + snippet; an uncopied secret is never lost to Escape or
   a backdrop tap — the dialog asks first; list with kind badges + hints, last used and the client that used it,
   **Roll** → replacement shown once while the old key stays valid → "Revoke old key", revoke confirm), workspace members + invite by email, **workspace activity** (Logbird's own audit stream,
   rendered with the same explorer components; see the [activity action catalogue](workspace-audit.md)), danger zone (delete project).
10. **Setup** (`/p/$projectId/setup`, replaces Docs / Quickstart; `/docs` redirects): live checklist from
    `GET /api/projects/:projectId/setup` with one section per step (inline ingest/read keys, first event, envelope
    coverage with "find missing" explorer links, operationId, retention review, invite), followed by the envelope
    semantics, query language cheatsheet and keyboard shortcuts. The overview shows a compact, expandable checklist
    card until setup is complete or dismissed (workspace-wide, reopened from Setup); the sidebar shows "Setup n/m".
    Both are shown to owners and admins only (every remaining step is theirs); members can still open Setup.

App shell: collapsible left sidebar (workspace switcher, project switcher, nav: Overview, Explorer, Actors,
Tenants, Workers, Records, Fields, Saved views, Settings; footer: theme toggle, docs, user menu), top bar with
breadcrumb + time range + ⌘K. Use TanStack Query for all data (query keys per project/range/q, prefetch in route
loaders, `placeholderData: keepPreviousData` for filters), TanStack Form for forms, sonner for toasts.

## 9. Synthetic StayDesk data (`packages/seed`)

Generate a fictional hospitality domain; do not connect to customer systems. Generate via the
public ingest API with the SDK (dogfooding): workspace "Acme", project "StayDesk" (~300k events over 60 days,
weekday/hour seasonality) + small project "Ledger demo" (a fictional accounting app, ~5k events, different
vocabulary) to prove "accept anything". Include: ~30 businesses as tenants with websites, ~150 users across
roles + platform admins (impersonation), API-key actors, scheduler/system actors; executors api-server, workers
(crm, content, bookings, media, email, ads), schedulers, webhooks (StayBook, Meta WhatsApp, Stripe-like
payment provider); actions derived from real models (hotel/room/rate/booking/guest/campaign/article/page/
website/member/role/integration/media/export/auth.*/crm.sync.*/catalog.sync.*); operation trees (request →
job → child record changes), retries (attempt 2/3), failures/denied/unknown outcomes at realistic low rates,
some events deliberately off-standard (missing actor, custom top-level keys) to exercise conformance. Seed also
creates a dev login user `demo@logbird.local` as owner of "Acme" (OTP arrives in Mailpit).
