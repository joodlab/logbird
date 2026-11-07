import {
  ASYNC_INSERT_FLUSH_BOUND_MS,
  type ClickHouseClient,
  existingEventIdentities,
  INGEST_CLAIM_LEASE_MS,
  matchesIdentity,
} from '@logbird/clickhouse';
import { confirmIngestReceipts, prisma, withProjectLock } from '@logbird/database';

/** Run outside a shared lock. Recovery drains writers and the async queue before releasing any lease. */
export async function recoverProjectIngest(ch: ClickHouseClient, projectId: string, eventIds?: string[], replay?: () => Promise<void>) {
  const expiredAt = new Date(Date.now() - INGEST_CLAIM_LEASE_MS - ASYNC_INSERT_FLUSH_BOUND_MS);
  const expired = () => ({
    projectId,
    confirmedAt: null,
    // The worker readies missing payloads. Their producer must replay under this same exclusive boundary.
    OR: [{ claimedAt: { lt: expiredAt } }, ...(replay ? [{ claimedAt: null }] : [])],
    ...(eventIds ? { eventId: { in: eventIds } } : {}),
  });
  if (!(await prisma.ingestReceipt.findFirst({ where: expired(), select: { eventId: true } }))) return false;
  return withProjectLock(projectId, async () => {
    // The command must succeed before looking for evidence or making an absent id writable again.
    await ch.command({ query: 'SYSTEM FLUSH ASYNC INSERT QUEUE', clickhouse_settings: { max_execution_time: 30 } });
    let after: string | undefined;
    while (true) {
      const receipts = await prisma.ingestReceipt.findMany({
        where: { ...expired(), ...(after ? { AND: { eventId: { gt: after } } } : {}) },
        orderBy: { eventId: 'asc' },
        take: 1000,
      });
      if (!receipts.length) break;
      const stored = await existingEventIdentities(
        ch,
        projectId,
        receipts.map((r) => r.eventId),
      );
      const confirmations: { eventId: string; fingerprint: string; receivedAt: Date; eventAt: Date }[] = [];
      const missing: string[] = [];
      for (const receipt of receipts) {
        const identity = stored.get(receipt.eventId);
        if (identity && !matchesIdentity(receipt.fingerprint, identity)) continue;
        if (identity) confirmations.push({ eventId: receipt.eventId, ...identity });
        else missing.push(receipt.eventId);
      }
      await confirmIngestReceipts(projectId, confirmations);
      // Missing rows become retryable with the original digest and receipt clock, never a new identity.
      if (missing.length)
        await prisma.ingestReceipt.updateMany({ where: { projectId, eventId: { in: missing }, confirmedAt: null }, data: { claimedAt: null } });
      after = receipts.at(-1)?.eventId;
    }
    if (replay) {
      await replay();
      return true;
    }
    return false;
  });
}
