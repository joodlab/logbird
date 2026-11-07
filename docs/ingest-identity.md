# Immutable event ids

An id names one immutable event within a project, across all timestamps and
partitions. Public ingest, workspace audit writes and sample generation use the
same receipt lifecycle. See [Event ids and retries](concepts.md#event-ids-and-retries)
for integration guidance.

## Coordination and identity

Shared project advisory locks permit concurrent API processes; the Postgres unique
key on `IngestReceipt(projectId,eventId)` arbitrates ownership. Claims are inserted
in sorted order with `createManyAndReturn(skipDuplicates)` and use Prisma's date
encoding rather than session-timezone-sensitive raw Date parameters. No Postgres
transaction spans ClickHouse I/O. Maintenance/recovery takes the exclusive lock.

`v1:` fingerprints hash recursively key-sorted parsed INPUT plus the resolved UTC
timestamp. Arrays retain order; strings and values outside every indexing cap
participate. The first receipt clock resolves omitted/invalid occurredAt. Transport
SDK headers do not participate. Search normalization must never define v1 identity.
Unprefixed receipts retain the former normalized-column comparison for rollout
compatibility; stored payloads upgrade them on confirmation. A missing old receipt
has only its old digest, so its original lossy comparison remains until reinsertion.
Stop/drain old writer binaries before rollout; direct ClickHouse writes bypass fencing.

Confirmed receipts expire after ten minutes. Hot-path pruning is throttled to once
per minute per project/process, with idle entries evicted. DELETE statements prune
at most 5000 rows each, including the hourly global sweep. Unresolved receipts never
expire through ordinary pruning or retention cutoff cleanup.

`event_ids` is an additive ReplacingMergeTree keyed by `(project_id,event_id)`, fed
by a materialized view. Migration 006 backfills with INSERT SELECT once (a retry is
idempotent under replacement). No projection materialization or events mutation is
required. The first SELECT reads narrow identity keys; payload is fetched only for
hits, using `(timestamp,event_id)` to bound raw-table work. The ownership recheck is
skipped if claim time minus first lookup time is less than half the receipt window.
Retention and project deletion purge `event_ids` alongside the four existing tables.
Legacy conflicting ids may retain only one index timestamp after replacement;
historical ambiguity remains outside the new-write guarantee.

## Bounded ambiguous writes

INSERT uses max_execution_time=30 seconds, async_insert_busy_timeout_max_ms=1000,
wait_for_async_insert=1 and a 60-second claim lease/client deadline. The body stream
checks the lease when consumed, before passing the body to transport. An expired
lease is never sent. Any numeric ClickHouse server exception releases this attempt's
claims: parse codes 6,27,38,41,53,69,72 return 422 invalid_event; other failures return
503 ingest_unavailable. Only a client timeout/reset after body handoff retains the
pending lease. Identity-read errors, including resource exhaustion and corrupt
legacy payloads, return 503 ingest_unavailable with Retry-After rather than 422.

An exact retry or hourly worker recovers expired claims per project after the
60-second lease plus a conservative 10-second async-flush bound. Recovery takes the
EXCLUSIVE project lock, runs SYSTEM FLUSH ASYNC INSERT QUEUE, then rechecks storage.
Matching rows are bulk-confirmed. Missing rows become ready (`claimedAt=null`) while
retaining the original fingerprint, receivedAt and eventAt; the next exact retry
atomically takes them over and reinserts with the original receipt clock while still
holding the exclusive recovery lock. Worker-readied claims use that same exclusive
replay path. The hourly
worker cannot recreate missing payloads (receipts deliberately store no payload),
so it readies them for the producer's retry. Mismatching stored rows remain fenced.
A failed flush/lookup releases nothing. No fleet-wide outage/operator attestation
is required; `scripts/reconcile-ingest.ts PROJECT` runs the same safe recovery.

Healthy siblings are inserted first, then unresolved indices return 503
ingest_pending with `details: {indices,eventIds}` and Retry-After: 1. Conflicts
against an unconfirmed competing claim also remain pending until its outcome is
known; a parse rollback therefore cannot cause a permanent false rejection.
Confirmed conflicts use a code-first explanatory rejected[].reason. The SDK retains
and retries the identical body and reports permanent conflicts through onDrop/onError.

Sample generation uses random run-prefixed ids plus receipt arbitration, so even
retained customer sample-event-N ids are safe. Removal drains expired async writes,
refuses live pending leases, deletes only matching sample row identities/receipts,
and rebuilds rollups under the exclusive project lock. Removed sample ids can retry.
Retention cutoff cleanup removes confirmed receipts only; pending claims survive
until reconciliation. Project deletion purges every receipt after the ClickHouse
purge. Organization FK cascade covers project receipts and ws: audit receipts (see
cloud-accounts-design.md); the deletion workflow still needs locked raw-data purges.

## Deployment, rollback and proof limits

Run pnpm db:deploy, pnpm db:generate and pnpm ch:migrate before starting the new
writer/worker binaries. Postgres migration 20261107140000_ingest_claim_lease adds
nullable claimedAt and an index after 20261107130000_ingest_receipts; old pending
claims receive the deployment clock as a conservative lease start. No shared DB
reset, migrate dev or db push is permitted. Back up receipt state before rollout.

Rollback requires stopping all new writers and preserving pending receipts. The
additive tables/column may be left in place for old binaries. To remove only the
ClickHouse addition, drop event_ids_mv then event_ids after stopping new writers;
events and the original rollups remain intact. Do not drop receipts with unresolved
writes. Additive schema compatibility does not grant old writers immutable semantics.

Search/export return the row that passed the filter; detail chooses the oldest
surviving receipt. Filters may surface a legacy non-canonical duplicate matching
that filter. This change cannot restore overwritten originals, fix historical
rollup overcounts, or globally canonicalize historical cursor pages.

The >=10M retained-history paired ingest/explorer benchmark and 1M receipt bytes
remain a separately scheduled acceptance gate. scripts/benchmark-ingest-identity.ts
must run at the final PR head under both heavy and logbird-stack slots with the
cloud load owner's approved fixture. Unit and small real-service proofs are not
10M/day capacity evidence.

Exact rollback (only after stopping all new writers and preserving unresolved
receipt state; commands target the verified logbird DBs):

```sql
-- ClickHouse
DROP VIEW IF EXISTS logbird.event_ids_mv;
DROP TABLE IF EXISTS logbird.event_ids;
ALTER TABLE logbird.migrations DELETE WHERE name = '006_event_ids.sql' SETTINGS mutations_sync=2;

-- Postgres: keep IngestReceipt and the original migration intact.
BEGIN;
DROP INDEX IF EXISTS "IngestReceipt_projectId_confirmedAt_claimedAt_idx";
ALTER TABLE "IngestReceipt" DROP COLUMN "claimedAt";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261107140000_ingest_claim_lease';
COMMIT;
```

The ClickHouse migration runner keys on the full filename stored in migrations.name;
it has no checksum and does not key solely on the numeric prefix. Recheck master's
migration directory immediately before merge, and coordinate a ledger rename if
006_event_ids.sql needs renumbering on an already-migrated installation.

Until this PR merges, old purge code used by other QA branches may leave orphan
index rows. Run `scripts/reconcile-ingest.ts --orphan-indexes` for counts first, then
add `--delete-orphan-indexes` to clean them up. The tool verifies project/workspace
absence twice, takes the exclusive project lock, and skips any id namespace with
surviving raw evidence. It deletes only event_ids rows, never events or receipts.
