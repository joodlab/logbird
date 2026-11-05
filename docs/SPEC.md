# Trailmark — product & technical spec (v0)

Trailmark is an **open-source (MIT), self-hostable audit-log / activity-history platform** with a hosted cloud
offering (same model as nibleaf: one codebase, self-host or cloud). Products send events through an SDK or HTTP
API; Trailmark stores them in ClickHouse, keeps them for a per-project retention window, and gives the operating
team a fast console to search, follow and understand *who did what, to which record, through which worker, and
what changed*.

> Audience: developers / operators of the product that sends events (e.g. the JoodCMS team). It is **not** an
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
5. **Dogfood.** Trailmark records its own management actions (project created, key created/revoked, retention
   changed, member invited…) as events into a per-organization *workspace activity* stream.
6. **Fast at scale.** Design for 10M+ events/day per project: wide flat table, LowCardinality, bloom-filter skip
   indexes, materialized rollups for dashboards, cursor pagination, no `FINAL` on hot paths.

## 2. Architecture

```
apps/app      TanStack Start (React 19, TanStack Router/Query/Table/Virtual/Form), shadcn design system  :4600
apps/server   Hono on Node: better-auth, internal /api, public /v1 ingest+read, OpenAPI (+Scalar docs) :4601
apps/worker   BullMQ worker (Dragonfly): retention purge (hourly + on-demand), housekeeping
packages/contracts   zod schemas + route table shared by server and app (source of truth for the API)
packages/database    Prisma 7 + @prisma/adapter-pg (Postgres): auth tables, orgs, projects, keys, views
packages/clickhouse  @clickhouse/client wrapper, SQL migrations, query builder, query-language parser
packages/auth        better-auth server/client config (email OTP, organization plugin)
packages/email       react-email templates (OTP sign-in, invitation) + SMTP sender (Mailpit locally)
packages/ui          shadcn design system (Base UI variant like nibleaf), tokens, charts, shared components
packages/sdk         `@trailmark/sdk` TypeScript client: batching, retries, idempotent ids, flush on exit
packages/seed        JoodCMS-shaped synthetic data generator that sends through the public ingest API
```

Development dependencies and production deployment are documented in [self-hosting.md](self-hosting.md). Configuration comes from environment variables; see the root .env.example.

Ingestion path (v0): `POST /v1/events` → validate/normalize → ClickHouse `INSERT` with
`async_insert=1, wait_for_async_insert=1` (ack only after ClickHouse has the rows) → 202. Large batches are
inserted in one statement. A Postgres/queue buffer can be added later behind the same API.

## 3. Recommended event envelope

```jsonc
{
  "id": "01J…",                     // idempotency key (UUIDv7/ULID). Server generates when absent.
  "action": "hotel.policy.updated", // REQUIRED. dot-namespaced: <entity>.<sub>.<verb>
  "occurredAt": "2026-11-04T14:32:10.123Z",
  "environment": "production",
  "outcome": "success",             // success | failure | denied | partial | unknown
  "severity": "info",               // info | notice | warning | critical
  "description": "Raed changed the cancellation policy of Hotel Sunrise",
  "actor":        { "type": "user", "id": "usr_42", "name": "Raed", "email": "raed@example.com" },
  "impersonator": { "id": "usr_1", "name": "Lina (support)" },
  "executor":     { "type": "worker", "id": "crm-worker", "name": "CRM worker", "jobId": "456", "attempt": 2 },
  "tenant":       { "id": "biz_7", "name": "Azure Hotels" },
  "source": "joodbooking",           // external system that supplied the change, if any
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
- **actor = who caused it** (person, API key, scheduler…); **executor = who performed it** (api, worker, job,
  attempt). A worker doing work requested by Raed has `actor=Raed`, `executor=crm-worker`. Scheduled runs use
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
TTL toDateTime(timestamp) + INTERVAL 3650 DAY DELETE   -- hard cap; per-project retention is enforced by the worker
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

Retention: `apps/worker` runs hourly (and on demand after a retention change):
`DELETE FROM events WHERE project_id = {p} AND timestamp < now64(3) - toIntervalDay({days})` (lightweight delete),
same for rollups/entities by their time column. Each run is logged (`RetentionRun` in Postgres) and shown in
Settings → Retention ("last purge", "oldest event"). Project deletion purges all of its rows.

Runs heartbeat every 30 seconds with a ten-minute lease (legacy null heartbeats use startedAt).
Recovery under the project ingestion lock marks expired running runs failed with error `abandoned`.
Requests recover lazily and enqueue a retry; worker startup revisits running projects and the hourly
sweep retries all projects, continuing past individual failures. Live running runs return 503 retention_unavailable with Retry-After: 1 for project data reads
and project setup; retention status remains readable. Readiness checks are short non-transactional
statements, and no read holds a project lock or a Postgres connection during ClickHouse I/O.
An already-started read/export is not a snapshot and may overlap a purge.
Writers (ingest, retention, sample replacement/removal and deletion) serialize using session advisory
locks in a separate pool capped at eight connections per process. pg_try_advisory_lock fails immediately
on contention (HTTP 503 project_busy, Retry-After: 1); admission is bounded without a wait queue.
The lock statements also have a one-second lock timeout and two-second statement/connection budgets.
No Postgres transaction spans ClickHouse work. Prisma uses its own independent pool; connection_limit
in DATABASE_URL sets that pool size (default 10). Callbacks are exclusive sections, not transactions.
Sample/deletion reads may see transient aggregates during maintenance; once rebuilt, rollups reflect
surviving rows exactly because concurrent writers never enter the exclusive section.
Failed runs allow reads and ingestion: surviving raw events remain accessible, but aggregates may be
incomplete until a successful retry rebuilds them. The retention status endpoint exposes the failure.
Recovery never restores expired events. Workspace setup reports `retentionBusy: true` per affected
project instead of failing the workspace; its progress is a placeholder (0, nextStep null,
firstEventAt null), not measured emptiness.

Hot-path rules: always filter `project_id` + time range first; never `FINAL` on search; dedupe in the result
set by `event_id` when needed; cursor = `(timestamp, event_id)` keyset; `total` via `count()` with
`max_execution_time` guard (fall back to "10k+").

## 5. Server API

The **route table and every request/response schema live in `packages/contracts`** — implement them exactly.
- Internal API (`/api/*`, better-auth session cookie, org membership enforced, project must belong to the
  active org). Public API (`/v1/*`, project-bound API keys: `tm_ingest_<random>` may only ingest, `tm_read_<random>`
  may only read). Keys are stored as SHA-256 hash + display prefix; full secret shown once.
- Errors: `{ error: { code, message, details? } }` with proper HTTP status.
- `GET /openapi.json` (hono-openapi) + Scalar reference at `/docs`.
- Rate/size limits on ingest: 1000 events or 5 MB per request.
- Dev: the app proxies `/api` and `/v1` to `http://127.0.0.1:4601` (Vite `server.proxy`), so cookies are
  same-origin. better-auth `baseURL` = app origin (`http://localhost:4600`), `trustedOrigins` includes it.

`GET /api/projects/:projectId/retention?preview=30` returns retentionDays,
oldestEventAt (null for an empty project), nextPurgeAt (next registered scheduler
occurrence, null when unregistered), and lastRun (startedAt, finishedAt, status,
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
`DELETE` removes them. The reserved source `trailmark-sample` never counts toward setup.
Replacement is limited to projects with at most 100000 stored rows. Sample mutations hold the
project ingestion lock and synchronously rebuild project rollups from surviving events.

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
actor:usr_42  actor.type:user  actor.name:"Raed B"
tenant:biz_7  tenant.name:"Azure Hotels"  executor:crm-worker  executor.type:worker
executor.name:"CRM worker"  actor.email:raed@example.com  impersonator:usr_1
parent:evt_123  job:456
target:hotel_123  target.type:hotel  operation:op_101  request:req_abc  trace:…  source:joodbooking
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
The server never runs anything but its own statement: `SELECT … FROM trailmark.events WHERE project_id = {p} AND
timestamp >= {from} AND timestamp < {to} AND (<expr>)`. Before running, it validates `<expr>` by asking ClickHouse
for `EXPLAIN AST` of the wrapped statement and walking the tree: the tree must be exactly our template (one SELECT,
one table, no SETTINGS/FORMAT/UNION/JOIN/WITH), and `<expr>` may contain only literals, identifiers in
`SQL_ALLOWED_COLUMNS` (plus lambda parameters), and functions in `SQL_ALLOWED_FUNCTIONS`. Subqueries, table
functions, query parameters, `system.*`, dictionaries, `arrayJoin`, and comments/semicolons are rejected. Queries
run as ClickHouse user `trailmark_query` (readonly=2 CONST, SELECT on `trailmark.events` + rollups only, settings profile
with CONST resource/safety limits including max_execution_time, max_rows_to_read, max_memory_usage, max_result_rows). Console endpoints only; `/v1`
rejects `lang=sql`. A free-form SQL console is out of scope for the cloud product (possibly a future self-host
instance-admin feature).

Isolation is layered: (1) query-language values compile to parameterized SQL; (2) SQL expressions pass the lexical
scan, EXPLAIN AST baseline comparison and allowlists; (3) the readonly query account has SELECT-only grants and
CONST safety/resource limits; (4) row policies on events, events_by_minute, entities and attribute_keys enforce
`project_id = getSetting('SQL_trailmark_project')` for `trailmark_query`. Each restricted query sends its authorized
project in `clickhouse_settings`; validation-only EXPLAIN uses a sentinel project. Missing bindings fail closed.
Companion `USING 1 TO ALL EXCEPT trailmark_query` policies preserve the main user's access. The binding is trusted
server input, not a substitute for HTTP authorization; holders of database credentials can choose the binding.
Keep the SQL guard, including rejection of SETTINGS. Self-hosters re-run
`pnpm --filter @trailmark/clickhouse create-query-user` in a maintenance window before restarting the updated
server. The idempotent script preserves credentials and checks the accepted `SQL_` custom prefix without changing
server configuration. See the query-language security model for the verification and operational boundaries.

## 6. Postgres model (Prisma)

better-auth tables (user, session, account, verification) + organization plugin (organization, member,
invitation) + app tables:
- `Project { id, organizationId, name, slug (unique per org), description?, retentionDays=90, createdAt, updatedAt }`
- `ApiKey { id, projectId, name, kind (ingest|read), prefix, hash (unique), createdById?, createdAt, lastUsedAt?, revokedAt? }`
- `SavedView { id, projectId, name, description?, state Json, createdById?, createdAt }`
- `RetentionRun { id, projectId, retentionDays, cutoff, startedAt, finishedAt?, status, error? }`

## 7. Auth

better-auth with **email OTP sign-in only** (`emailOTP` plugin, `disableSignUp: false` → first OTP creates the
user) + `organization` plugin. OTP + invitation emails are react-email templates in `packages/email`, sent via
SMTP (Mailpit locally). After first sign-in the user has no org → onboarding creates one.

## 8. UI / UX (apps/app) — the bar is "Linear / Vercel / PostHog quality" on shadcn

Design: shadcn (Base UI variant, same conventions as nibleaf `packages/design-system`), Geist + Geist Mono,
neutral palette with one accent, light + dark (system default), dense-but-calm tables, monospace for ids/actions,
consistent outcome colors (success=emerald, failure=red, denied=amber, partial=orange, unknown=slate,
critical severity=red badge). Every async surface has skeleton, empty, and error states. Keyboard-first: ⌘K
command palette, `/` focuses search, `j/k` moves in the event list, `esc` closes panels. All explorer state lives
in TanStack Router search params (shareable URLs, back/forward works). Responsive down to tablet; usable on phone.

User journeys (each must work end-to-end against the real server):
1. **Sign in**: `/login` email → `/login/verify` 6-digit OTP (input-otp, paste support, resend with cooldown) →
   redirect to last project or onboarding.
2. **Onboarding** (resumable): you (name) → create workspace (org) → create first project (name, retention) →
   "Send your first event". `/` and every post-sign-in redirect follow `GET /api/workspace/setup` →
   `onboarding.next`, so leaving and coming back resumes at the missing step; the wizard's progress reflects real
   state. The first-event step reuses the Setup page's component: ingest key shown once (copy), curl / SDK / fetch
   snippets pre-filled, a **live waiting indicator** that polls setup every 2.5 s and flips to the received event,
   "Send a test event", "Load sample data" (never counts) and "Skip for now" → Overview.
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
7. **Saved views**: save current explorer state, list in sidebar, share by URL.
8. **Fields** (`/p/$projectId/fields`): discovered core + attribute fields with coverage bars and samples;
   conformance explainer linking to the recommended envelope docs.
9. **Settings**: project general (name, description, slug), **retention** (select from options; lowering opens a
   destructive confirm dialog requiring the slug, explains permanent deletion; shows last purge + oldest event),
   **API keys** (create dialog → secret shown once with copy + snippet; list with kind badges, last used,
   revoke confirm), workspace members + invite by email, **workspace activity** (Trailmark's own audit stream,
   rendered with the same explorer components), danger zone (delete project).
10. **Setup** (`/p/$projectId/setup`, replaces Docs / Quickstart; `/docs` redirects): live checklist from
    `GET /api/projects/:projectId/setup` with one section per step (inline ingest/read keys, first event, envelope
    coverage with "find missing" explorer links, operationId, retention review, invite), followed by the envelope
    semantics, query language cheatsheet and keyboard shortcuts. The overview shows a compact, expandable checklist
    card until setup is complete or dismissed (workspace-wide, reopened from Setup); the sidebar shows "Setup n/m".

App shell: collapsible left sidebar (workspace switcher, project switcher, nav: Overview, Explorer, Actors,
Tenants, Workers, Records, Fields, Saved views, Settings; footer: theme toggle, docs, user menu), top bar with
breadcrumb + time range + ⌘K. Use TanStack Query for all data (query keys per project/range/q, prefetch in route
loaders, `placeholderData: keepPreviousData` for filters), TanStack Form for forms, sonner for toasts.

## 9. Synthetic JoodCMS data (`packages/seed`)

Generate a fictional hospitality domain; do not connect to customer systems. Generate via the
public ingest API with the SDK (dogfooding): workspace "Jood", project "JoodCMS" (~300k events over 60 days,
weekday/hour seasonality) + small project "Ledger demo" (a fictional accounting app, ~5k events, different
vocabulary) to prove "accept anything". Include: ~30 businesses as tenants with websites, ~150 users across
roles + platform admins (impersonation), API-key actors, scheduler/system actors; executors api-server, workers
(crm, content, bookings, media, email, ads), schedulers, webhooks (JoodBooking, Meta WhatsApp, Stripe-like
payment provider); actions derived from real models (hotel/room/rate/booking/guest/campaign/article/page/
website/member/role/integration/media/export/auth.*/crm.sync.*/catalog.sync.*); operation trees (request →
job → child record changes), retries (attempt 2/3), failures/denied/unknown outcomes at realistic low rates,
some events deliberately off-standard (missing actor, custom top-level keys) to exercise conformance. Seed also
creates a dev login user `demo@trailmark.local` as owner of "Jood" (OTP arrives in Mailpit).
