# Immutable event ids

An event id names one normalized event within one project, across all timestamps
and partitions. New writes, workspace audit writes and exact retries use the same
ingestion path. The response contract is unchanged: conflicting indices use the
existing string `rejected[].reason`, with `duplicate_id_conflict`.

## Coordination and storage

The existing shared project advisory lock excludes retention/deletion. A Postgres
unique key on `IngestReceipt(projectId,eventId)` then arbitrates concurrent ingest
processes. The first candidate in a batch wins; repeated identical indices are
accepted but inserted once. A bulk `INSERT ... ON CONFLICT DO NOTHING RETURNING`
claims up to 1000 ids, in stable order to avoid deadlocks across overlapping batches.
No application mutex, Redis lease, Postgres transaction across ClickHouse, or `FINAL`
is involved. Dragonfly loss or restart cannot release an in-flight identity.

The fingerprint is SHA-256 of normalized columns with sorted object keys, excluding
raw payload formatting, received_at and transport SDK. Comparisons normalize against
the original receive clock, so retries without occurredAt (or with rejected occurredAt)
do not invent a new event time. Explicit occurredAt still participates in identity.

Confirmed receipts expire after ten minutes. Active projects prune on ingest;
the hourly worker sweep prunes idle projects and workspace streams. New/older ids
are checked against ClickHouse's project/event-id bloom index across all time, then
checked again after ownership is acquired (a process can pause before claiming).
The second check closes the race with another confirmed receipt expiring during a pause.
For legacy rows, the oldest surviving receipt time seeds identity. A hit avoids every
raw INSERT, so the insert-triggered minute, entity and attribute materialized views
do not run again. A healthy source insert creates one rollup contribution.

The ten-minute window bounds the active receipt working set, rather than creating
10 million permanent Postgres rows per day. At a uniform 10M/day, ten minutes is
approximately 69,445 ids; an idle stream can retain its last window until the hourly
sweep. Unresolved claims are additional and require monitoring/reconciliation.
Postgres still receives one short-lived row per fresh id: the window reduces live
size, not write amplification. Operators must provision WAL/autovacuum and benchmark
the ClickHouse lookup against their retained history. Local measurements are recorded
in the PR; they do not establish a production 10M/day capacity result.

## Failed or uncertain writes

Deterministic ClickHouse parse/type errors (codes 6, 27, 38, 41, 53, 69, 72) retain
the existing `422 invalid_event` behavior and release only this attempt's pending
claims. They are permanent SDK errors, not an unresolved write requiring retries.

The receipt is pending before ClickHouse I/O and confirmed only after ClickHouse's
`wait_for_async_insert=1` acknowledgement. A storage acknowledgement failure, or an
exact retry while the earlier row is absent, returns `503 ingest_pending` with
`Retry-After: 1`. This is retryable, not a per-event permanent rejection. The SDK
retains/retries the same ids/body under its existing 5xx policy; callers that exhaust
automatic retries can retry flush. Already inserted batch members remain idempotent.

If ClickHouse accepted the row but Postgres confirmation or the HTTP response failed,
the next exact retry sees the row and confirms the claim without inserting again.
If no row exists after a failed/abandoned attempt, an automatic timeout cannot prove
that a delayed async insert will never arrive. Pending claims therefore fail closed.
They contain a digest and times, never a duplicate payload. Pending conflicts use
`duplicate_id_conflict`; exact retries are never mislabeled as conflicts.

To reconcile one project:

1. Run `node --env-file=.env --import tsx scripts/reconcile-ingest.ts PROJECT`.
   This confirms matching stored rows and reports counts of missing/conflicting rows.
2. For missing rows, stop **all** writers (every API replica, worker and seed/import
   process), drain ClickHouse's async insert queue, and verify no relevant INSERT is
   still running. Wait for outstanding client/server request budgets to settle.
3. Only then run the command with `--release-missing-writers-stopped`. The flag is an
   operator attestation; the tool cannot verify all replicas are stopped. It removes
   missing claims under the exclusive project lock, allowing the original batch to
   retry successfully. It never removes stored events or mismatching claims.
4. Restart writers and retry the identical batch. Investigate conflicting storage
   separately; do not clear claims to make an overwrite succeed.

Retention removes receipt rows with eventAt before the same cutoff, after the raw
purge succeeds under the exclusive project lock. Project deletion calls the shared
purge wrapper, deleting all its claims after ClickHouse. Organization deletion also
cascades receipts for both projects and `ws:` activity; the queued workspace deletion
design requires the same locked purge before the final cascade. Failed purges keep
claims. Backups must keep Postgres receipts and ClickHouse evidence consistent.

## Deploying and historical limits

Run `pnpm db:deploy` and regenerate the Prisma client before starting the new code.
The migration only adds a table/indexes; it neither rewrites ClickHouse nor changes
existing event rows. Drain/stop all old ingest replicas during rollout: old binaries
bypass claims, so a mixed writer fleet cannot provide the guarantee.

Migration `20261107130000_ingest_receipts` sorts after master’s current last migration
`20261105120000_retention_lease`. Prisma records it on deploy; deploying the merged
tree to an already-migrated database is a no-op. Old binaries do not read this table,
so the additive schema is compatible with them (their old ingest semantics remain).
Never use `migrate dev` or reset against a shared database.

If this PR is rejected, first stop every binary that uses receipts and ensure no
pending claim is needed for in-flight recovery. Preserve a receipt-table backup if
the new code has handled real traffic. An operator can then run this targeted rollback
on the intended Postgres database, after verifying both the migration identity and
ownership of the new table:

```sql
BEGIN;
DROP TABLE "IngestReceipt";
DELETE FROM "_prisma_migrations"
WHERE migration_name = '20261107130000_ingest_receipts';
COMMIT;
```

Do not execute this while new writers are live. The rollback removes only the new
receipt table and its exact migration ledger entry; it does not touch ClickHouse or
other migration records. Old code continues to permit conflicting retries, so keep
untrusted ingestion disabled until an alternative integrity fix is deployed.

Search now selects the actual filtered row, rather than matching an identity in a
subquery and then returning any version of that identity. JSONL/CSV export uses that
same search path. Detail chooses the oldest surviving received_at. No table engine
migration is included: changing ReplacingMergeTree or its sort key requires a planned
data-preserving cutover and owner approval for shared tables. For a future table,
plain MergeTree with these ingest fences would avoid replacement semantics; a
"first version" engine alone would still not prevent duplicate rollup increments.

This fix cannot restore originals already erased by ReplacingMergeTree, repair past
rollup overcounts, or globally canonicalize every historical conflicting id across
cursor pages. Source filters cannot return a version whose own fields fail the filter.
New fenced writes have one row per id and agree across search/detail/export/rollups.
Legacy conflicts should be audited and reconciled explicitly, preserving all surviving
evidence. Direct ClickHouse writers and old binaries must be denied or upgraded;
the database engine itself is not an authorization boundary.
An action filter can still surface a legacy non-canonical version that matches that
filter, while detail selects the oldest surviving version. This is historical data
ambiguity; the filtered row's own fields always satisfy its filter.
