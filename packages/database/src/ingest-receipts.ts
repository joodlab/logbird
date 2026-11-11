import { setTimeout as pause } from 'node:timers/promises';
import { Prisma, prisma } from './index';

type ReceiptIdentity = { eventId: string; fingerprint: string; receivedAt: Date; eventAt: Date };
type CasResult = { found: number; changed: number; skipped: string[] };

/** A receipt claim or bounded CAS lost to concurrent index/row maintenance. */
export class IngestReceiptConflictError extends Error {
  readonly code = 'LOGBIRD_INGEST_RECEIPT_CONFLICT';
  constructor(readonly operation: 'claim' | 'confirm' | 'expire') {
    super(`Ingest receipt ${operation} conflicted with concurrent maintenance`);
    this.name = 'IngestReceiptConflictError';
  }
}

/**
 * Ordered key seek. Equality alone can choose the project/confirmedAt index once per id. Seek in full PK
 * order, then check equality outside LIMIT so neither the filter nor stale project estimates undo the seek.
 */
const seek = (projectId: string, id: Prisma.Sql, columns: Prisma.Sql) =>
  Prisma.sql`SELECT ${columns} FROM "IngestReceipt" WHERE ("projectId","eventId")>=(${projectId},${id})
    ORDER BY "projectId","eventId" LIMIT 1`;

/**
 * Per-id probes must be index-driven whatever the statistics say. A drained or rolled-back receipt backlog
 * leaves a bloated, nearly empty heap: the planner then prices one seq scan + sort per id below the ordered
 * primary-key seek (or another index plus an incremental sort), and the inflated total cost JIT-compiles an
 * OLTP statement. Every alternative needs a seq scan, bitmap, sort or incremental sort. With those disabled,
 * the primary-key seek is the plan with the fewest disabled nodes: none beyond the input-id sort that every plan
 * shares. Transaction-local; reverts at COMMIT or ROLLBACK.
 */
export const RECEIPT_SEEK_GUARD = Prisma.sql`SELECT set_config('enable_seqscan','off',true), set_config('enable_bitmapscan','off',true),
  set_config('enable_sort','off',true),
  set_config('enable_incremental_sort','off',true), set_config('jit','off',true)`;
/**
 * Bounds for the guard's transaction (BEGIN, guard, probe, COMMIT). Prisma's 2 s queue / 5 s execution defaults
 * must not apply: before the guard these were plain statements that queued for a connection and waited on row
 * locks without a deadline. A confirmation after an acknowledged ClickHouse write mostly waits on a saturated
 * pool queue or runs slowly for a large batch (the sweep never locks unconfirmed claims; its row contention
 * applies to targeted expiry). Rolling such a confirmation back would report a stored write as failed and force
 * recovery. 60 s is a generous bound of the same order as the ingest ClickHouse socket budget. A late
 * confirmation stays safe because the request still holds the shared project lock, so recovery, which needs
 * the exclusive lock, cannot run concurrently.
 */
export const RECEIPT_PROBE_TRANSACTION = { maxWait: 60_000, timeout: 60_000 } as const;
/**
 * A CAS re-seek covers only the few ids a concurrent writer touched, inside a request that holds the project lock.
 * Waiting another full minute for a pool connection there adds nothing: fail fast to the retryable 503 instead.
 */
export const RECEIPT_CAS_RETRY_TRANSACTION = { maxWait: 5000, timeout: 60_000 } as const;
async function guarded<T>(statement: Prisma.Sql, options: { maxWait: number; timeout: number } = RECEIPT_PROBE_TRANSACTION) {
  const [, rows] = await prisma.$transaction([prisma.$executeRaw(RECEIPT_SEEK_GUARD), prisma.$queryRaw<T>(statement)], options);
  return rows;
}

/** Exposed for the plan-shape test: every per-id probe must stay a primary-key seek. */
export function findIngestReceiptsSql(projectId: string, eventIds: string[]) {
  return Prisma.sql`
    SELECT r.* FROM (SELECT id FROM unnest(${eventIds}::text[]) AS ids(id) ORDER BY id) AS requested
    CROSS JOIN LATERAL (${seek(projectId, Prisma.sql`requested.id`, Prisma.sql`*`)}) AS r
    WHERE r."projectId"=${projectId} AND r."eventId"=requested.id`;
}

export async function findIngestReceipts(projectId: string, eventIds: string[]) {
  if (!eventIds.length) return [];
  return guarded<import('./generated/client').IngestReceipt[]>(findIngestReceiptsSql(projectId, eventIds));
}

/** Sorted, typed-array claims preserve ON CONFLICT ownership without a bind parameter per cell. */
export async function claimIngestReceipts(
  projectId: string,
  organizationId: string,
  claims: { eventId: string; fingerprint: string; receivedAt: Date; eventAt: Date; confirmedAt: Date | null; claimedAt: Date }[],
  db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma,
) {
  if (!claims.length) return [];
  try {
    return await db.$queryRaw<import('./generated/client').IngestReceipt[]>(Prisma.sql`
    WITH claimed AS (INSERT INTO "IngestReceipt" ("projectId","organizationId","eventId","fingerprint","receivedAt","eventAt","confirmedAt","claimedAt")
    SELECT ${projectId},${organizationId},v.id,v.fingerprint,v.received,v.event,v.confirmed,v.claimed
    FROM unnest(${claims.map((r) => r.eventId)}::text[], ${claims.map((r) => r.fingerprint)}::text[],
      ${claims.map((r) => r.receivedAt.toISOString())}::timestamp[], ${claims.map((r) => r.eventAt.toISOString())}::timestamp[],
      ${claims.map((r) => r.confirmedAt?.toISOString() ?? null)}::timestamp[], ${claims.map((r) => r.claimedAt.toISOString())}::timestamp[])
      AS v(id,fingerprint,received,event,confirmed,claimed)
    ORDER BY v.id
    ON CONFLICT ("projectId","eventId") DO NOTHING RETURNING *),
    fenced AS (UPDATE "ExportLease" SET invalidated=true
      WHERE "projectId"=${projectId} AND NOT invalidated AND "expiresAt">(clock_timestamp() AT TIME ZONE 'UTC')
        AND "receivedBefore">=(SELECT min("receivedAt") FROM claimed WHERE "confirmedAt" IS NULL)
      RETURNING id)
    SELECT * FROM claimed`);
  } catch (error) {
    // During REINDEX CONCURRENTLY an invalid ccnew index still enforces uniqueness,
    // but ON CONFLICT cannot use it as an arbiter. The whole statement rolls back.
    if (isUniqueViolation(error)) throw new IngestReceiptConflictError('claim');
    throw error;
  }
}

const field = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' && key in value ? (value as Record<string, unknown>)[key] : undefined;
/**
 * True for a Postgres unique violation (23505) in any shape Prisma surfaces it. With Prisma 7 and adapter-pg a raw
 * query fails as P2010 carrying `meta.driverAdapterError.cause` ({ kind: 'UniqueConstraintViolation', originalCode });
 * model queries use P2002; a bare driver error carries code 23505.
 */
export function isUniqueViolation(error: unknown) {
  const code = field(error, 'code');
  if (code === 'P2002' || code === '23505') return true;
  const meta = field(error, 'meta');
  if (field(meta, 'code') === '23505') return true;
  for (const cause of [field(field(meta, 'driverAdapterError'), 'cause'), field(error, 'cause')])
    if (field(cause, 'originalCode') === '23505' || field(cause, 'kind') === 'UniqueConstraintViolation') return true;
  return false;
}

/** Ready replays retain the first receipt clock. Fence only rows actually claimed for an INSERT.
 * This replaces the existing takeover UPDATE; it adds no per-batch database round trip.
 */
export async function takeOverIngestReceipts(projectId: string, eventIds: string[]) {
  return prisma.$queryRaw<import('./generated/client').IngestReceipt[]>(Prisma.sql`
    WITH claimed AS (UPDATE "IngestReceipt" SET "claimedAt"=${new Date().toISOString()}::timestamp
      WHERE "projectId"=${projectId} AND "eventId"=ANY(${eventIds}::text[])
        AND "confirmedAt" IS NULL AND "claimedAt" IS NULL RETURNING *),
    fenced AS (UPDATE "ExportLease" SET invalidated=true
      WHERE "projectId"=${projectId} AND NOT invalidated AND "expiresAt">(clock_timestamp() AT TIME ZONE 'UTC')
        AND "receivedBefore">=(SELECT min("receivedAt") FROM claimed) RETURNING id)
    SELECT * FROM claimed`);
}

/**
 * Compare-and-set result. `hits` is what the unlocked seek saw; `locked` keeps only tuples whose exact
 * ctid/key still matched once the row lock was granted. A concurrent update moves the row to a new ctid:
 * either the TID recheck drops it, or the UPDATE/DELETE by ctid cannot see the new version. Either way,
 * `skipped` names the lost id so it is sought again against the current version.
 */
const casResult = (changed: Prisma.Sql) => Prisma.sql`
  SELECT (SELECT count(*) FROM hits)::int AS found, (SELECT count(*) FROM ${changed})::int AS changed,
    CASE WHEN (SELECT count(*) FROM hits)=(SELECT count(*) FROM ${changed}) THEN '{}'::text[]
      ELSE ARRAY(SELECT id FROM hits EXCEPT SELECT "eventId" FROM ${changed}) END AS skipped`;

/** Exposed for the plan-shape test. UTC strings avoid session-TZ casts. */
export function confirmIngestReceiptsSql(projectId: string, identities: ReceiptIdentity[], confirmedAt: Date) {
  // Four array parameters avoid parsing/encoding four bind parameters per event.
  // Seek without locking, then lock the checked tuple: a missing id must not lock its successor.
  return Prisma.sql`WITH hits AS MATERIALIZED (
    SELECT v.*, hit.ctid AS tid FROM (
      SELECT * FROM unnest(${identities.map((r) => r.eventId)}::text[], ${identities.map((r) => r.fingerprint)}::text[],
        ${identities.map((r) => r.receivedAt.toISOString())}::timestamp[], ${identities.map((r) => r.eventAt.toISOString())}::timestamp[])
        AS input(id,fingerprint,received,event) ORDER BY id
    ) AS v CROSS JOIN LATERAL (${seek(projectId, Prisma.sql`v.id`, Prisma.sql`ctid,"projectId","eventId"`)}) AS hit
    WHERE hit."projectId"=${projectId} AND hit."eventId"=v.id
  ), locked AS MATERIALIZED (
    SELECT hits.*, r.ctid FROM hits CROSS JOIN LATERAL (
      SELECT ctid FROM "IngestReceipt" WHERE ctid=hits.tid AND "projectId"=${projectId} AND "eventId"=hits.id OFFSET 0 FOR UPDATE
    ) AS r
  ), changed AS (
    UPDATE "IngestReceipt" AS r
    SET "fingerprint"=v.fingerprint, "receivedAt"=v.received, "eventAt"=v.event, "confirmedAt"=${confirmedAt.toISOString()}::timestamp
    FROM locked AS v WHERE r.ctid=v.ctid RETURNING r."eventId"
  ) ${casResult(Prisma.sql`changed`)}`;
}

/** Exposed for the plan-shape test. Checks the exact key before locking: a missing key's successor may belong to another project. */
export function expireIngestReceiptsSql(projectId: string, eventIds: string[], cutoff: Date) {
  const expiredBefore = Prisma.sql`${cutoff.toISOString()}::timestamp`;
  return Prisma.sql`WITH hits AS MATERIALIZED (
    SELECT requested.id, hit.ctid AS tid FROM (SELECT id FROM unnest(${eventIds}::text[]) AS ids(id) ORDER BY id) AS requested
    CROSS JOIN LATERAL (${seek(projectId, Prisma.sql`requested.id`, Prisma.sql`ctid,"projectId","eventId","confirmedAt"`)}) AS hit
    WHERE hit."projectId"=${projectId} AND hit."eventId"=requested.id AND hit."confirmedAt"<${expiredBefore}
  ), locked AS MATERIALIZED (
    SELECT r.ctid FROM hits CROSS JOIN LATERAL (
      SELECT ctid FROM "IngestReceipt" WHERE ctid=hits.tid AND "projectId"=${projectId} AND "eventId"=hits.id
        AND "confirmedAt"<${expiredBefore} OFFSET 0 FOR UPDATE
    ) AS r
  ), changed AS (
    DELETE FROM "IngestReceipt" AS target USING locked WHERE target.ctid=locked.ctid RETURNING target."eventId"
  ) ${casResult(Prisma.sql`changed`)}`;
}

/** Concurrent writers lose only their stale tuple: re-seek the skipped ids against the current version. */
const CAS_ATTEMPTS = 3;
async function compareAndSet<T extends string | { eventId: string }>(
  operation: 'confirm' | 'expire',
  items: T[],
  statement: (items: T[]) => Prisma.Sql,
) {
  let remaining = items;
  for (let attempt = 1; remaining.length; attempt++) {
    const [result] = await guarded<CasResult[]>(statement(remaining), attempt === 1 ? RECEIPT_PROBE_TRANSACTION : RECEIPT_CAS_RETRY_TRANSACTION);
    if (!result || result.changed + result.skipped.length !== result.found) throw new IngestReceiptConflictError(operation);
    if (!result.skipped.length) return;
    if (attempt >= CAS_ATTEMPTS) throw new IngestReceiptConflictError(operation);
    const skipped = new Set(result.skipped);
    remaining = items.filter((item) => skipped.has(typeof item === 'string' ? item : item.eventId));
  }
}

/** Bulk confirmation avoids a sequential round trip per recovered id. */
export async function confirmIngestReceipts(projectId: string, identities: ReceiptIdentity[]) {
  if (!identities.length) return;
  const confirmedAt = new Date();
  // One identity per id keeps found/changed comparable; the last identity for an id wins, as UPDATE ... FROM would.
  const unique = [...new Map(identities.map((identity) => [identity.eventId, identity])).values()];
  await compareAndSet('confirm', unique, (items) => confirmIngestReceiptsSql(projectId, items, confirmedAt));
}

/** Expire confirmed claims only. An unresolved INSERT must never become writable by timeout. */
export const INGEST_RECEIPT_WINDOW_MS = 10 * 60_000;
export const INGEST_RECEIPT_PRUNE_BATCH_SIZE = 5000;
export const INGEST_RECEIPT_SWEEP_BUDGET_MS = 20_000;
/** The hourly/project backstop gets more room than the minute sweep, but never an unbounded loop. */
export const INGEST_RECEIPT_BACKSTOP_BUDGET_MS = 60_000;

/** A request expires only ids it actually looked up; fresh ids do no cleanup work. */
export async function expireIngestReceipts(projectId: string, eventIds: string[], cutoff: Date) {
  if (!eventIds.length) return;
  if (eventIds.length > INGEST_RECEIPT_PRUNE_BATCH_SIZE) throw new RangeError('Receipt expiry exceeds one bounded batch');
  // A renewed receipt is re-sought against its new version, where the cutoff no longer matches.
  await compareAndSet('expire', [...new Set(eventIds)], (items) => expireIngestReceiptsSql(projectId, items, cutoff));
}

/** One sweep batch. Exposed for plan tests; the minute sweep and backstop run it under SWEEP_GUARD. */
export function pruneReceiptBatchSql(projectId: string | undefined, cutoff: string) {
  // Tuple ids are used only inside this row-locked statement, never as stored identity.
  return Prisma.sql`WITH expired AS MATERIALIZED
    (SELECT ctid FROM "IngestReceipt"
     WHERE "confirmedAt" < ${cutoff}::timestamp ${projectId ? Prisma.sql`AND "projectId"=${projectId}` : Prisma.empty}
     ORDER BY "confirmedAt" LIMIT ${INGEST_RECEIPT_PRUNE_BATCH_SIZE} FOR UPDATE SKIP LOCKED)
    DELETE FROM "IngestReceipt" AS r USING expired WHERE r.ctid=expired.ctid`;
}
/**
 * Bounds the last in-flight batch as well as the between-batch time budget. SKIP LOCKED never waits on rows;
 * lock_timeout also bounds a table-level wait behind DDL. Like the probes, each batch must walk a
 * confirmedAt-ordered index: a stale or bloated estimate must not turn ORDER BY/LIMIT into a seq scan or a
 * history-sized bitmap plus sort.
 */
export const SWEEP_GUARD = Prisma.sql`SELECT set_config('statement_timeout','5s',true), set_config('lock_timeout','1s',true),
  set_config('enable_seqscan','off',true), set_config('enable_bitmapscan','off',true), set_config('enable_sort','off',true),
  set_config('enable_incremental_sort','off',true), set_config('jit','off',true)`;

/**
 * Guarded batches shared by the minute sweep and the hourly/project backstop. Each batch runs in its own
 * short transaction with transaction-local (SET LOCAL) settings that revert at commit or rollback.
 */
async function pruneWithinBudget(projectId: string | undefined, budgetMs: number) {
  const started = Date.now(),
    cutoff = new Date(started - INGEST_RECEIPT_WINDOW_MS).toISOString();
  let removed = 0,
    batches = 0;
  while (Date.now() - started < budgetMs) {
    const count = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw(SWEEP_GUARD);
        return tx.$executeRaw(pruneReceiptBatchSql(projectId, cutoff));
      },
      { maxWait: 1000, timeout: 6000 },
    );
    removed += count;
    batches++;
    if (count < INGEST_RECEIPT_PRUNE_BATCH_SIZE) return { removed, batches, limited: false };
    await pause(10);
  }
  return { removed, batches, limited: true };
}

/** Hourly/project backstop; never called from the ingest request path. `limited` means expired rows remain. */
export function pruneIngestReceipts(projectId?: string) {
  return pruneWithinBudget(projectId, INGEST_RECEIPT_BACKSTOP_BUDGET_MS);
}

/** Dedicated minute worker; the optional project scope also supports isolated operator recovery. */
export function sweepIngestReceipts(projectId?: string) {
  return pruneWithinBudget(projectId, INGEST_RECEIPT_SWEEP_BUDGET_MS);
}

/** Call after the matching ClickHouse purge while holding the exclusive project lock. */
export async function purgeIngestReceipts(projectId: string, cutoff?: Date) {
  await prisma.ingestReceipt.deleteMany({ where: { projectId, ...(cutoff ? { eventAt: { lt: cutoff }, confirmedAt: { not: null } } : {}) } });
}
