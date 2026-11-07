import { Prisma, prisma } from './index';

/** Bulk confirmation avoids a sequential round trip per recovered id. UTC strings avoid session-TZ casts. */
export async function confirmIngestReceipts(
  projectId: string,
  identities: { eventId: string; fingerprint: string; receivedAt: Date; eventAt: Date }[],
) {
  if (!identities.length) return;
  const values = identities.map(
    (r) => Prisma.sql`(${r.eventId}, ${r.fingerprint}, ${r.receivedAt.toISOString()}::timestamp, ${r.eventAt.toISOString()}::timestamp)`,
  );
  await prisma.$executeRaw(Prisma.sql`UPDATE "IngestReceipt" AS r
    SET "fingerprint"=v.fingerprint, "receivedAt"=v.received, "eventAt"=v.event, "confirmedAt"=${new Date().toISOString()}::timestamp
    FROM (VALUES ${Prisma.join(values)}) AS v(id,fingerprint,received,event)
    WHERE r."projectId"=${projectId} AND r."eventId"=v.id`);
}

/** Expire confirmed claims only. An unresolved INSERT must never become writable by timeout. */
export const INGEST_RECEIPT_WINDOW_MS = 10 * 60_000;
const lastPruned = new Map<string, number>();
export async function pruneIngestReceipts(projectId?: string, throttle = false) {
  const now = Date.now();
  if (throttle && projectId && now - (lastPruned.get(projectId) ?? 0) < 60_000) return;
  // Limit each statement's lock/WAL footprint, including the global hourly sweep.
  const cutoff = new Date(now - INGEST_RECEIPT_WINDOW_MS).toISOString();
  let removed: number;
  do {
    removed = await prisma.$executeRaw(Prisma.sql`DELETE FROM "IngestReceipt" WHERE ("projectId", "eventId") IN
      (SELECT "projectId", "eventId" FROM "IngestReceipt"
       WHERE "confirmedAt" < ${cutoff}::timestamp ${projectId ? Prisma.sql`AND "projectId"=${projectId}` : Prisma.empty}
       LIMIT 5000)`);
  } while (removed === 5000);
  if (throttle && projectId) {
    for (const [id, at] of lastPruned) if (now - at >= 60_000) lastPruned.delete(id);
    lastPruned.set(projectId, now);
  }
}

/** Call after the matching ClickHouse purge while holding the exclusive project lock. */
export async function purgeIngestReceipts(projectId: string, cutoff?: Date) {
  await prisma.ingestReceipt.deleteMany({ where: { projectId, ...(cutoff ? { eventAt: { lt: cutoff }, confirmedAt: { not: null } } : {}) } });
}
