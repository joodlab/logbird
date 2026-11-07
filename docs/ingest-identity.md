# Immutable event ids

An id names one immutable event within a project, across all timestamps and
partitions. Public ingest, workspace audit writes and sample generation share the
receipt lifecycle. See [Event ids and retries](concepts.md#event-ids-and-retries).

## Coordination and identity

Shared project advisory locks permit concurrent API processes. The Postgres unique
key on `IngestReceipt(projectId,eventId)` arbitrates ownership. Claims are inserted
in sorted order with `createManyAndReturn(skipDuplicates)` and Prisma date encoding.
No Postgres transaction spans ClickHouse I/O. Maintenance and recovery take the
exclusive project lock, including any recovered INSERT.

`v1:` fingerprints hash recursively key-sorted parsed INPUT plus the resolved UTC
timestamp. Array order, string contents and values beyond every indexing cap
participate. Omitted or invalid occurredAt keeps the first receipt clock. SDK
headers do not participate. Search normalization and today's admission rules must
never redefine stored identity. Stored v1 identity uses the original payload and
stored timestamp directly. One malformed legacy payload is rejected individually
as `stored_event_unreadable`; it cannot block healthy siblings or free its id.
Unprefixed receipts exist only in pre-merge development deployments of this branch,
including the shared dev DB; released master never created them. This compatibility
path is not required by an ordinary release upgrade. Unprefixed pending receipts retain the old normalized-column comparison until
stored evidence or reinsertion upgrades them. Frozen 3a1541f fixtures and literal
legacy/v1 digest vectors protect this rollout path.

Confirmed receipts are a ten-minute cache. Hot-path pruning runs at most once per
minute per project/process; each DELETE removes at most 5000 receipts. Fresh claims
reuse their RETURNING receipts; bulk confirmation uses four typed arrays instead
of four bind parameters per event. UTC strings keep session timezone independent.
Only competing identities and pause rechecks need a subsequent receipt read.
Fresh claims retain the same CAS/skipDuplicates arbitration. Ordinary
pruning and retention never remove unresolved receipts. Only exclusive recovery
can settle or remove an unresolved receipt.

## Identity index and online migrations

Migration 006 creates the additive `event_ids` table and attaches its MV BEFORE
INSERT SELECT backfill. Migration 007 replaces its ReplacingMergeTree engine with
plain MergeTree, preserving all surviving raw tuples, including legacy duplicate
ids. Its order is `(project_id,event_id,received_at,timestamp)`. Lookup orders by
received_at and timestamp with `LIMIT 1 BY event_id`, so overlapping backfills are
harmless and the oldest surviving row wins. Payload is fetched only for index
hits, with timestamp/id primary-key predicates and exact receipt-time pointers;
dangling pointers fall back to raw evidence per id. Recovery always checks raw
rows, including when a failed MV left no index entry. The ownership recheck is
skipped when the post-claim clock is less than half the receipt window after the
first lookup.

007 requires an Atomic ClickHouse database and one migration runner. Concurrent
writers are supported. The runner keys on the FULL filename in `migrations.name`,
without a checksum. It guards the following phases using durable table engines,
so restarting after any completed statement cannot swap the tables backwards:

1. Create `event_ids_v2` as plain MergeTree with the same columns and receipt-time
   hard TTL as events: +3650 days, clamped to the DateTime upper bound.
2. Attach `event_ids_v2_mv` before backfill; both MVs now receive new writes.
3. Backfill v2 from raw events.
4. Atomically `EXCHANGE TABLES event_ids AND event_ids_v2`.
5. Drop the TEMPORARY `event_ids_v2_mv SYNC`. ClickHouse TO targets bind by name:
   the original `event_ids_mv` now writes to the new stable `event_ids` table.
6. Drop the retired replacing table, now named `event_ids_v2`, with SYNC.
7. Insert missing raw `(project_id,event_id,received_at,timestamp)` tuples into the
   stable index. This idempotent coverage pass runs after the synchronous retire.

An INSERT SELECT can start before the second MV attaches and finish after the
backfill snapshot. Attaching the MV does not retroactively change that running
pipeline. Its old target must retire synchronously before the final coverage
pass, which catches those late rows. Tests cover a writer finishing between
backfill and exchange and one active through retirement, plus interruption after
each of the seven phases. No events-table mutation or writer drain is needed for
this schema migration. Retention and project deletion purge the index alongside
the four existing tables. Retention retries clean index rows even when a prior
attempt already removed the raw rows, rebuild surviving pointers and verify the
cutoff invariant before completion.

Migration 008 replaces the derived index online with smaller granules, using
`event_ids_v3` and its temporary MV. It repeats the same seven phases, detecting
the completed exchange by the persisted `index_granularity` setting because both
sides are MergeTree. Schema, stable names, oldest-receipt lookup and hard TTL stay
the same, so master and 007-only binaries remain compatible during rollout. The
backfill bounds block size and memory; the final late-writer coverage pass runs
adaptively sized id-hash buckets with matching predicates on raw/index tuples
and a 256 MiB per-query ceiling. Counts and estimated key bytes from both raw
and index tables choose a power of two: no more than 500,000 rows or 128 MiB
of estimated set storage per bucket (twice the serialized key bytes plus
128 bytes/row for hash-table/allocator overhead). Long
ids and overlapping physical index rows increase the bucket count. The measured
10M fixture uses 32 buckets; 100M ordinary-width rows require 256, rather than
reusing a fixed count. The same bounded final pass applies to 007 on fresh upgrades. Retrying any interrupted pass is safe. Runtime cutoff purges
use the same bounded repair, including when an earlier attempt already deleted
the expired raw/index rows. Each bucket still scans narrow history columns;
this trades cold reconciliation time for bounded set memory.

### Granularity experiment (10M derived pointers)

On the shared local ClickHouse, 20 measured batches plus three warmups per case,
with 1,000 ids per batch and a 50/50 UUIDv4/UUIDv7 history. Every miss sample uses
fresh ids, avoiding condition-cache reuse. These are native lookup timings, not
HTTP ingestion timings. Each table was merged to one part before lookups.

| Granularity | UUIDv4 miss rows | Read MiB | Median / p95 ms | UUIDv7 miss ms | Peak lookup MiB |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 8192 | 3,995,264 | 148.60 | 250 / 302 | 7 | 6.17 |
| 512 | 485,888 | 18.07 | 99 / 109 | 6 | 6.17 |
| 256 | 249,344 | 9.27 | 95 / 109 | 6 | 6.17 |
| 128 | 126,464 | 4.70 | 87 / 95 | 7 | 6.17 |
| 64 | 63,552 | 2.36 | 85 / 89 | 6 | 6.17 |

| Granularity | 10M table MiB | Build incl. initial merge s | 1k pointer INSERT median / p95 ms | Final merge after 20k inserts s |
| ---: | ---: | ---: | ---: | ---: |
| 8192 | 135.46 | 6.44 | 13.50 / 27.50 | 3.72 |
| 512 | 132.51 | 6.43 | 13.45 / 21.20 | 4.16 |
| 256 | 132.95 | 6.58 | 13.48 / 20.48 | 4.25 |
| 128 | 133.59 | 7.50 | 13.72 / 13.93 | 4.65 |
| 64 | 135.01 | 9.68 | 13.43 / 14.17 | 5.44 |

256 is selected: about 16 times fewer rows read for random misses, near-flat
storage, and modest merge cost. SDK/server ids use UUIDv7 and are the fast path.
Caller-chosen random ids amortize to about 0.1 ms/id in this 1,000-id lookup;
this is a batch cost, not single-id latency or a linear scaling guarantee.
Matched HTTP re-runs must record the load runner's id shape. Pointer INSERT
cost above excludes the raw event and other materialized-view destinations.

## Bounded ambiguous writes

INSERT uses max_execution_time=30 seconds, async_insert_busy_timeout_max_ms=1000,
wait_for_async_insert=1 and a 60-second claim lease/client deadline. The body checks
the lease when consumed, before transport handoff; an expired lease is not sent.
One lazily serialized JSONEachRow byte body avoids a row-by-row object transform
in the HTTP pipeline. The client socket budget is 60 seconds; the response stream
is consumed before confirmation. Server socket timeout 209 remains ambiguous
after handoff, even if that exception reports no written rows.
Failures proven to precede any write release this attempt's claims. This includes
before-body transport errors and an explicit server-code allowlist: parse codes
6,27,38,41,53,69,72 (422 invalid_event), and unknown table/database, syntax,
readonly, ACL/auth codes 60,62,81,164,497,516 (503 ingest_unavailable). A code wrapped
by an MV failure is ambiguous even if its underlying code is on that list.
All other errors after handoff retain the claim, including timeout 159, memory
limit 241, and client timeout/reset. A server exception can follow a committed
raw write or only some materialized destinations. Identity-read errors return
503 ingest_unavailable with Retry-After, including timeout and memory exhaustion.

An exact retry or hourly worker recovers per project after the lease plus a
conservative ten-second async flush bound. Candidate fingerprints are checked
before taking the exclusive lock or flushing. Recovery drains the async queue,
reads raw evidence, repairs the index and rebuilds every rollup before confirming
receipts. Stored evidence wins even when it differs from the abandoned claim:
the stored identity is confirmed and the conflicting retry is rejected. Missing
rows become ready (`claimedAt=null`) while preserving their fingerprint, receipt
clock and event clock. An exact retry takes them over and inserts under the same
exclusive lock. The worker cannot recreate a missing payload; receipts store none.
A ready receipt with no raw row is deleted after the original ten-minute receipt
grace period, under that lock. A failed flush or lookup releases nothing.

Only expired ambiguous claims trigger a rollup rebuild. Ready-only takeover and
grace-only cleanup skip it. Before the first destructive rollup DELETE, recovery
persists a `RetentionRun(kind=ingest_repair,status=running)` maintenance lease,
heartbeats it every 30 seconds and marks it complete only after every destination
is rebuilt, before replay. Reads return `503 retention_unavailable` with the neutral
message "Project data is being rebuilt". Failed or abandoned repairs remain read
fenced until a complete repair or retention rebuild succeeds. The existing abandoned
run path enqueues retention, whose rebuild completes the outstanding repair records.
Settings lastRun includes only kind=retention. Sample removal uses the same repair
fence. Workspace activity reads raw rows only, so its unused rollups need no Project
read fence; its writes remain serialized by the workspace advisory lock.

A flush or rebuild failure is logged as `ingest.recovery_failed`. The request then
falls through to shared ingestion: unresolved ids stay pending and healthy siblings
commit. Writes may continue while an ingest repair's reads are fenced; an active
exclusive repair still excludes writers. Regular live retention continues to fence
writes. Worker startup probes the flush grant and logs an actionable error on failure.

Global SYSTEM FLUSH attempts, including failures, are throttled to once per minute
per server/worker process. Successful proof is reused only for leases it covers.
This implementation assumes a single ClickHouse node: queues on other nodes are
not drained by a local SYSTEM command. The writer/recovery principal needs
`SYSTEM FLUSH ASYNC INSERT QUEUE` privilege (for example `GRANT SYSTEM FLUSH ASYNC
INSERT QUEUE ON *.* TO <writer>`), plus its existing SELECT/INSERT/DELETE and
migration DDL privileges. Distributed ClickHouse requires a coordinated per-node
drain before adopting this guarantee. `scripts/reconcile-ingest.ts PROJECT` runs
the same per-project operator recovery.

Healthy siblings commit before 503 ingest_pending. Its details are a superset of
the 202 response: `{accepted,ids,rejected,warnings,indices,eventIds}`. Each rejected
entry includes `code` and a code-first explanatory `reason`. Every input index
outside `indices` is settled, including permanent rejections; retrying the entire
identical batch is safe. Retry-After reflects the longest remaining pending lease
plus flush bound. Ready receipts report the remaining ten-minute grace, and
throttled flushes report the remaining minute, with a one-second minimum. A different-content retry against
an unresolved claimant stays pending until the original outcome is known. The
SDK retries the identical body and honors Retry-After. Permanent conflicts reach
onDrop/onError; a structured SDK LogbirdError class is tracked in [#89](https://github.com/joodlab/logbird/issues/89).

## Sample and retention lifecycle

New sample ids include a random run prefix and still use receipt arbitration.
Removal takes the exclusive lock, drains expired claims and refuses live pending
leases. After deleting only sample raw rows, it checks every affected id against
surviving raw evidence. It repairs customer pointers and receipts when a customer
row survives, including old fixed sample-event-N collisions. Index and receipt
entries are removed only for ids with no surviving raw row. Rollups are rebuilt.

Known sample-removal interruption window: process death after raw deletion but
before confirmed-receipt cleanup can leave a cache receipt falsely acknowledging
an exact retry of a removed sample. The entry disappears after the ten-minute
cache window (plus up to one minute of hot-prune throttling). This accepted narrow
window avoids a durable sample-deletion journal; it cannot overwrite surviving customer evidence. Ordinary retention
removes only confirmed receipts. Project deletion purges all receipts after the
locked ClickHouse purge; organization deletion also handles ws: audit streams.

## Deployment, rollback and proof limits

Run pnpm db:deploy, pnpm db:generate and pnpm ch:migrate before new writer/worker
binaries. Back up receipt state first. Migration 20261107140000_ingest_claim_lease
adds nullable claimedAt and its index; the later 20261107160000_ingest_utc_lease
corrects the default and conservatively refreshes only unresolved non-null leases
using CURRENT_TIMESTAMP AT TIME ZONE 'UTC'. Original receipt/event clocks and the
already-applied migration checksum stay unchanged. A Pacific/Auckland session
regression verifies the correction. Never use migrate dev, reset or db push on a
shared DB. Stop old writer binaries before enabling the immutable runtime contract;
old binaries and direct ClickHouse inserts bypass the Postgres fences.

Rollback requires stopping new writers and preserving unresolved receipt state.
Leaving the additive schema in place is safest. To remove the identity additions
only, use the following against the verified databases. Replace `logbird` with your
`CLICKHOUSE_DATABASE`. Temporary MV names are included
so this also handles interrupted 007/008 upgrades. Raw events and original rollups survive.
Do not remove the receipt table or its migration while pending writes exist.

```sql
-- ClickHouse: after stopping writers and the migration runner.
DROP VIEW IF EXISTS logbird.event_ids_v3_mv SYNC;
DROP VIEW IF EXISTS logbird.event_ids_v2_mv SYNC;
DROP VIEW IF EXISTS logbird.event_ids_mv SYNC;
DROP TABLE IF EXISTS logbird.event_ids_v3 SYNC;
DROP TABLE IF EXISTS logbird.event_ids_v2 SYNC;
DROP TABLE IF EXISTS logbird.event_ids SYNC;
ALTER TABLE logbird.migrations DELETE WHERE name IN
  ('006_event_ids.sql','007_event_ids_merge_tree.sql','008_event_ids_granularity.sql') SETTINGS mutations_sync=2;

-- Postgres: retain IngestReceipt and its original migration.
BEGIN;
-- Only after all maintenance has completed and its durable state is preserved.
ALTER TABLE "Project" DROP COLUMN "maintenanceGeneration";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261107180000_maintenance_generation';
ALTER TABLE "RetentionRun" DROP CONSTRAINT IF EXISTS "RetentionRun_kind_check";
ALTER TABLE "RetentionRun" DROP COLUMN "kind";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261107170000_ingest_repair_kind';
DROP INDEX IF EXISTS "IngestReceipt_projectId_confirmedAt_claimedAt_idx";
ALTER TABLE "IngestReceipt" DROP COLUMN "claimedAt";
DELETE FROM "_prisma_migrations" WHERE migration_name IN
  ('20261107140000_ingest_claim_lease','20261107160000_ingest_utc_lease');
COMMIT;
```

To roll back only 008, keep its schema in place: 007-only binaries read the same
columns and stable names. Smaller granules require no binary rollback. If reverting
the physical layout is necessary, run the same dual-MV/backfill/exchange/retire
procedure with a fresh temporary table at the prior granularity; changing a setting
alone does not rewrite existing parts. Never replay EXCHANGE blindly or remove
008 from the ledger while its smaller-granule table is still installed.

The UTC correction alone may safely remain deployed; do not restore shifted
leases. Recheck origin/master's migration filenames immediately before merging
and coordinate ledger renames for any already-applied migration that is renumbered.
Shared-dev orphan index cleanup is an operator-owned one-off, outside this PR.
The shipped reconciliation command accepts one project id only.

Search/export return the row that passed the filter; detail chooses the oldest
surviving receipt. Historical non-canonical rows can still match filters. This
change cannot restore overwritten originals or globally canonicalize historical
cursor pages. Search selects a bounded page of narrow (timestamp,event_id,received_at)
pointers, then fetches only those exact wide rows. ASC/DESC event-time ordering
comes first; the earliest receipt breaks ties at a timestamp. Filters and cursor
boundaries apply before page-local id deduplication. A legacy id at another
timestamp can therefore recur on a later page; new immutable writes cannot create
that case. Detail independently chooses the oldest surviving receipt across timestamps.
The >=10M retained-history benchmark and 1M receipt bytes remain a
separately scheduled acceptance gate. The script shipped separately in PR #79;
run it at the final clean PR head under heavy and logbird-stack with the approved
cloud fixture and fourth argument `immutable`. Small real-service proofs are not
10M/day capacity evidence.

Other scoped follow-ups: [#90](https://github.com/joodlab/logbird/issues/90) covers
the shared ingest/recovery dependency boundary, and
[#91](https://github.com/joodlab/logbird/issues/91) covers per-event isolation of a
definite storage parse failure. Neither changes ambiguity classification here.

Removal of pre-merge compatibility after safe shared-DB reconciliation is tracked
in [#94](https://github.com/joodlab/logbird/issues/94).

Rollup read admission also uses `Project.maintenanceGeneration` (additive migration
20261107180000_maintenance_generation). Repair and destructive retention increment
it atomically with their running fence before ClickHouse deletes. A short PG
statement reads both generation and fence before and after each affected response.
If a repair overlaps either query, even if it completes before the second check,
the response is discarded with 503. No read holds a project lock or a PG connection
during ClickHouse I/O. Raw events remain non-snapshot reads; they are not emptied
by a rollup rebuild. Deploy the additive column before new server/worker binaries.

After a failed ingest repair, its queued retention job (or the hourly sweep) owns
the retry. Matching HTTP retries check the durable failed record before the lock
and again after acquiring it; they preserve pending ids and store healthy siblings
without repeating the history rebuild. Retry-After is 60 seconds while that worker
repair remains outstanding. This is a polling interval, not a settlement deadline;
reads stay fenced until the worker succeeds. Ordinary lock contention is not logged
as ingest.recovery_failed.
