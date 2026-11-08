# Immutable event ids

An id names one immutable event within a project, across all timestamps and
partitions. Public ingest, workspace audit writes and sample generation share the
receipt lifecycle. See [Event ids and retries](concepts.md#event-ids-and-retries).

## Coordination and identity

Shared project advisory locks permit concurrent API processes. The Postgres unique
key on `IngestReceipt(projectId,eventId)` arbitrates ownership. Claims are inserted
in sorted order with a typed-array UNNEST INSERT, ON CONFLICT DO NOTHING and RETURNING.
Explicit UTC encoding preserves session independence.
No Postgres transaction spans ClickHouse I/O. Maintenance and recovery take the
exclusive project lock, including any recovered INSERT.

`v1:` fingerprints hash recursively key-sorted parsed INPUT plus the resolved UTC
timestamp. Array order, string contents and values beyond every indexing cap
participate. Omitted or invalid occurredAt keeps the first receipt clock. SDK
headers do not participate. Search normalization and today's admission rules must
never redefine stored identity. Stored v1 identity uses the original payload and
stored timestamp directly. One malformed legacy payload is rejected individually
as `stored_event_unreadable`; it cannot block healthy siblings or free its id.
Early development deployments may contain unprefixed receipts; ordinary released
deployments do not require this compatibility path. Unprefixed pending receipts
retain the old normalized-column comparison until stored evidence or reinsertion
upgrades them. Frozen legacy fixtures and literal legacy/v1 digest vectors protect
this compatibility path.

Confirmed receipts are authoritative for ten minutes. The window is measured on
each process's own clock: the API compares `confirmedAt` with its clock, and the
worker sweep with the worker's. Clock skew between them makes receipts expire
early (or late) by the skew. That is harmless: an expired receipt is never
authoritative, so the request falls back to the ClickHouse identity lookup. A
request that pauses for more than half the window rechecks storage and re-applies
the window when it reloads receipts. A receipt that expired during the pause is not
trusted; its id is reported pending and an exact retry resolves it. After reading the requested
ids, ingest expires only those with an old non-null `confirmedAt`, in one guarded
DELETE. Public batches contain at most 1000 ids; the helper rejects more than
5000 rather than looping. Fresh ids execute no cleanup SQL, even when unrelated
expired receipts remain. The subsequent index/raw lookup preserves surviving
identity and the first receipt clock. A sample-removal crash cache cannot remain
authoritative past its ten-minute window. Fresh claims
reuse their RETURNING receipts; bulk confirmation uses four typed arrays instead
of four bind parameters per event. UTC strings keep session timezone independent.
Only competing identities and pause rechecks need a subsequent receipt read.
Receipt reads seek to `("projectId","eventId") >= (project,id)` in primary-key
order with `LIMIT 1`, then check the exact project and event id outside the limit.
The limit keeps the equality filter from being pushed into the seek.

Confirmation and expiry are compare-and-set statements. An unlocked seek first finds
the exact key and its tuple id (`ctid`); a missing key's successor, including
another project's row, is never locked or changed. The statement then locks that
tuple with `FOR UPDATE`, re-checking the ctid and exact key (and, for expiry, the
cutoff). The UPDATE/DELETE itself matches on `ctid` only: it does not repeat the
project/id predicates, and it cannot miss a tuple the statement holds locked. The
gap is between seek and lock: a concurrent writer that updated the row moved it
to a new ctid, so READ COMMITTED's recheck drops it. Each statement therefore
returns how many keys it found, how many it changed and which ids it lost. Lost
ids are sought again against the current version, up to three attempts. A renewed
receipt drops out of the expiry re-seek because it no longer matches the cutoff;
a concurrently changed receipt is confirmed with the requested identity. Counts
that do not add up, or a conflict that persists for three attempts, raise
`IngestReceiptConflictError` (a retryable 503 on the request path). Nothing on
today's request path writes the same receipt concurrently, so a retry is an
anomaly, not a normal branch.

Plan choice must not depend on table statistics. Two separate fixtures back this,
and they test different things:

- **The shipped ordered seek under stale statistics:** the 33a0553 equality probe
  regressed on a fresh project over real HTTP. An unchanged diagnostic run of 300
  batches reproduced it (p95 1686.7 ms, max 3067.6 ms; one batch took 1373 ms in
  prior lookup and 1494 ms in confirmation, against about 90 ms in ClickHouse).
  Captured plans used the project/confirmedAt index until auto-ANALYZE refreshed
  statistics. Queries were unnamed, pool waits were negligible, and the slow
  statements were active without lock waits. The fixed 88f6e29 code repeated the
  same fresh-project run: 300 × 1000 UUIDv4 events, p50/p95/p99 315/384/425 ms,
  max 451 ms, every captured plan on the primary key. **This is the evidence for
  the shipped SQL.**
- **Before and after ANALYZE:** an owned 20000-row stale fixture showed the old
  equality probe filtering 19999 rows per id (1.256 s for 1000 hits) against
  4.2 ms for the ordered seek. On a separate fixture, all three helpers planned on
  the primary key before and after ANALYZE (lookup/confirm/expiry about 8/23/10 ms
  before, 9/22/11 ms after). The old query also used the primary key on that
  fixture, so this proves the helpers are stable across ANALYZE there, not that
  they survive the stale-statistics regression above.

A bloated, nearly empty table defeats the ordered seek without a guard. After a large
backlog is deleted or rolled back, autovacuum records few live rows while the heap
and index pages remain. The planner can price a sequential scan plus sort per id below the primary-key
seek, and its inflated cost can also enable JIT. Prior lookup, confirmation and targeted
expiry therefore run in a short transaction that first sets `enable_seqscan`,
`enable_bitmapscan`, `enable_sort`, `enable_incremental_sort` and `jit` off with
transaction-local `set_config(..., true)`. Every alternative plan (a sequential,
bitmap or secondary-index scan plus a sort or incremental sort per id) then
contains an extra disabled node. The primary-key seek has the fewest: none beyond the
input-id sort that every plan shares. The settings are transaction-local and revert at
COMMIT or ROLLBACK. The cost is one extra statement and three extra round trips per
probe (BEGIN, guard and COMMIT around the original statement); a fresh batch's lookup
plus confirmation adds six. Confirmation and expiry also hold their row locks for one
more round trip, until COMMIT. The local timings in #111 do not measure a remote
database's round-trip time. The transaction is bounded at 60 seconds for both the
connection wait and execution (`RECEIPT_PROBE_TRANSACTION`), not Prisma's 2 s/5 s
batch defaults. These were unbounded plain statements before. A confirmation after an
acknowledged ClickHouse write mostly waits on a saturated connection pool, or runs
slowly for a large batch. The sweep never locks unconfirmed claims; its row
contention applies to targeted expiry. Rolling such a confirmation back would report
a stored write as failed and force recovery, so the bound is generous: 60 seconds,
the same order as the ingest ClickHouse socket budget. A late confirmation stays
safe because the request still holds the shared project lock, and recovery needs the
exclusive one.
Minute-sweep batches use the same guard plus their five-second timeout, so they walk
a `confirmedAt`-ordered index. The `receipt-plan-guard` real-PG test plans the
shipped SQL against an owned temp table that shadows `IngestReceipt` with fresh,
large, stale and bloated (800k deleted, 5 kept) statistics. It also proves the bloated
fixture abandons the seek when unguarded. The replacement depends on exact page
counts: a secondary-index, bitmap or sequential scan plus a sort for every id.
Fresh claims retain the same CAS/skipDuplicates arbitration. Ordinary
pruning and retention never remove unresolved receipts. Only exclusive recovery
can settle or remove an unresolved receipt.

A separate `ingest-receipts` BullMQ queue runs every minute with global concurrency
one, independently of long ClickHouse retention jobs. Each worker batch deletes
at most 5000 rows with `FOR UPDATE SKIP LOCKED`, yields 10 ms, and stops after a
20-second work budget. Each batch has a five-second SQL timeout and a one-second lock
timeout inside a six-second transaction with a one-second connection-wait limit,
so the last in-flight batch can extend the work budget. Tuple ids are used only inside the
row-locked DELETE statement, never as persistent event identity. Worker batches
use the same transaction-local `set_config(..., true)` guard as the probes
(`SWEEP_GUARD`: sequential scans, bitmaps, sorts, incremental sorts and JIT off).
Stale or bloated estimates must not turn the ordered LIMIT into a scan of the whole
history plus a sort. The existing `(projectId, confirmedAt)` and global
`confirmedAt` indexes serve the expiry scans; settings revert at commit. The hourly
global and per-project retention backstop runs the same guarded batches with a
60-second budget instead of an unguarded loop. A stale estimate during a minute-queue
outage can no longer stall retention behind it. A backstop that removes rows logs
`ingest.receipts_pruned` with `scope: backstop`, and at `warn` when its budget left
expired rows behind.

Capacity depends on aggregate expiry across all projects. At 5000 receipts/second,
ten live minutes contain about three million confirmed receipts. With on-time
minute scheduling and more than 15000 deletions/second during the 20-second budget,
cleanup capacity exceeds 300000 arrivals/minute. A conservative healthy bound is
about 450000 expired receipts (90 seconds of arrivals, allowing the final batch),
plus the live cache. These bounds cover confirmed receipts, not unresolved writes.
This is a logical-row bound, not a disk quota: autovacuum,
index bloat and WAL also need monitoring. Repeated `limited` sweep logs or queue
lag mean that capacity/scheduling assumption is failing. During a worker outage
there is no hard backlog bound: 5000/second adds about 300000 expired rows/minute;
targeted request cleanup only helps ids being retried. If only the minute queue
fails, a healthy on-time hourly backstop can still leave about 18 million expired
receipts between sweeps. Restore worker health rather than relying on that
degraded mode.

### Expired-backlog re-measure (#110)

This in-process run used owned fictional projects on the shared development
services, under the `heavy` lock, on 2026-11-08. It is not HTTP acceptance.
Each project carried 600,000 confirmed receipts, aged past the window as in the
#62 probe. Fresh batches were 1000 events through the shipped
`insertImmutableEvents` path (receipts and ClickHouse). Statement-level runs
compared #62's SQL as merged (unguarded) with this code. The shared table started
bloated: 31 live rows, a 14,364-page heap and a 137,302-page (about 1.07 GB)
primary key, against 128 MB of `shared_buffers`.

| State | #62 SQL (unguarded) | This code |
| --- | --- | --- |
| No backlog, bloated table | lookup p95 6181 ms, Postgres total p95 11.6 s | lookup p95 15 ms; batch p50/p95 269/373 ms |
| First batch after aging | lookup 215 ms (1923 shared reads) | lookup 219 ms (2121 reads); **first batch 469 ms** |
| 30 steady batches with the backlog | Postgres total p95 439 ms | Postgres total p95 413 ms; batch p50/p95 319/1316 ms |
| Batches during the sweep (666,000 removed in 18.1 s, 134 batches, not limited) | — | batch p50/p95 653/846 ms (29 samples) |
| After the drain and ANALYZE | lookup p95 1009 ms (5 samples) | batch p50/p95 269/315 ms |

Every guarded plan was the primary-key seek, with no JIT and at most 1.6 ms
planning. The first fresh batch now stays below one second. The remaining
backlog cost is buffer I/O, not plan choice, planning or a missing index. Each
fresh lookup reads about 2000–7400 primary-key and heap pages that do not fit in
`shared_buffers`, because this bloated index is about eight times its size. On
this machine, the steady and during-sweep p95 therefore stay above twice the
matched baseline (242 ms), and #110's latency gate remains open. The run shares a
busy machine, so the steady p95 includes outliers.

VACUUM recycles empty index pages but never shrinks a B-tree below its high-water
mark. Random-UUID leaf pages left half empty by a drained backlog stay in the index,
so only a rebuild restores a compact primary key. The hourly worker job therefore
runs `compactIngestReceiptIndex`:

- It runs only in the worker's hourly `retention.enforce` job. A unit test fails if
  any API server source references it, so it never runs on the ingest path.
- It is single-flight across workers through a session advisory try-lock, and uses
  its own connection, because `REINDEX CONCURRENTLY` cannot run inside a transaction
  or a pooled Prisma call.
- It estimates the pages the live entries need from `reltuples` and the analyzed key
  widths, at a 90% leaf fill. It rebuilds with `REINDEX INDEX CONCURRENTLY
  "IngestReceipt_pkey"` only when the index is at least 64 MiB **and** at least
  three times that estimate. Otherwise it does nothing. The threshold comes from the
  experiment below: steady churn stays under 2×, and a drained backlog leaves
  about 4×.
- The rebuild is online: reads and writes continue, and the new index is swapped
  in at the end. It is bounded by a 15-minute statement timeout and a one-minute
  lock timeout.
- An interrupted rebuild's invalid `_ccnew`/`_ccold` copy is dropped concurrently,
  both before each run and after a failure.
- It logs `ingest.receipt_index_compaction` with page counts, ratio and duration
  when it rebuilds or is busy, and `ingest.receipt_index_compaction_failed` with
  only an error code. A failure never fails the retention job.

A churn experiment backs both the job and its threshold. It used session-local temp
tables with the receipt schema, 200,000 live receipts, 150 one-minute churn cycles
of 4000 claims, confirmations and sweeps, then a 400,000-receipt backlog drained in
5000-row batches followed by 50 more cycles. Autovacuum's trigger was replayed as
explicit VACUUMs. The estimate (2713 pages) was within 3% of a fresh rebuild (2791
pages).

| Primary-key pages | Default autovacuum (25 runs) | Tuned per table (scale 0.01, 150 runs) |
| --- | ---: | ---: |
| Steady churn | 5317 (1.9×) | 4584 (1.6×) |
| After the drained backlog and churn | 10,911 (3.9×) | 10,944 (3.9×) |
| After REINDEX | 2791 | 2791 |

More aggressive per-table autovacuum gains about 14% at steady state and nothing
after a backlog. Default autovacuum already runs about once a minute under steady
churn, because each receipt leaves two dead tuples (confirmation and sweep) within
a window that holds ten minutes of inserts. No storage-parameter migration is
shipped; only a rebuild returns the index to its compact size.

Sizing: give `shared_buffers` room for the receipt primary key at the live window's
size. A healthy ten-minute window at 5000 events/second holds about three million
receipts, roughly 30,000 primary-key pages (about 250 MiB) when compact. Keep the
minute worker healthy so a backlog does not build up. Operators can still run the
same `REINDEX INDEX CONCURRENTLY` by hand.

A smaller real-service proof used 600000 live receipts, a 300000-row initial
expired backlog and 375000 receipts crossing expiry naturally at 5000/second over
75 seconds. A separate worker process drained 300139 rows in 1.930 seconds and
290210 in 1.880 seconds (154000–156000/second). Backlog rose between minute jobs
and drained again; it stayed below the one-minute arrival budget after the
initial drain. Two receipt workers never overlapped while a separate retention
job remained blocked. An isolated 675000-row burst control measured ingest p95
309 ms before, 302 ms during cleanup and 308 ms after. The natural-expiry run's
active/idle p95 was 411/624 ms, with drifting before/after controls (288/802 ms),
so that run does not establish a precise latency ratio. Neither test performs
producer INSERTs during the measured window. These bounded shared-service
diagnostics demonstrate cleanup headroom, not a production throughput guarantee.
The natural-expiry process hit the shared-machine RAM floor during final cleanup;
its exact fixture was subsequently cleaned and checked separately. Earlier
interrupted and confounded attempts remain in the local evidence pack.

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
attempt already removed the raw rows, preserve surviving pointers and verify the
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
reusing a fixed count. The same bounded final pass applies to 007 on fresh upgrades.
These one-time upgrade passes restore every legacy tuple before new server/worker
startup. Subsequent plain MergeTree pointers are MV-maintained, so runtime cutoff
purges delete matching raw/index tuples without scanning retained history to
rebuild pointers. A retry still deletes expired pointers if raw cleanup finished
earlier, and verifies the cutoff invariant. Legacy replacing-index collapse is
repaired during upgrade, rather than during every exclusive retention lock.

Migration and cold-maintenance clients have a 15-minute socket-idle timeout and
progress headers (every 30 seconds), separate from the ten-minute per-statement server
budget. `CLICKHOUSE_MAINTENANCE_MAX_EXECUTION_SECONDS` can raise that budget for
very large histories; see [upgrade copy limits](self-hosting.md#upgrade-copy-limits)
for measured copy and coverage-pass scaling. The normal
60-second socket-idle timeout applies to all client operations, not just inserts.
Before the atomic exchange, resuming an interrupted copy synchronously retires
the temporary MV/table and creates a fresh table UUID before repeating the full
copy. A timed-out server query can still own its old table UUID, but cannot append
another copy to the new target. After exchange, persisted engine/granularity state
resumes only the remaining retirement/coverage phases. Allow temporary disk space
for a second index and enough time to repeat a failed full copy on a large install.

### Granularity experiment (10M derived pointers)

On local ClickHouse, 20 measured batches plus three warmups per case,
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

### Multiple active parts (009)

The single-part figures above understate random-id misses during active ingest:
each part adds candidate granules. A five-part, 10M UUIDv4 fixture reproduced
1.21M rows / 47.0 MB / 169 ms for 1,000 fresh misses. Tested bloom granularities
16, 64 and 256 reduced that to about 0.11M rows / 4.1–4.5 MB and 93, 73 and 67 ms.
009 adds `idx_event_ids_bloom`, `bloom_filter(0.0001) GRANULARITY 256`, while keeping
the primary key and 256-row granules. The primary index prunes first; the bloom
index then avoids decoding absent ids in candidate parts.

A separate same-layout test used five parts, 10M mixed UUIDv4/UUIDv7 pointers,
two warmups and eight measured fresh 1,000-id batches per case, with condition
cache disabled. Enabling the bloom index changed UUIDv4 median server time
128 → 50 ms, rows 1,132,544 → 115,456 and bytes 44.17 → 4.50 MB. UUIDv7 stayed
at 8 ms (1,280 → typically 0–512 rows). Peak lookup memory stayed below 7 MB.
The index files used 23.85 MB, about 9.9% of the 241.57 MB unindexed mixed-history
table. Native 1k four-column source + pointer-MV inserts measured 15.26 → 15.64 ms;
these exclude full raw events and the other materialized destinations. Part count, id shape and compression
matter; these diagnostics are not the matched HTTP acceptance benchmark.

009 adds the skip index online and materializes its files on existing parts.
`MATERIALIZE INDEX` runs as a ClickHouse mutation proportional to `event_ids`
size; it is not a constant-time metadata operation. The 10M online fixture's
initial materialization took 604 ms. Larger or busier installations take longer;
the maintenance migrate client's long timeout and progress headers above cover
the wait. Inspect `system.mutations` for completion before treating the upgrade
as finished. A retry may rematerialize the same files without appending rows.
The shared-development apply over 12,114,298 logical pointers took 2.438 seconds;
its largest recorded mutation-part peak was 7.89 MB. All 222 projects' raw/pointer
counts and receipt digests were identical before and after. These measurements
include that installation's part layout and are not universal duration bounds.
It does not change table names, columns, MVs, TTL or logical rows; master-era and
007/008 binaries remain compatible. A 10M fixture accepted 200k concurrent writes
and a delayed 100-row writer across attach. Repeating materialization preserved
raw/pointer counts and checksums, and positive lookups remained complete. Query
cost still grows with many small active parts: the online test intentionally
disabled merges and ended with 216 parts; its post-write timings must not be
compared to the five-part baseline. Normal background merging remains important.

Runtime retention/project purges use lightweight DELETE. In a controlled 10M-row
comparison with five Wide history parts, retention part-processing time was
538 ms without the bloom index and 503 ms with it, with no bloom recalculation:
the history index files were reused. Small affected Compact parts can recalculate
their index; six tiny-project deletes totalled 769 microseconds of bloom work.
Physical ALTER DELETE rewrites and merges pay the index-build cost. Deleting
about 1% of surviving rows across the same 10M history physically took
2.283 seconds without bloom and 2.741 seconds with it (+458 ms, about 20%),
including 324 ms of bloom calculation. These are one layout's measurements;
wall-clock scheduling varied between repeats, while lightweight part work stayed
comparable. Measure physical maintenance separately from lightweight retention.

To roll back application code, leave 009 in place. To remove only this index,
first wait for its `MATERIALIZE INDEX` mutations to finish (`system.mutations`),
then run the following, substituting `CLICKHOUSE_DATABASE` for `logbird`:

```sql
ALTER TABLE logbird.event_ids DROP INDEX IF EXISTS idx_event_ids_bloom;
ALTER TABLE logbird.migrations DELETE WHERE name='009_event_ids_bloom.sql'
SETTINGS mutations_sync=2;
```

No event or receipt rows are deleted by this rollback. A retry of 009 can
rematerialize index files; it cannot append duplicate history rows.

### Receipt/CPU and retention diagnostics

A direct-ingest UUIDv7 diagnostic using the load runner's event generator
(five warmups and 20 fresh 1k batches, separate fictional project) measured
329 ms median / 369 ms p95 initially. Typed-array claims reduced claim time
90 → 35 ms; reusing validated fresh rows and per-attempt fingerprints reduced
the total to 246 ms / 295 ms, CPU median 171 → 62 ms. Retried/legacy rows still
resolve against the original receipt clock. Confirmation remains after ClickHouse
acknowledgement; recovery and claim observations remain separate across lock phases.

On an owned 10M narrow-column fixture with response defaults added as metadata,
the repeated pointer repair held the exclusive retention lock for 74.11 seconds.
Relying on one-time upgrade coverage reduced it to 1.71 seconds, 660.07M → 16k
rows read and peak query memory 117.66 → 4.39 MB. Both retained exactly 10M raw
rows and pointers. Target/tenant page queries using the narrow pair selector
read the same row counts as baseline; EXPLAIN showed an in-order read with bounded
receipt tie sorting. These synthetic diagnostics do not replace the final HTTP
read/ingest matrix against the scheduled retained cohort.

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
That same retention job also settles the abandoned receipts, so one failure costs
at most one more full rebuild. While it holds the exclusive lock, before rebuilding,
it proves that the abandoned claims' async writes are flushed. Its rebuild then
covers them, and it confirms stored ids, readies missing ones for an exact replay
and deletes obsolete ready receipts, exactly as request recovery does. A retry that
was waiting for the lock finds nothing abandoned and does not rebuild again. If the
flush throttle refuses proof, or settlement fails after the read model is
consistent, the receipts wait for the next retry or hourly sweep, as before.
Recovery re-checks for a failed repair after acquiring the exclusive lock. A
repair that fails while another request waits for the lock therefore wins: the
waiter returns without rebuilding, and retention owns the recovery.

Settings lastRun includes only kind=retention, and the retention status endpoint
is itself read-fenced. Failed repairs are therefore surfaced in `/readyz` as
non-failing details: `maintenance.failedIngestRepairs` reports `fencedProjects`
(projects with a failed `ingest_repair`) and `oldestFailedAt`. Readiness is
unauthenticated, so it reports counts only and never names a project. It is cached
for 30 seconds per API process because RetentionRun history is never pruned. A
non-zero count means some project's reads return `503 retention_unavailable` until
retention completes the repair. To list those projects, operators query
`SELECT "projectId", max("startedAt") FROM "RetentionRun" WHERE kind='ingest_repair'
AND status='failed' GROUP BY 1`. The `RetentionRun (projectId, kind, status)` index
serves the per-project failed-repair checks, read fences and retention counts. Sample removal uses the same repair
fence. Workspace activity reads raw rows only, so its unused rollups need no Project
read fence; its writes remain serialized by the workspace advisory lock.

A flush or rebuild failure is logged as `ingest.recovery_failed`. The request then
falls through to shared ingestion: unresolved ids stay pending and healthy siblings
commit. Writes may continue while an ingest repair's reads are fenced; an active
exclusive repair still excludes writers. Regular live retention continues to fence
writes. Worker startup probes the flush grant and logs an actionable error on failure.

Recovery that starts inside an ingest request holds the project's EXCLUSIVE lock for
its whole duration, using the long-timeout maintenance ClickHouse client. A large
rebuild can therefore hold the lock for up to the ten-minute server budget (or a
raised `CLICKHOUSE_MAINTENANCE_MAX_EXECUTION_SECONDS`) per statement. Meanwhile,
other ingest and maintenance for that project returns `503` with Retry-After
(`project_busy`) after its three-second lock wait. Other projects are unaffected.
Only an exact retry of an expired ambiguous claim, the hourly worker and the
operator script enter this path.

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
  ('006_event_ids.sql','007_event_ids_merge_tree.sql','008_event_ids_granularity.sql','009_event_ids_bloom.sql') SETTINGS mutations_sync=2;

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
leases. Check migration filenames against the deployed inventory before upgrading,
and coordinate ledger renames for any already-applied migration that is renumbered.
Orphan index cleanup requires a separate, scoped reconciliation procedure.
The shipped reconciliation command accepts one project id only.

Search/export return the row that passed the filter; detail chooses the oldest
surviving receipt. Historical non-canonical rows can still match filters. This
change cannot restore overwritten originals or globally canonicalize historical
cursor pages. Search selects a bounded page of narrow (timestamp,event_id)
keys in storage order, then fetches only those matching wide rows and reapplies
the same filters: even a complete legacy pointer tuple need not be unique.
ASC/DESC event-time ordering
comes first; the earliest receipt breaks ties at a timestamp. Filters and cursor
boundaries apply before page-local id deduplication. A legacy id at another
timestamp can therefore recur on a later page; new immutable writes cannot create
that case. Detail independently chooses the oldest surviving receipt across timestamps.
The >=10M retained-history benchmark and 1M receipt bytes remain a
separately scheduled acceptance gate. Run `scripts/benchmark-ingest-identity.ts` against isolated fictional fixtures
with the fourth argument `immutable`, under a documented memory and concurrency budget. Small real-service proofs are not
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
