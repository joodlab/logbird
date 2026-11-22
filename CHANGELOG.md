# Changelog

## Unreleased

## 0.1.2

### Highlights

- One event the event store can't parse no longer fails its whole batch: healthy events are stored and each bad one is listed in `rejected`, and the TypeScript SDK resends only the events that are still unsettled.
- Manage up to 10 webhook endpoints per project through the API, with validated receiver URLs, filters and rotatable signing secrets, and sign or verify Standard Webhooks with the SDK. Delivery follows in the next release.
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
rebuilds, fenced projects show in `/readyz`, and every receipt conflict is a
retryable 503.

The website deletes contact and early-access submissions after the privacy
policy's retention period (`WEB_FORM_RETENTION_MONTHS`, default 24), is English
only, and the sign-in screen links the terms and privacy policy. Console controls
and sections no longer shift when their state changes.

### Upgrade and known limits

- Run migrations as usual. They are additive: indexes on `RetentionRun`, `session`,
  `verification` and `invitation`, and new webhook endpoint tables. Then set
  `LOGBIRD_VERSION` to `0.1.2` (the Compose default) and redeploy.
- The worker's `DATABASE_URL` must be a direct, session-mode connection (not a
  transaction pooler), PostgreSQL `track_activities` must stay on, and the worker's
  role should own `IngestReceipt` (or have `MAINTAIN` on PostgreSQL 17+) for the
  automatic index rebuild. Pause the worker during a manual `REINDEX CONCURRENTLY`
  on that table. See [self-hosting](docs/self-hosting.md).
- Ingest pins its ClickHouse insert settings per query. Don't add server
  constraints on them: ClickHouse then rejects the insert and ingest answers
  `503 ingest_unavailable`. Allow the `Logbird-Retry` request header through any
  proxy that strips headers.
- Webhook endpoints can be created and rotated, but nothing is delivered yet. If
  you later change `BETTER_AUTH_SECRET` without a stable `WEBHOOK_SECRET_KEY`,
  rotate endpoint secrets.
- Parse isolation handles about five leading bad events per attempt; clients that
  don't send `Logbird-Retry: subset` get the unchecked events rejected in a
  terminal `202` and must resend them individually.
- Restore operators: the ClickHouse restore cutover gate has a new mandatory
  `data_version` check.

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
