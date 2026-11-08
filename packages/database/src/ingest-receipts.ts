import { setTimeout as pause } from 'node:timers/promises';
import { Prisma, prisma } from './index';

/** Ordered key seeks avoid project-range scans before statistics catch up with a busy new project. */
export async function findIngestReceipts(projectId: string, eventIds: string[]) {
  if (!eventIds.length) return [];
  // Equality alone can choose the project/confirmedAt index once per id. Seek in full PK order,
  // then check equality outside LIMIT so neither the filter nor stale project estimates undo the seek.
  return prisma.$queryRaw<import('./generated/client').IngestReceipt[]>(Prisma.sql`
    SELECT r.* FROM (SELECT id FROM unnest(${eventIds}::text[]) AS ids(id) ORDER BY id) AS requested
    CROSS JOIN LATERAL (
      SELECT * FROM "IngestReceipt" WHERE ("projectId","eventId")>=(${projectId},requested.id)
      ORDER BY "projectId","eventId" LIMIT 1
    ) AS r WHERE r."projectId"=${projectId} AND r."eventId"=requested.id`);
}

/** Sorted, typed-array claims preserve ON CONFLICT ownership without a bind parameter per cell. */
export async function claimIngestReceipts(
  projectId: string,
  organizationId: string,
  claims: { eventId: string; fingerprint: string; receivedAt: Date; eventAt: Date; confirmedAt: Date | null; claimedAt: Date }[],
  db: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma,
) {
  if (!claims.length) return [];
  return db.$queryRaw<import('./generated/client').IngestReceipt[]>(Prisma.sql`
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

/** Bulk confirmation avoids a sequential round trip per recovered id. UTC strings avoid session-TZ casts. */
export async function confirmIngestReceipts(
  projectId: string,
  identities: { eventId: string; fingerprint: string; receivedAt: Date; eventAt: Date }[],
) {
  if (!identities.length) return;
  // Four array parameters avoid parsing/encoding four bind parameters per event.
  // Seek without locking, then lock the checked tuple: a missing id must not lock its successor.
  await prisma.$executeRaw(Prisma.sql`WITH targets AS MATERIALIZED (
    SELECT v.*, r.ctid FROM (
      SELECT * FROM unnest(${identities.map((r) => r.eventId)}::text[], ${identities.map((r) => r.fingerprint)}::text[],
        ${identities.map((r) => r.receivedAt.toISOString())}::timestamp[], ${identities.map((r) => r.eventAt.toISOString())}::timestamp[])
        AS input(id,fingerprint,received,event) ORDER BY id
    ) AS v CROSS JOIN LATERAL (
      SELECT ctid,"projectId","eventId" FROM "IngestReceipt" WHERE ("projectId","eventId")>=(${projectId},v.id)
      ORDER BY "projectId","eventId" LIMIT 1
    ) AS hit CROSS JOIN LATERAL (
      SELECT ctid FROM "IngestReceipt" WHERE ctid=hit.ctid AND "projectId"=${projectId} AND "eventId"=v.id OFFSET 0 FOR UPDATE
    ) AS r WHERE hit."projectId"=${projectId} AND hit."eventId"=v.id)
    UPDATE "IngestReceipt" AS r
    SET "fingerprint"=v.fingerprint, "receivedAt"=v.received, "eventAt"=v.event, "confirmedAt"=${new Date().toISOString()}::timestamp
    FROM targets AS v WHERE r.ctid=v.ctid`);
}

/** Expire confirmed claims only. An unresolved INSERT must never become writable by timeout. */
export const INGEST_RECEIPT_WINDOW_MS = 10 * 60_000;
export const INGEST_RECEIPT_PRUNE_BATCH_SIZE = 5000;
export const INGEST_RECEIPT_SWEEP_BUDGET_MS = 20_000;

/** A request expires only ids it actually looked up; fresh ids do no cleanup work. */
export async function expireIngestReceipts(projectId: string, eventIds: string[], cutoff: Date) {
  if (!eventIds.length) return;
  if (eventIds.length > INGEST_RECEIPT_PRUNE_BATCH_SIZE) throw new RangeError('Receipt expiry exceeds one bounded batch');
  // Check the exact key before locking: a missing key's successor may belong to another project.
  await prisma.$executeRaw(Prisma.sql`WITH expired AS MATERIALIZED (
    SELECT r.ctid FROM (SELECT id FROM unnest(${eventIds}::text[]) AS ids(id) ORDER BY id) AS requested
    CROSS JOIN LATERAL (
      SELECT ctid,"projectId","eventId" FROM "IngestReceipt" WHERE ("projectId","eventId")>=(${projectId},requested.id)
      ORDER BY "projectId","eventId" LIMIT 1
    ) AS hit CROSS JOIN LATERAL (
      SELECT ctid FROM "IngestReceipt" WHERE ctid=hit.ctid AND "projectId"=${projectId} AND "eventId"=requested.id
        AND "confirmedAt"<${cutoff.toISOString()}::timestamp OFFSET 0 FOR UPDATE
    ) AS r WHERE hit."projectId"=${projectId} AND hit."eventId"=requested.id)
    DELETE FROM "IngestReceipt" AS target USING expired WHERE target.ctid=expired.ctid`);
}

async function pruneReceiptBatch(projectId: string | undefined, cutoff: string, db: Pick<Prisma.TransactionClient, '$executeRaw'> = prisma) {
  // Tuple ids are used only inside this row-locked statement, never as stored identity.
  return db.$executeRaw(Prisma.sql`WITH expired AS MATERIALIZED
    (SELECT ctid FROM "IngestReceipt"
     WHERE "confirmedAt" < ${cutoff}::timestamp ${projectId ? Prisma.sql`AND "projectId"=${projectId}` : Prisma.empty}
     ORDER BY "confirmedAt" LIMIT ${INGEST_RECEIPT_PRUNE_BATCH_SIZE} FOR UPDATE SKIP LOCKED)
    DELETE FROM "IngestReceipt" AS r USING expired WHERE r.ctid=expired.ctid`);
}

/** Bulk worker/operator backstop; never called from the ingest request path. */
export async function pruneIngestReceipts(projectId?: string) {
  const cutoff = new Date(Date.now() - INGEST_RECEIPT_WINDOW_MS).toISOString();
  while ((await pruneReceiptBatch(projectId, cutoff)) === INGEST_RECEIPT_PRUNE_BATCH_SIZE) {
    await pause(10);
  }
}

/** Dedicated minute worker; the optional project scope also supports isolated operator recovery. */
export async function sweepIngestReceipts(projectId?: string) {
  const started = Date.now(),
    cutoff = new Date(started - INGEST_RECEIPT_WINDOW_MS).toISOString();
  let removed = 0,
    batches = 0;
  while (Date.now() - started < INGEST_RECEIPT_SWEEP_BUDGET_MS) {
    const count = await prisma.$transaction(
      async (tx) => {
        // Bound the last in-flight batch as well as the between-batch time budget.
        // A stale estimate must not turn ORDER BY/LIMIT into a full expiry bitmap + sort.
        await tx.$executeRaw`SELECT set_config('statement_timeout','5s',true), set_config('enable_bitmapscan','off',true)`;
        return pruneReceiptBatch(projectId, cutoff, tx);
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

/** Call after the matching ClickHouse purge while holding the exclusive project lock. */
export async function purgeIngestReceipts(projectId: string, cutoff?: Date) {
  await prisma.ingestReceipt.deleteMany({ where: { projectId, ...(cutoff ? { eventAt: { lt: cutoff }, confirmedAt: { not: null } } : {}) } });
}
