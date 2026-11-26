# Changelog

## Unreleased

## 0.4.0

### Highlights

- The console shows recorded field changes in record, actor and tenant histories. Queries can search change values (`changes.before`, `changes.after`) and the support person's name (`impersonator.name`), and Logbird keeps the JSON kind of each change value.
- Every search, facet and export says which time window it read. TypeScript trail reads must name their window, and `iterateAuditTrail` reads every page of one.
- The TypeScript SDK redacts common secret keys by default, accounts for every event through `flush()` and `shutdown()`, and refuses redirects. Each GitHub Release now attaches the TypeScript packages as tarballs with a `SHA256SUMS` file.

### Changes

This is a minor release because callers must act on several changes. Read
[Breaking changes in 0.4.0](#breaking-changes-in-040) before you upgrade.

**Change history in the console.** Record, actor and tenant histories show the
first two recorded field changes of each event, and a count opens the full
event. Long values show both ends, and the full value on hover or keyboard
focus. On a record page, click a field to see its history, and pick the tenant
when one record ID is used by several tenants. Set, removed, null, empty-string
and redacted values read differently. The console recognises only the default
`[redacted]` replacement; custom replacements appear as recorded. Within one
loaded page, events in the same millisecond are ordered by their parent links.
Live rows follow arrival order. (#405)

**Change value kinds.** Ingest records the JSON kind of each side of a change
(`absent`, `null`, `string`, `number`, `boolean`, `json`). Event reads, JSONL
exports, the CSV `changes` cell and webhook bodies return them as optional
`beforeKind` and `afterKind`. The `before` and `after` text, the CSV headers
and the export schema version are unchanged. Events stored before 0.4.0, or by
an older server during the upgrade, have no kinds, so they cannot tell `null`
from the text "null", or an absent value from an empty string. Send numbers as
numbers and explicit nulls as `null`, omit `before` when a field is created and
`after` when it is removed. Kinds are read metadata, not query fields. (#401, #415)

**Query.** `changes.before` and `changes.after` match the value text of any
change of the event, exactly and case-sensitively. They support prefixes,
regexes, value groups, presence and negation, but no ordered comparisons. They
are facet fields and work in webhook filters. Facets on them count elements, not
events. Each field is matched on its own: `changes.field:status
changes.after:PUBLISHED` also matches an event where another field became
`PUBLISHED`. Open the events to check which field took the value; a paired form
is tracked in #410. Only the first 256 changes of an event are indexed.
`impersonator.name` searches the support person's display name, and
`impersonator.id` is an alias of `impersonator`. An impersonator sent with a
name and no id is found by `impersonator.name`, but the event still shows no
impersonator (#409). Other `changes` keys and ordered comparisons against `*`
are now refused; see the breaking changes. (#404, #415)

**Read windows.** `GET /v1/events` and `GET /v1/facets` return
`range: { from, to }`, and exports send `X-Logbird-Range-From` and
`X-Logbird-Range-To`, which viewer-token browser reads can also see. They are
the bounds the query used: `from` inclusive, `to` exclusive, on `timestamp`, in
ISO 8601 UTC with milliseconds. The default is unchanged: without `from`, a read
covers only the 24 hours before `to`. Compare the stated window with the one you
meant before you treat a result as a whole history. Event detail applies no
window. The OpenAPI document now describes every `/v1` read and its parameters,
the sort order (events in the same millisecond are ordered by id, not by cause)
and paging: a cursor carries no window, so send the first page's `range` back,
and paging is not a snapshot. (#398)

**Ingest cuts and limits.** An event with more than 64 targets, more than 256
changes or a change field name longer than 256 UTF-16 code units is still
accepted, and its stored payload keeps everything sent; only the indexed copy is
cut. Ingest now says so: the answer has one coded warning per cut
(`targets_truncated`, `changes_truncated`, `change_fields_truncated`) with counts
only, and the event carries `logbird.truncated.targets`,
`logbird.truncated.changes` or `logbird.truncated.changeFields`. Find cut events
with `attr.logbird.truncated.targets:*` (and the other two). Only Logbird writes
under `logbird.truncated`: a producer value there is left out of the indexed
attributes, and the payload keeps it. The event drawer shows titles such as
"Targets · 64 of 70". Events stored before 0.4.0 carry no such attribute even
when they were cut. Attribute count, attribute value size, attribute depth and
description length are documented but not flagged. The new
[limits page](docs/limits.md) lists the per-event and per-request limits and
what happens past each. (#400)

**Scoped read.** The `actor_email` mask now also covers the impersonator, in
search, event detail, facets, CSV and JSONL exports, viewer tokens and masked
webhooks. `impersonator.email` shows as a pseudonym. Impersonator pseudonyms are
keyed by role, so they do not match the actor pseudonym of the same address. An
impersonator name that carries an address shows as a pseudonym too. For actors
and impersonators, a name that carries an address now always shows the email's
pseudonym when there is an email, and names of 511 or more UTF-16 code units are
treated as carrying one. Pseudonyms stay linkable within a role. The mask does
not cover addresses in other fields (descriptions, executor, tenant or target
names, ids, other attributes), or an address spelled without `@`, such as
`rita%40example.org`. (#396)

**TypeScript SDK.** Client redaction takes `addKeys` (literal names, ASCII case
ignored), `paths` (exact locations) and `keepPaths` (exemptions), with a fixed
precedence documented in the SDK README. `readAuditEvent` returns one event with
its parents, child count, operation size and original payload. `iterateAuditTrail`
reads every page of a trail and fails with a `LogbirdError` if the server's
window does not match the one asked for. A completed pass is not a snapshot: an
event stored during the pass with a timestamp behind your position is not
returned. To pick up late arrivals, read again later with `receivedAt:>=` and
skip ids you already have. A pass keeps every yielded id in memory. Trails take
`order: 'asc' | 'desc'`, and pages expose `range`. The client exposes
`droppedByReason` and `possiblyStoredDropsByReason`, `onDrop` details,
`track(event, { preserveId: true })`, `LogbirdError` codes and `onWarning` codes.
The SDK does not surface the server's ingest warnings yet. (#393, #394, #398,
#402, #403)

**.NET SDK.** `RedactionOptions.AddPaths` and `KeepPaths` use the TypeScript
path syntax and precedence. Invalid paths throw when the client is constructed,
naming the option and entry index. The read client adds `EventPage.Range` and
`FacetResult.Range` (`EventRange`, `null` from servers older than 0.4.0),
`StoredChange.BeforeKind` and `AfterKind`, and the facet fields
`changes.before`, `changes.after`, `impersonator.name` and `impersonator.id`.
`ExportAsync` does not expose the range headers. (#397, #398, #401, #404)

**Release packages.** Each GitHub Release from 0.4.0 on attaches
`logbird-sdk-0.4.0.tgz`, `logbird-hono-0.4.0.tgz`, `logbird-vue-0.4.0.tgz`,
`logbird-nuxt-0.4.0.tgz`, `logbird-tanstack-start-0.4.0.tgz` and `SHA256SUMS`.
Install them as described in
[Install the SDK](docs/integrating-a-backend.md#install-the-sdk). The Vue, Nuxt
and TanStack Start tarballs are type-checked, but no tested install recipe
exists for them yet. The console's install snippet still shows the
source-checkout command. The `0.4` and `latest` image tags now move only after
the GitHub Release exists, and never back to an older release. (#395)

### Breaking changes in 0.4.0

Each item says what changed, who is affected and what to change.

**TypeScript SDK and integrations**

- **Redaction is on by default.** The client replaces values under common
  secret keys (passwords, secrets, tokens, OTPs, API keys, authorization,
  cookies, credentials, private keys) in every event, including events from the
  framework adapters, `createAudit` and `jobAudit`. It runs after `beforeSend`
  and before the 256 KiB size check. The default pattern matches any part of a
  key, so it also matches keys such as `tokenCount` and `secretary`. Identifier
  fields are kept. Affected: anyone whose events carry such keys they want
  stored, and anyone whose `beforeSend` hook is the only redaction policy. To
  keep the old behaviour, pass `redaction: false`. Otherwise set your policy
  with `keys`, `addKeys`, `paths` and `keepPaths`. A value already replaced by
  `beforeSend` cannot be restored by `keepPaths`. (#393)
- **`flush()` covers what was queued at the call.** It covers events queued or
  already sending when it is called, and settles independently of later
  captures. It resolves when those events are acknowledged or reported as
  drops. After retry exhaustion it rejects and keeps the unresolved events
  queued, within `maxQueueSize` and the drop policy. A malformed or incomplete
  acknowledgement leaves events eligible for retry. Affected: code that treats
  a resolved `flush()` as covering events captured later. Call `flush()` after
  the captures it should cover, and handle its rejection. (#394)
- **`shutdown()` rejects on delivery failure, and the Hono adapter propagates
  it.** Shutdown closes capture at once and applies one `shutdownTimeoutMs`
  budget (default 10,000 ms, 0 to stop at once) to pending capture preparation,
  the active request, retries and the queued tail. On delivery failure or
  timeout it reports each remaining event as a `shutdown` drop, clears the queue
  and rejects. Hono `capture.shutdown()` now rejects the same way. Affected:
  every host that calls `shutdown()`. Await it in the host lifecycle and catch
  its rejection, for the client and for `capture.shutdown()`. (#394)
- **Drop accounting.** `onDrop(event, details)` gets `details.reason`,
  `mayBeStored`, and a safe rejection code or HTTP status when available;
  one-argument callbacks still work. `dropped` counts every drop: queue
  evictions, server rejections, permanent HTTP failures, size, depth and
  serialization refusals, a failed `beforeSend`, hook filters and shutdown
  refusals. `droppedByReason` splits it by `queue_full`, `rejected`,
  `http_error`, `too_large`, `input_too_large`, `input_too_deep`, `invalid`,
  `before_send_failed`, `redaction_failed`, `filtered`, `diagnostic_reentry`
  and `shutdown`. `possiblyStoredDropsByReason` keeps the uncertain subset even
  when a notification is skipped. Diagnostic callbacks now run asynchronously
  after the queue changes; their failures count in `failedNotifications`, and
  callbacks past a backlog of 1024 count in `skippedNotifications`. Affected:
  alerting on `dropped`, and code that expects `onDrop` or `onError` to run
  synchronously. Alert on the reasons you care about. When `mayBeStored` is
  true, replay from your outbox with the original id, timestamp and content.
  Queued drop snapshots hold the full event, so keep them out of logs.
  (#394, #402)
- **Authenticated requests never follow redirects.** Ingest and read requests
  use manual redirect handling. Ingest counts a redirect as an `http_error`
  drop with `ingest_redirect`, and a read rejects with `read_redirect`. In a
  browser, an opaque redirect is treated as a transport failure and the batch
  is kept for retry. Affected: an `endpoint` that redirects (for example
  `http` to `https`, or an old host name). Set `endpoint` to the origin that
  serves the console and `/v1`. (#402)
- **Diagnostics are `LogbirdError` codes without server text.** Capture,
  delivery, resolver, read and redaction errors are `LogbirdError`s with a
  stable `code` and safe `status` or `count` fields. They no longer carry
  server response text or the original thrown error. `onWarning` receives a
  `LogbirdWarning` with a code and a field path. A promise returned from
  `beforeSend`, which must be synchronous, is refused. A throwing Hono
  automatic-capture skip hook counts as an `invalid` drop. Affected: code that
  matches error messages or original error types. Match on `error.code`. A read
  cancelled by the caller still rejects with `AbortError`: with the caller's
  reason before dispatch, and with a fixed message after it. (#394, #402)
- **Size and depth guards before hooks.** Before copying input or running
  `beforeSend` and redaction, the SDK refuses an event whose estimated JSON size
  exceeds 1 MiB (`input_too_large`), or whose metadata or a change value nests
  deeper than 1,000 levels (`input_too_deep`), with `mayBeStored: false`, even if
  redaction would have made it smaller. The estimate is a lower bound and is
  approximate near the limit, and the TypeScript and .NET SDKs estimate numbers
  differently. The 256 KiB limit on the serialized event is unchanged
  (`too_large`). Affected: producers that pass large or accessor-backed objects.
  Pass plain JSON data and convert accessors to values at capture. (#402)
- **Response caps and read budget.** Ingest acknowledgements are capped at
  4 MiB and read pages at 64 MiB; oversized and unused bodies are cancelled.
  An oversized acknowledgement keeps the events queued and a flush that
  exhausts its retries rejects with `response_too_large`. A read has a
  30-second budget (`read_timeout`) and validates the page and its rows. While
  four cancelled or abandoned requests are still cleaning up, new dispatch is
  refused (`ingest_requests_outstanding`, `read_requests_outstanding`). Affected: callers that read
  very large pages or start many reads at once. Lower `limit` and bound your
  own read concurrency. (#394, #402)
- **Node timers no longer keep the process alive.** Background batching,
  request and backoff timers are unreferenced on Node. Affected: scripts that
  relied on the SDK to keep the process running until delivery. Await
  `flush()` or `shutdown()` before exit. (#394)
- **Adapters keep the returned event id.** Hono and job capture send the id
  that `audit()` returned, even if `beforeSend` changes it. Affected: hooks
  that rewrite `id` in adapter captures. Set the id before capture instead.
  Direct `track()` keeps a hook's id unless you pass `{ preserveId: true }`.
  (#394)
- **Trails must name their time window.** `trailQuery` throws a
  `TrailQueryError` for a trail without `range` or `range.from`, and
  `TrailQuery.range` is required in the types. This covers Vue and Nuxt
  `useAuditTrail`, the Nuxt `authorize()` hook and the TanStack Start helpers.
  Affected: every trail read without `range.from`, which silently read only the
  last 24 hours. Pass `range: { from }` (`to` defaults to now), or
  `range: SERVER_DEFAULT_RANGE` to read the server's default 24 hours on
  purpose. (#403)

**API and query language**

- **An unknown `changes.*` key is refused.** Any `changes` key other than
  `changes.field`, `changes.before` and `changes.after` (for example
  `changes.to`, `changes` alone, `_exists_:changes.x`, or `Changes.field` in
  another letter case) fails the whole query with 422 `invalid_query`, reason
  `unknown_field`, including inside `OR` or `NOT`. This applies to search,
  facet `q`, export and suggestions; as a facet `field` or `by` such a key gets
  422 `validation_error`. A saved view with such a key shows the error when
  opened. A webhook endpoint whose stored filter has one is held, and create
  and edit refuse it. Such a term never matched anything. Affected: saved views,
  webhook filters and API callers with such a term. Remove the term, or write
  `attr.changes.<key>` for a literal attribute, then edit a held endpoint's
  filter to resume it. (#404)
- **Literal attributes named like the new fields.** `changes.before`,
  `changes.after`, `impersonator.name` and `impersonator.id` now read the
  event's columns. An attribute sent as a literal top-level dotted key with one
  of those names is reached only as `attr.changes.after` (and so on). Affected:
  saved views and webhook filters that read such an attribute; they now match
  the column, without an error. Rewrite those terms to `attr.<key>` before
  upgrading. (#404)
- **Ordered comparisons against `*` are refused.** `attempt:>*` or
  `actor:>*` used to mean presence, or always true on numbers. They now answer
  422 on every field. Open bounds inside ranges, such as `attempt:[2 TO *]`, are
  unchanged. Write `field:*` or `_exists_:field` for presence. (#404)

**Scoped read**

- **`actor_email` also masks the impersonator.** Masked keys, viewer tokens
  minted with the mask and masked webhook endpoints now pseudonymize
  `impersonator.email`, remove the attribute paths below it, and pseudonymize
  an impersonator name that carries an address. Literal dotted `actor.name` and
  `impersonator.name` attribute keys are removed. Filters and facets on
  `impersonator.email`, a path below it, or those literal keys answer 422
  `invalid_query`, reason `not_allowed`; webhook create and edit refuse them. A
  masked endpoint whose stored filter names `impersonator.email` sends nothing
  and is held. Affected: tenant-facing views and receivers that showed or
  filtered on the impersonator's address. Remove such filters. Replace a held
  endpoint rather than editing it, as
  [the webhook settings](docs/self-hosting.md#webhook-endpoint-settings)
  describe, because an edit would reveal which pending events the old filter
  matched. (#396)
- **Masked attribute paths match in any ASCII letter case, with their
  children.** For all three masks (`ip`, `user_agent`, `actor_email`), keys such
  as `Context.IP`, `Actor.Email` or `impersonator.EMAIL.work` are treated like
  the masked path: removed (or, for `impersonator.email`, pseudonymized) and
  refused in filters and facets. Paths below a masked path, such as
  `context.ip.v4`, are removed and refused too. Only A to Z are folded.
  Affected: masked readers that saw such keys. Send addresses in `actor.email`
  or `impersonator.email`, and IPs and user agents in the context fields. (#396)
- **Name pseudonyms.** A name that carries an address now shows the pseudonym
  of the stored email whenever there is one, and names of 511 or more UTF-16
  code units show as pseudonyms. Affected: masked readers that compared name and
  email pseudonyms, or that showed very long names. (#396)

**.NET SDK**

- `Redactor.Redact(JsonObject)` refuses identifier values that are JSON
  objects or arrays. Pass scalar identifiers. (#397)
- `StoredChange` record equality now includes `BeforeKind` and `AfterKind`, so
  the same change read from an older and a newer server can compare unequal.
  Compare `Field`, `Before` and `After` when that matters. (#401)

### Self-hoster actions

Follow [Upgrades and backups](docs/self-hosting.md#upgrades-and-backups) to
stop writers and take matched backups. Pin `LOGBIRD_VERSION=0.4.0` after the
images publish. Run the migrate service before starting the new API and worker.

- **ClickHouse migration `012_change_value_kinds.sql`** adds the
  `changes_before_kind` and `changes_after_kind` columns to `events` with
  `ALTER TABLE … ADD COLUMN IF NOT EXISTS`. It runs with the normal migrate step.
  It changes metadata only: existing data parts stay in place, nothing is
  backfilled, and existing events read with unknown kinds. An older server can
  keep writing to the migrated table. The new API checks for the columns and
  stops with a startup error before listening if it cannot read them.
- There is no PostgreSQL migration.
- Upgrade every API and worker replica together, or drain the old ones, before
  relying on the impersonator mask: older replicas return and send the
  impersonator's email in clear to masked readers. Before rolling back to a
  release before 0.4.0, follow the rollback steps in
  [webhook endpoint settings](docs/self-hosting.md#webhook-endpoint-settings),
  which now include viewer tokens.
- Before upgrading, review saved views and webhook filters for the three query
  changes above: unknown `changes.*` keys (refused or held), terms that read a
  literal attribute named `changes.before`, `changes.after`,
  `impersonator.name` or `impersonator.id` (rewrite to `attr.<key>`), and
  masked endpoints that filter on `impersonator.email` (replace them).
- If you follow the `0.4` or `latest` image tags, they now move only after the
  GitHub Release exists. Pin exact versions or digests for controlled upgrades.

### SDK users

- Neither SDK is on npm or nuget.org yet. Install the TypeScript packages from
  the GitHub Release tarballs as described in
  [Install the SDK](docs/integrating-a-backend.md#install-the-sdk); releases
  before 0.4.0 have no tarballs. The TypeScript packages need Node 20 or later
  and are ES modules only. Build the .NET SDK from source as the
  [.NET guide](docs/sdk-dotnet.md#1-install) describes.
- Work through the [breaking changes](#breaking-changes-in-040) for the
  TypeScript SDK and integrations before upgrading them.
- Send change values as their JSON types so kinds are recorded.

### Known limits

- Change fields and change values are matched independently (#410). Only the
  first 256 changes and 64 targets of an event are indexed.
- A trail pass, a paged read and an export are not snapshots.
- The SDK size guard is an estimate, approximate near its boundary.
- Custom redaction patterns (`keys`, `changeFields`) follow each platform's
  regex engine; for example `^label# Changelog

 also matches a trailing line feed in
  .NET. Prefer `addKeys` when a literal name is enough.
- The TypeScript SDK does not surface ingest warnings, and the .NET
  `ExportAsync` does not expose the range headers.
- The `actor_email` mask covers the actor's and impersonator's email and name
  only, and does not recognise encoded addresses.
- Edge cases in TypeScript SDK delivery and transport are tracked in #399, and
  console history follow-ups in #407.

## 0.3.0

### Highlights

- Logbird delivers signed webhooks for matching audit events. Project owners and admins can manage endpoints, rotate signing secrets, send test pings, inspect delivery attempts and resend completed deliveries.
- The .NET SDK can mint viewer tokens, query facets and stream exports for scoped reads.
- Scoped reads with the `actor_email` mask now protect addresses recorded in actor names across event results, facets and search.

### Changes

**Webhooks.** The worker discovers matching events and delivers signed payloads.
Endpoints support filters, tenant and record scopes, and field masks. The console
shows delivery history and explains when an endpoint needs filter, scope or cursor
review. Copy the signing secret when you create or rotate it. Receivers should verify
the signature against the raw request body and deduplicate by `webhook-id`, which
stays the same on retries and resends. In webhook filters, relative times are based
on each event's arrival, and regexes use RE2. See the
[webhook guide](docs/self-hosting.md#webhook-endpoint-settings). (#179, #248, #255, #343)

Each endpoint has a delivery window, which defaults to seven days and can be
set to no limit. Events that arrive after the window stay stored and searchable.
Changing the window applies to discovery after the save. Already queued
deliveries, resends and test pings are unaffected. The console shows an approximate
late-arrival count for completed arrival hours, starting after the latest
window change or 30 days ago, whichever is later. (#359, #360)

**Console.** Explorer filters, chips and Query-to-SQL conversion preserve the
meaning of quoted fields, literals and negated groups. Jump to keeps the server's
result order, and the Explorer offers to retry an incomplete ID lookup or failed
date check. Record history opens from its link. The overview shows an empty state
before the first event, and Fields reports target coverage. First-event examples
explain how to run the source SDK and how to check whether ingest rejected an event.
Members who follow a project link from another workspace can switch to it from the
project page. (#276, #281, #283, #290, #324, #335, #340, #346, #372, #379, #381)

Members can leave a workspace from its settings after confirming. The last
owner must make another member an owner before leaving. A removed member sees
a one-time notice, and an invitee without a name is prompted to enter one.
Workspace deletion through the auth API is disabled because it could leave
events behind. (#375)

**SDK breaking changes.**

- **Inbound correlation.** TypeScript `createAudit` and the Hono, Nuxt and
  TanStack Start integrations ignore inbound `x-logbird-operation` and
  `x-request-id` by default. Enable `useOperationHeader` and
  `useRequestIdHeader` only behind a trusted ingress that sets or sanitizes
  those headers. Explicit correlation IDs on events and resolver results still
  take precedence. ASP.NET Core callers have the same opt-ins through
  `LogbirdRequestOptions.UseOperationHeader` and `UseRequestIdHeader`.
  (#350, #342)
- **Redaction.** Both SDKs keep event and party identifiers. Matching a party
  redacts its other fields. Transform identifiers before redaction if they
  need pseudonyms, for example with TypeScript's `beforeSend`. TypeScript
  `redact()` returns the JSON form of the event and rejects cycles. .NET code
  that inspected `RedactionOptions.Keys` for names registered through
  `AddKeys` should read `AddedKeys`. Review custom patterns against both
  regex engines if you share redaction rules. (#345)
- **Read helpers.** TypeScript `trailQuery` refuses missing selectors, invalid
  selector values and malformed queries that could widen a read. Pass a target,
  actor, tenant or valid query. For a deliberately project-wide read, pass
  `q: 'timestamp:*'`. The `readAuditTrail` helper requires a non-blank `q`. Use
  `isTrailQueryError` to identify invalid inputs. Bind a Vue fetcher once if
  its method uses `this`. These helpers require Logbird 0.2.0 or later. (#311)
- **.NET public API.** Rename `GetAsync` calls on `LogbirdReadClient` to
  `GetEventAsync`. Replace counter construction or deconstruction with
  property reads, and return `default(LogbirdStats)` for a zero snapshot in
  test doubles. Use `AuditCarrier.ToJson()`, `ToJsonUtf8Bytes()` and
  `FromJson(...)` instead of `AuditCarrierJsonContext`, which is now internal.
  If you need an HTTP proxy, supply a trusted transport explicitly. (#309, #332)

**.NET.** The read client now supports viewer tokens, facets and streamed CSV or
JSONL exports, including JSONL evidence. Read results expose read-only
collections. Drop reports include `MayBeStored` for callers reconciling ambiguous
delivery outcomes. The [SDK guide](docs/sdk-dotnet.md) explains shutdown and
notification limits. NuGet publication requires separate maintainer enablement.
(#262, #295, #308, #326, #332, #342, #349, #367)

**Scoped read.** The `actor_email` mask now pseudonymizes addresses stored in
actor names in event results and facet values, groups and labels. The address
is excluded from actor-name filters and free-text matching on that field.
Pseudonyms are stable within a project. If a reader can cause a chosen address
to be recorded and link its pseudonym to other events, omit actor fields from
what that reader can see. (#361, #371)

**Marketing site.** The site adds use-case pages for customer-facing audit logs
and support investigations. Console captures open full size, and the developer
examples include outcome and description. The optional site deploys separately.
(#266, #282, #289, #291, #376)

### Self-hoster actions

Follow [Upgrades and backups](docs/self-hosting.md#upgrades-and-backups) to
stop writers and take matched backups. Pin `LOGBIRD_VERSION=0.3.0` after the
images publish. Run the migrate service before starting the new API and worker.
If their environments are managed separately, give both roles the same
`WEBHOOK_SECRET_KEY` or the same `BETTER_AUTH_SECRET` for a derived key, and
align `WEBHOOKS_ALLOW_HTTP`. Give the worker the existing SMTP settings,
`MAIL_FROM` and `APP_URL` for disable notices.

Existing enabled endpoints with an empty filter can start delivering at the
original rollout time in UTC. Older events are not backfilled. Confirm stored
non-empty filters in Project settings and resolve any scope or cursor holds
before delivery resumes. Follow the
[webhook upgrade and recovery instructions](docs/self-hosting.md#webhook-delivery-on-upgrade)
for held endpoints or a missed delivery interval.

PostgreSQL takes the locks below during migration. `ACCESS EXCLUSIVE` blocks
reads and writes. `SHARE` and `SHARE ROW EXCLUSIVE` block ordinary writes.

| PostgreSQL migration | Additive or data change | Locks |
| --- | --- | --- |
| `20261122140000_webhook_deliveries` | Additive. Adds rollout cursors, delivery, attempt and notice tables, and indexes. | `ACCESS EXCLUSIVE` on `WebhookEndpoint`. Indexes are built without `CONCURRENTLY`. |
| `20261122150000_webhook_rollout_utc` | Beyond additive. Changes defaults to UTC, adds a warning timestamp and repairs untouched rollout cursors. | `ACCESS EXCLUSIVE` on `WebhookEndpoint`, `WebhookDelivery` and `WebhookDisableNotice`. The repair updates matching rows. |
| `20261122160000_webhook_repair_original_cursor` | Data-only repair of remaining original rollout cursors. | `ROW EXCLUSIVE` on `WebhookEndpoint` and row locks on updated endpoints. |
| `20261122170000_webhook_delivery_occurrence` | Beyond additive. Adds a nullable webhook ID and replaces the delivery uniqueness index with one that includes arrival time. | `ACCESS EXCLUSIVE` on `WebhookDelivery`. The replacement index is built without `CONCURRENTLY`. |
| `20261122180000_webhook_scope_mask_cursor_review` | Additive. Adds field masks and a cursor review flag. | `ACCESS EXCLUSIVE` on `WebhookEndpoint`. |
| `20261122190000_webhook_reconciliation` | Additive. Adds a scope review flag and a verified cursor floor. | `ACCESS EXCLUSIVE` on `WebhookEndpoint`. |
| `20261122200000_webhook_filter_review` | Additive schema with a data backfill. Adds review columns and flags existing non-empty filters for review. | `ACCESS EXCLUSIVE` on `WebhookEndpoint`. The backfill updates matching rows. |
| `20261122210000_webhook_scan_attempted_at` | Additive. Adds the attempt timestamp and its scheduling index. | `ACCESS EXCLUSIVE` for the new column and `SHARE` for the non-concurrent index build on `WebhookEndpoint`. |
| `20261123100000_webhook_filter_review_reason` | Additive. Adds a nullable reason for a filter hold. | `ACCESS EXCLUSIVE` on `WebhookEndpoint`. |
| `20261123120000_webhook_claim_rotation` | Additive. Adds the per-project claim rotation table and its foreign key. | `SHARE ROW EXCLUSIVE` on `Project` and `WebhookClaimRotation` for the foreign key. |
| `20261124100000_webhook_delivery_window` | Additive. Adds window columns and a check constraint. Existing endpoints get seven days. | `ACCESS EXCLUSIVE` on `WebhookEndpoint`. PostgreSQL validates the new constraint against existing rows. |
| `20261124120000_member_keep_an_owner` | Additive schema. Adds functions and triggers that enforce the owner rule on future writes. Existing memberships are preserved. | `SHARE ROW EXCLUSIVE` on `member` when installing the triggers. The triggers also take a transaction advisory lock per workspace when deleting or updating an owner row. |

Workspaces that already have no owner keep working. The migration does not
assign owners. If a workspace later gains an owner, the triggers prevent removal
or demotion of its last owner.
Removing or demoting an owner must run under READ COMMITTED, PostgreSQL's
default and what Logbird uses. Under REPEATABLE READ or SERIALIZABLE the trigger
refuses it with SQLSTATE `LB410`, even when another owner remains. Scripts that
change owners at those isolation levels must switch to READ COMMITTED.

ClickHouse migration `011_events_lateness.sql` is additive. It uses DDL locks
to create the lateness rollup table and its materialized view, with no backfill
or mutation of existing events. Counts start when the view is created. A storage
failure, retried write or restore can make the count higher or lower than the
actual count.

## 0.2.1

### Highlights

- Jump to (Ctrl K) finds an entity by its id: the exact id leads the list, a record is found by its bare id (`article_27_2` for `article:article_27_2`), and "Search events for" runs the id query instead of free text.
- For a recognized entity ID entered as a single free-text term, the explorer's empty state offers the ID query. Otherwise, it offers "Search all time" when the all-time check finds matches outside the selected range.
- The console forwards `/pricing` and `/use-cases` to the marketing site when one is configured.

### Changes

**Entity search.** With `q`, the console's entity list
(`GET /api/projects/:projectId/entities`, for actors, tenants, executors and records) ranks
by match first, then by the chosen sort: the id exactly as typed, the same id in
another case, id prefix, name prefix, substring, then fuzzy. A record's bare id counts as
its id. One or two characters match only ids, a record's bare id and names that start with
them. `q` accepts up to 1,024 characters (was 200). Without `q` nothing changes. On a
project with 1.14 million records, the four lookups behind Jump to took 12 to 300 ms in our
measurement, down from 0.85 to 1.35 s. The order is described in
[docs/SPEC.md](docs/SPEC.md).

**Console.** Jump to opens an entity whose id is exactly the typed text, across actors,
tenants, executors and records. When "Search events for" finds no exact ID after a
complete lookup, it opens the explorer with the query as typed. If the lookup fails or is
partial and finds no exact ID, it offers "Search as text". While new entity suggestions
load, previous suggestions that still match the input remain visible and dimmed. Record
pages say "Every event for this record since ...".

**Marketing site.** The console's forwarding list gains `/pricing` and `/use-cases`.
`docker-compose.site.yml` and the site image accept an optional `WEB_CHECKOUT_URL`; leaving
it unset changes nothing.

**.NET.** When `FlushAsync()` returns `true`, `Stats` already reflects the delivered,
rejected or dropped outcome of each event the flush covered. The `Logbird` meter reads
those counters from live clients when collected. An ASP.NET Core example (`examples/aspnetcore`) and a
[.NET guide](docs/sdk-dotnet.md) are added. The packages are not on nuget.org yet; the
release workflow has a NuGet job that stays off until a maintainer enables it.

### Upgrade and known limits

- Upgrading from 0.2.0 requires no new settings or database migrations. Follow
  [Upgrades and backups](docs/self-hosting.md#upgrades-and-backups) for v0.2.1 and pin
  `LOGBIRD_VERSION=0.2.1` when using published images. If you are upgrading from an
  earlier version, also follow the 0.2.0 breaking-change and migration notes. If you host
  the optional marketing site, deploy its matching revision separately to serve the new
  pages.
- The entity list is the console's own API; `/v1` callers see no change. Its cursor is now
  bound to whether the list was a search, so a console tab that was paging a search during
  the upgrade may need a reload.
- Two record pairs that join to the same text, such as type `catalog` with id `item:27` and
  type `catalog:item` with id `27`, share one row in the record directory, so their counts
  are merged there (#223). Their events are stored and searched separately.

## 0.2.0

### Highlights

- Show each customer only its own audit trail: tenant-scoped read keys and short-lived viewer tokens (15 minutes by default) read one tenant's (or one record's) events through search, event detail, counts grouped by a field and export. The server enforces the scope, and ClickHouse enforces the tenant as well when the restricted query user is configured.
- Stored events are exact: 64-bit ids and long decimals keep every digit, a record's history matches its type and id on the same target, and a slow total count no longer fails a search.
- Breaking for some saved queries and API filters: `record:` now selects one record (to search a custom attribute named `record`, write `attr.record:`), `\*` and `\r` are now escapes, and numeric attribute values are indexed under one spelling. Read the Breaking changes section of CHANGELOG.md for 0.2.0 before upgrading.

### Breaking changes

This is a minor release because of the query language and how numbers are indexed. The
default Compose installation needs no settings change. The reference for everything below
is the [query language](docs/query-language.md) and
[numbers and ids](docs/integrating-a-backend.md#numbers-and-ids).

- **`record:` now selects a record.** `record:<type>:<id>` matches one target with that
  type and id, and `record:*` matches any event with a target. A query that used `record:`
  for a custom attribute named `record` changes meaning, and a value that is neither a
  type and id nor `*` (for example `record:pending`) is rejected with 422. To keep
  searching that attribute, write `attr.record:pending`. This applies to `q` on
  `/v1/events`, `/v1/export` and `/v1/facets`, to saved views, and to the filter stored on a
  webhook endpoint (nothing is delivered in this release; review any endpoint filter that
  uses `record:`).
- **`\*` is a literal asterisk**, in quoted and unquoted values. `tenant:team\*` used to be
  a prefix search for ids starting with `team\`; it now matches the exact id `team*`.
- **`\r` in a quoted value is a carriage return**; `\\r` is a backslash followed by `r`.
- **Numbers have one indexed spelling.** A numeric attribute value or id is indexed as one
  canonical text of its exact value, so events sent with `1e-7` are indexed as `0.0000001`.
  A saved filter written with another spelling of the number can miss events stored from
  this release on; write the canonical spelling.

### Changes

**Scoped read access.** A `scoped-read` key carries a scope (`tenantId`, optionally one
target, action prefixes and a field mask). `POST /v1/viewer-tokens` mints a token for a
browser, valid 15 minutes by default (60 to 3,600 seconds). `/v1/events`,
`/v1/events/:id`, `/v1/facets` and `/v1/export` apply the scope outside the caller's
query. `/v1/facets` groups by one or two fields; `record` and fields hidden by the scope's
mask cannot be grouped. Keys can expire; rolling a key keeps its scope and, unless a new
one is given, its expiry. See [scoped read access](docs/scoped-read-access.md) and
[security](docs/security.md).

**Exact numbers.** Numbers a double cannot hold are stored, returned and exported with
their exact digits, and numeric entity ids are indexed, so integer primary keys work as
sent. A number is indexed as one canonical text of its value: its plain decimal in the
usual case (`42`, `42.0` and `4.2e1` are all `42`), scientific notation for very large or
very small values, and not at all when neither fits the index (254 characters for an id,
2,044 for an attribute value); the stored event keeps it either way. Equality on a number
is exact; `>` and `<` compare at double precision. Send `occurredAt` as ISO-8601 or
integer epoch milliseconds. The rules are in
[numbers and ids](docs/integrating-a-backend.md#numbers-and-ids).

**Record histories.** Record pages, the Record facet and the read helper in the TypeScript
SDK use `record:<type>:<id>`. A saved view that filters `target:` and `target.type:`
separately still opens exactly as saved. For some query shapes the console adds a note
that the view can include other records, and, when the pair can be rewritten as a single
`record:` term, an "Open exact version" button. Which shapes get the note is specified in
the [query language](docs/query-language.md); a view without a note is not thereby exact.

**Search totals.** A slow count no longer fails a search. The count has a one-second
budget; when it runs out, the rows are returned with `totalExact: false` and `total` as a
lower bound. When the console cannot show an exact total it shows a lower bound ("≥ N", or
"10,000+" at the cap).

**Ingest.** A request over 1,000 events or 5 MiB is still refused as a whole with 413.
Inside those limits, an event over 256 KB is rejected on its own (`invalid_event`) and the
rest of its batch is stored. A console test event completes only the "first event" setup
step; sources beginning with `logbird-` are reserved for events Logbird generates.
Events sent through the console's origin by a client that sent neither `X-Logbird-SDK` nor
a User-Agent were labelled "via node"; new events like that now show "via HTTP". Events
stored earlier keep their label.

**Arrival-time index.** Migration 010 adds a min/max index on `received_at`. The live view
uses it today to skip parts of a project's history whose arrival time misses the requested
range; webhook delivery and alerts will use it when they ship. In the one large historical
import that was measured it gave no gain; see
[self-hosting](docs/self-hosting.md).

**Console.** Record, actor, tenant and executor pages lead with the complete history,
newest first. Every time names its zone, with one switch between local time and UTC. The
event drawer lists up to five of the events an event caused, with a link to all of them;
unknown events and operations say so. Members, invite links and workspace activity move to
Workspace settings. Overview drill-downs open exactly what their widgets show, and data
from a previous project or entity is never shown as current.

**.NET.** The `Logbird` and `Logbird.AspNetCore` packages are in the repository
(`sdks/dotnet`). They are not published to NuGet yet.

### Upgrade and known limits

- **Upgrade order.** Follow [Upgrades and backups](docs/self-hosting.md#upgrades-and-backups),
  which stops the console, API and worker for the matched backup, with `LOGBIRD_VERSION`
  set to `0.2.0` before pulling. The `0.2.0` migrate image applies two additive PostgreSQL
  migrations (new columns on `ApiKey`, and a trigger, `ApiKey_roll_fence`, that refuses a
  replacement key that drops its predecessor's scope or expiry; no data changes) and
  ClickHouse migration 010. The migration starts building the index and does not wait for
  it: the build continues in the background, needs no extra downtime, and reads stay
  correct meanwhile. Check `system.mutations` in the Logbird database for progress.
- **Restricted query user.** The Compose and Coolify stacks re-provision it automatically
  (the migrate image runs `create-query-user` before the server starts). Source
  installations run `pnpm --filter @logbird/clickhouse create-query-user` once after
  upgrading, in a quiet moment, and restart the server; it is idempotent and keeps
  credentials. Until then the query builders remain the only layer that enforces a scope's
  tenant.
- **Rollback and mixed versions.** Keys with a scope or an expiry have a longer secret
  that releases before 0.2.0 reject, so after a rollback they stop working instead of
  reading the whole project. An older server ignores a requested expiry and returns a
  permanent key: after creating or rolling a key, compare the returned kind, scope and
  expiry with what you asked for, and revoke the key if they differ. Rolling a scoped or
  expiring key on an older server fails at the database trigger and creates nothing.
- **Retries across the upgrade.** A retry, after the upgrade, of an event first stored
  before it that contains a number a double cannot hold can answer
  `duplicate_id_conflict`, because its stored digits were rounded. Events stored before
  this release keep their rounded values, and their numeric entity ids stay unindexed.
- **New per-event rejections.** An event over 256 KB, and an event nested more than 1,000
  levels deep that holds a number a double cannot keep, are each rejected as
  `invalid_event`; the other events in the batch are stored.
- **Scoped reads.** One tenant per scope. A scope names stored ids. String ids are still
  trimmed at ingest, so an id sent with surrounding whitespace is its trimmed id. A
  numeric id is stored as the canonical text of its value, so a tenant sent as the number
  `42` and one sent as the string `"42"` are the same tenant and the same scope, while the
  string `"42.0"` is a different one; for very large or very small numbers the canonical
  text is scientific notation, and a string holding the expanded digits is a different
  tenant. Events stored before this release whose tenant id was a number are not visible
  to any scope (a numeric actor or target id does not hide an event from a tenant-only
  scope), and older events match a target scope only for the targets indexed when they
  were ingested. With the restricted query user, a scoped read runs under that user's
  limits (10 seconds, 5,000,000 rows read and 1 GiB per query), so a very large tenant
  over a wide range can hit them, and a scoped export takes both of the workspace's export
  slots. Revoking a key reaches its viewer tokens within 30 seconds. Rotating
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
