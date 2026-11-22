# Changelog

## Unreleased

## 0.1.4

### Highlights

- Show each customer only its own audit trail: tenant-scoped read keys and 15-minute viewer tokens read one tenant's (or one record's) events through search, event detail, count-by-any-field and export. The server enforces the scope, and ClickHouse enforces the tenant as well when the restricted query user is configured.
- Stored events are exact: 64-bit ids and long decimals keep every digit, a record's history matches its type and id on the same target, a slow total count never fails a search or hides its rows, and one oversized event no longer rejects its batch.
- The console opens entity pages on their full history, names its time zone everywhere with a switch to UTC, lists what an event caused, and has a Workspace settings area and a form for scoped keys.

### Changes

**Scoped read access.** A `scoped-read` key carries a scope (`tenantId`, optionally one
target, action prefixes and a field mask). `POST /v1/viewer-tokens` mints a short-lived
token for a browser. `/v1/events`, `/v1/events/:id`, `/v1/facets` and `/v1/export` apply
the scope outside the caller's query. Keys can expire; rolling a key keeps its scope and
expiry. See [scoped read access](docs/scoped-read-access.md) and [security](docs/security.md).

**Exact numbers.** Numbers a double cannot hold are stored, returned, exported and
searched with their exact digits, and numeric entity ids are indexed. Equality on a
number is exact; `>` and `<` compare at double precision. Send `occurredAt` as ISO-8601
or integer epoch milliseconds.

**Record histories.** `record:<type>:<id>` is a query field that matches one target with
that type and id. Record pages, the Record facet and the read helper in the TypeScript SDK
use it. A saved view that filters `target:` and `target.type:` separately opens as saved,
with a note and an "Open exact version" button.

**Search totals.** Rows are returned first; the count has its own one-second budget. When
it runs out the response sets `totalExact: false`, `total` is a lower bound and the console
shows "≥ N".

**Ingest.** An event over 256 KB is rejected on its own (`invalid_event`) and the rest of
its batch is stored. A console test event completes only the "first event" setup step;
sources beginning with `logbird-` are reserved for events Logbird generates.

**Arrival-time index.** Migration 010 adds a min/max index on `received_at`, which reads
by arrival time (webhook delivery, alerts, live view) use to skip most of a project's
history.

**Console.** Record, actor, tenant and executor pages lead with the complete history,
newest first. Every time names its zone, with one switch between local time and UTC. The
event drawer lists the events an event caused; unknown events and operations say so.
Members, invite links and workspace activity move to Workspace settings. Overview
drill-downs open exactly what their widgets show, and data from a previous project or
entity is never shown as current.

**.NET.** The `Logbird` and `Logbird.AspNetCore` packages are in the repository
(`sdks/dotnet`). They are not published to NuGet yet.

### Upgrade and known limits

This is a patch release: the default Compose installation upgrades without any change to
its settings.

- **Upgrade order.** Follow [Upgrades and backups](docs/self-hosting.md#upgrades-and-backups)
  with `LOGBIRD_VERSION` set to `0.1.4` before pulling. The `0.1.4` migrate image applies
  two additive PostgreSQL migrations (new columns on `ApiKey`, and a trigger,
  `ApiKey_roll_fence`, that refuses a replacement key that drops its predecessor's scope or
  expiry; no data changes) and ClickHouse migration 010. The index materializes in the
  background; reads stay correct meanwhile and no downtime is needed. Check
  `system.mutations` in the Logbird database for progress.
- **Restricted query user.** The Compose and Coolify stacks re-provision it automatically
  (the migrate image runs `create-query-user`). Source installations run
  `pnpm --filter @logbird/clickhouse create-query-user` once after upgrading; it is
  idempotent and keeps credentials. Until then the query builders remain the only layer
  that enforces a scope's tenant.
- **Rollback.** Keys with a scope or an expiry have a longer secret that releases before
  0.1.4 reject, so after a rollback they stop working instead of reading the whole project.
  Compare the returned kind, scope and expiry after creating or rolling a key.
- **Retries across the upgrade.** A retry, after the upgrade, of an event first stored
  before it that contains a number a double cannot hold answers `duplicate_id_conflict`,
  because its stored digits were rounded. Events stored before this release keep their
  rounded values.
- **New per-event rejections.** An event over 256 KB, and an event nested more than 1,000
  levels deep that holds a number a double cannot keep, are each rejected as
  `invalid_event`; the other events in the batch are stored.
- **`record:` in saved queries.** A query `record:site:12` used to search a custom
  attribute named `record` and now means a record. To keep searching that attribute, write
  `attr.record:"site:12"`.
- **Scoped reads.** One tenant per scope. A scope names stored ids: ids are still trimmed
  at ingest, so an id sent with surrounding whitespace is its trimmed id. With the
  restricted query user, a scoped read runs under that user's limits (10 seconds,
  5,000,000 rows read and 1 GiB per query); a very large tenant over a wide range can hit
  them. Revoking a key reaches its viewer tokens within 30 seconds. Rotating
  `BETTER_AUTH_SECRET` invalidates viewer tokens.
- **Webhooks.** Endpoints can still be created and rotated, but nothing is delivered in
  this release.
- **New optional settings.** `VIEWER_READ_RATE_LIMIT_PER_MINUTE` (300) and
  `VIEWER_TOKEN_MINT_RATE_LIMIT_PER_MINUTE` (600).

## 0.1.3

### Highlights

- The first published release that carries the 0.1.2 changes. 0.1.2 was tagged, but its server, worker and migrate images were never published and it has no GitHub Release; upgrade from 0.1.1 straight to 0.1.3 with the [upgrade notes](https://github.com/joodlab/logbird/blob/v0.1.3/CHANGELOG.md#013).
- Release images for arm64 are now built on native runners, and a published version is checked to contain both linux/amd64 and linux/arm64 before the `latest` and `0.1` tags move to it.

### Changes

The application is the same as 0.1.2; see that section for what changed since
0.1.1. The release workflow builds each platform on its own native runner instead
of emulating arm64, where client generation failed on the Node 26 base image.
Pull requests that touch Dockerfiles, Compose files or the image workflows now
build the four release images for arm64 as well, so a break on one platform is
caught before a tag.

### Upgrade and known limits

- Follow the 0.1.2 upgrade notes below, with `LOGBIRD_VERSION` set to `0.1.3`. The
  four additive migrations listed there are applied by the `0.1.3` migrate image.
- Don't use `0.1.2`: `ghcr.io/joodlab/logbird-app:0.1.2` exists, but the server,
  worker and migrate images for that version do not, so a 0.1.2 stack can't start.
  If you pulled `logbird-app:latest` or `logbird-app:0.1` on 22 November 2026, pull
  again.
- The runtime images use Node 26. Installing an optional native accelerator for
  the queue's message encoding logs an error on arm64 during the image build and
  then succeeds; the worker images built for both platforms in pull-request checks pass an encoding round trip.

## 0.1.2

Tagged on 22 November 2026 but never published: only the console image was built.
Use 0.1.3, which contains the same application changes.

### Highlights

- One event the event store can't parse no longer fails its whole batch: healthy events are stored and each bad one is listed in `rejected`, and the TypeScript SDK resends only the events that are still unsettled.
- Manage up to 10 webhook endpoints per project through the API, with validated receiver URLs, filters and rotatable signing secrets, and sign or verify Standard Webhooks with the SDK. This release does not deliver webhooks yet.
- Upkeep runs on its own: expired sessions, sign-in codes and invitations are purged hourly, ingest stays fast after a large receipt backlog drains, and a delete that ClickHouse skips during overlapping purges is retried.

### Changes

Ingest isolates events ClickHouse rejects at parse time and answers `202` with
per-index rejections instead of a whole-batch `422`. Clients that resend only
unsettled events send `Logbird-Retry: subset`; SDK 0.1.2 does. Lone surrogates in
searchable fields are repaired, and attribute keys that aren't valid Unicode are
rejected before insert.

Ingest receipts use compare-and-set settlement, receipt seeks stay on their index,
and the worker rebuilds a bloated receipt primary key online and cancels the
rebuild on shutdown. A failed ingest repair no longer triggers two full rollup
rebuilds, `/readyz` counts the projects fenced by one, and every receipt conflict is a
retryable 503.

The website deletes contact and early-access submissions after the privacy
policy's retention period and is English only. The sign-in screen links your terms
and privacy policy when `LOGBIRD_TERMS_URL` and `LOGBIRD_PRIVACY_URL` are set (or
the console forwards a marketing site). Console controls and sections no longer
shift when their state changes.

### Upgrade and known limits

This is a patch release: the default Compose installation upgrades without any
change to its settings. Two less common setups need a setting checked first; both
are listed under "Check before upgrading".

- **Upgrade order.** Follow [Upgrades and backups](docs/self-hosting.md#upgrades-and-backups):
  stop `app`, `server` and `worker`, take the matched backups, select this release,
  set `LOGBIRD_VERSION` to `0.1.2` (the Compose default), then
  `docker compose pull` and `docker compose up -d --no-build`. The `0.1.2` migrate
  image applies four additive migrations before the new services start: indexes on
  `RetentionRun`, `session`, `verification` and `invitation`, and the webhook
  endpoint tables. Setting the version first matters: an older migrate image doesn't
  contain these migrations.
- **Check before upgrading.**
  - A proxy between Logbird and ClickHouse must allow more than 30 seconds without
    bytes (if you raised `CLICKHOUSE_MAINTENANCE_MAX_EXECUTION_SECONDS`, more than the budget divided by 20, rounded up to a whole second).
    Long maintenance statements now send a progress header every 30 seconds instead
    of every 10, so a shorter idle timeout cuts them. The default Compose stack has
    no such proxy.
  - The marketing site container (`docker-compose.site.yml`, not a release image)
    now defaults `SMTP_PORT` to `587`. If it relied on the old implicit `1025`, set
    `SMTP_PORT=1025`.
  - The same site container deletes submissions older than its retention period
    about ten minutes after it first starts, then every six hours. To keep a
    different period, set `WEB_FORM_RETENTION_MONTHS` (a build variable, default
    24) before upgrading. New submissions go to `<WAITLIST_FILE>.d/`; keep backing
    up the whole `/data` volume. On the Cloudflare build, records written before
    this release have no expiry and must be deleted by hand; see
    [Form submissions](docs/coolify.md#form-submissions).
- **Worker requirements.** The worker's `DATABASE_URL` must be a direct,
  session-mode connection (not a transaction pooler), PostgreSQL `track_activities`
  must stay on, and the worker's role should own `IngestReceipt` (or have
  `MAINTAIN` on PostgreSQL 17+) for the automatic index rebuild; without it the
  rebuild is skipped and logged, and nothing else changes. Pause the worker during
  a manual `REINDEX CONCURRENTLY` on that table.
- **Ingest settings.** Ingest pins its ClickHouse insert settings per query. Don't
  add server constraints on them: ClickHouse then rejects the insert and ingest
  answers `503 ingest_unavailable`. Allow the `Logbird-Retry` request header through
  any proxy that strips headers.
- **Webhooks.** Endpoints can be created and rotated, but nothing is delivered. If
  you later change `BETTER_AUTH_SECRET` without a stable `WEBHOOK_SECRET_KEY`,
  rotate endpoint secrets.
- **Parse isolation.** It handles about five leading bad events per attempt. A
  client that doesn't send `Logbird-Retry: subset` gets the events that isolation
  left unchecked rejected in a terminal `202` (resend them individually) when every
  other event in the batch is settled; if another event is still ambiguous, held or
  unavailable, the answer is a retryable `503` and those events stay retryable. See
  [ingest identity](docs/ingest-identity.md).
- **Restores.** The ClickHouse restore cutover gate has new mandatory steps: a
  `data_version` check, and blocking log checks for incomplete or unverified
  deletes and stale event-index pointers. Follow the complete gate in
  [self-hosting](docs/self-hosting.md) before cutting over a restored database.

## 0.1.1

### Highlights

- Serve the Logbird website on the console's origin: set `LOGBIRD_SITE_URL` and signed-out visitors get the site while signed-in users keep the console; self-hosted installs are unchanged.
- Generate release notes with changelogithub, with a Breaking changes section and a strict human-only contributor list that never credits AI agents or bots.
- Publish a privacy policy and terms of service for Logbird Cloud's early access; the access form links them and accepts privacy requests.

### Changes

The console can forward the marketing site's pages, assets and signed-out visits
to `/` to a private site container (`docker-compose.site.yml`); API, sign-in,
invitation and session paths keep their existing handling, and the site keeps
its own per-page security headers. The site lists published GitHub releases on
`/changelog`, pins the self-host quickstart to the latest release's images, and
stays noindex until its publisher name, privacy contact, security mailbox and
contact mailbox are configured (`apps/web/src/lib/release.ts`).

Release notes are built from Conventional Commit titles by changelogithub behind
a policy wrapper: git parses co-author trailers, identities pass through
`.mailmap`, and AI agents, bots and automation accounts are excluded even when
GitHub reports them as users.

### Upgrade and known limits

- No migrations. Self-hosters update `LOGBIRD_VERSION` to `0.1.1` (the Compose
  default) and redeploy; leave `LOGBIRD_SITE_URL` empty.
- The marketing site image is not a release artifact; the hosted instance builds it
  from `docker-compose.site.yml` (see [Coolify](docs/coolify.md)).
- Privacy gaps are tracked and disclosed: expired sessions and codes aren't purged on
  a schedule (#129), account deletion and personal-data export are by request (#130),
  workspace activity has no shorter retention than 10 years (#131), and form
  submissions are deleted manually (#132).

## 0.1.0

### Highlights

- Capture activity with the event ingest API and TypeScript SDK, including batching, retries and immutable event IDs.
- Search and follow live events in the console, inspect actors and targets, export results, and enforce project retention.
- Self-host with Compose or Coolify using versioned images, SMTP sign-in and restricted signups for your team.

### First public release

Logbird is an MIT-licensed activity-history platform for developers and operators.
Create workspaces and projects, invite teammates, issue ingest/read keys, and send
application events through the HTTP API or SDK. The console provides a query
language, guarded SQL, saved views, live tail, entity directories and streamed
exports. A worker enforces per-project retention and records maintenance receipts.

The self-host stack includes PostgreSQL, ClickHouse and Redis, with separate app,
API, worker and migration images. It supports Compose and Coolify, SMTP with
required STARTTLS, and optional domain/invitation-based signup restrictions.
The public origin also serves the read-only API reference.

### Upgrade and known limits

- This is the first versioned public release. Earlier source installations must
  follow the [namespace and immutable-ID migration guidance](docs/self-hosting.md#upgrades-and-backups),
  preserve existing secrets, and take matched backups before upgrading.
- Failed retention receipts trigger an aggregate rebuild on the next successful
  run; inspect worker receipts and allow time proportional to retained history.
- Packaged restore/upgrade, migration cancellation and live Coolify recovery
  acceptance remain tracked in [#77](https://github.com/joodlab/logbird/issues/77)
  and [#88](https://github.com/joodlab/logbird/issues/88). Image builds alone do
  not establish those operational guarantees.
