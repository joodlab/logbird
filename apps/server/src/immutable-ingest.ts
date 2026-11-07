import { type EventRow, eventFingerprint, existingEventIdentities, insertEvents, retryFingerprint } from '@logbird/clickhouse';
import { Prisma, prisma, pruneIngestReceipts } from '@logbird/database';
import { clickhouse } from './clickhouse';
import { ApiError } from './errors';

export type IngestCandidate = { index: number; input: unknown; row: EventRow };

/** Called inside the shared project lock; the Postgres unique key fences all server processes. */
export async function insertImmutableEvents(projectId: string, organizationId: string, candidates: IngestCandidate[]) {
  if (!candidates.length) return { ids: [] as string[], rejected: [] as { index: number; reason: string }[] };
  await pruneIngestReceipts(projectId);
  const unique = new Map<string, EventRow>();
  for (const { row } of candidates) if (!unique.has(row.event_id)) unique.set(row.event_id, row);
  const eventIds = [...unique.keys()].sort(); // Consistent insert order avoids overlapping-batch deadlocks.
  const prior = await prisma.ingestReceipt.findMany({ where: { projectId, eventId: { in: eventIds } } });
  const cached = new Map(prior.map((r) => [r.eventId, r]));
  const stored = await existingEventIdentities(
    clickhouse,
    projectId,
    eventIds.filter((id) => !cached.get(id)?.confirmedAt),
  );
  const values = [...unique.entries()]
    .filter(([id]) => !cached.has(id))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, row]) => {
      const legacy = stored.get(id);
      return Prisma.sql`(${projectId}, ${id}, ${organizationId}, ${legacy?.fingerprint ?? eventFingerprint(row)}, ${legacy?.receivedAt ?? new Date(row.received_at)}, ${legacy?.eventAt ?? new Date(row.timestamp)}, ${legacy ? new Date() : null})`;
    });
  const owned = values.length
    ? await prisma.$queryRaw<{ eventId: string }[]>(Prisma.sql`
    INSERT INTO "IngestReceipt" ("projectId", "eventId", "organizationId", "fingerprint", "receivedAt", "eventAt", "confirmedAt")
    VALUES ${Prisma.join(values)} ON CONFLICT ("projectId", "eventId") DO NOTHING RETURNING "eventId"`)
    : [];
  const ownedIds = owned.map((r) => r.eventId);
  let attempted = false;
  try {
    // Recheck after ownership: a process may have paused between the first lookup and claiming,
    // long enough for another writer's confirmed cache entry to expire.
    const recheckIds = ownedIds.filter((id) => !stored.has(id));
    const rechecked = await existingEventIdentities(clickhouse, projectId, recheckIds);
    for (const [eventId, identity] of rechecked)
      await prisma.ingestReceipt.update({
        where: { projectId_eventId: { projectId, eventId } },
        data: { ...identity, confirmedAt: new Date() },
      });
    const receipts = new Map((await prisma.ingestReceipt.findMany({ where: { projectId, eventId: { in: eventIds } } })).map((r) => [r.eventId, r]));
    const ids: string[] = [],
      rejected: { index: number; reason: string }[] = [];
    const rows = new Map<string, EventRow>();
    for (const candidate of candidates) {
      const id = candidate.row.event_id;
      const receipt = receipts.get(id);
      // A concurrent cache expiry can only remove a confirmed receipt. Recheck on the next HTTP retry.
      if (!receipt) throw new ApiError(503, 'ingest_pending', 'Event receipt changed; retry this batch.');
      const digest = retryFingerprint(candidate.input, projectId, receipt.receivedAt, id);
      if (digest !== receipt.fingerprint) {
        rejected.push({ index: candidate.index, reason: 'duplicate_id_conflict' });
        continue;
      }
      if (!receipt.confirmedAt && !ownedIds.includes(id)) {
        // Includes recovery after INSERT succeeded but confirmation/HTTP delivery failed.
        const existing = stored.get(id) ?? (await existingEventIdentities(clickhouse, projectId, [id])).get(id);
        if (!existing || existing.fingerprint !== receipt.fingerprint)
          throw new ApiError(503, 'ingest_pending', 'An earlier write is unresolved; retry this batch.');
        await prisma.ingestReceipt.update({ where: { projectId_eventId: { projectId, eventId: id } }, data: { confirmedAt: new Date() } });
      } else if (!receipt.confirmedAt && !rows.has(id)) rows.set(id, candidate.row);
      ids.push(id);
    }
    attempted = true; // A transport error can mean ClickHouse accepted the INSERT. Preserve claims.
    try {
      await insertEvents(clickhouse, [...rows.values()]);
    } catch {
      throw new ApiError(503, 'ingest_pending', 'Storage acknowledgement is unresolved; retry this batch.');
    }
    await prisma.ingestReceipt.updateMany({ where: { projectId, eventId: { in: ownedIds }, confirmedAt: null }, data: { confirmedAt: new Date() } });
    return { ids, rejected };
  } finally {
    // Nothing was sent to ClickHouse: relinquishing only this call's claims is safe.
    if (!attempted && ownedIds.length) await prisma.ingestReceipt.deleteMany({ where: { projectId, eventId: { in: ownedIds }, confirmedAt: null } });
  }
}
