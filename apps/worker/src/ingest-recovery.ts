import {
  ASYNC_INSERT_FLUSH_BOUND_MS,
  type ClickHouseClient,
  INGEST_CLAIM_LEASE_MS,
  rawEventIdentities,
  rebuildProjectRollups,
  repairEventIndex,
  retryFingerprint,
} from '@logbird/clickhouse';
import { confirmIngestReceipts, INGEST_RECEIPT_WINDOW_MS, prisma, withProjectLock } from '@logbird/database';

const FLUSH_INTERVAL_MS = 60_000;
let flushedAt = 0;
let flushAttemptedAt = 0;
let flushing: Promise<void> | undefined;
async function flushAfter(ch: ClickHouseClient, proofAfter: number) {
  if (flushedAt >= proofAfter) return true;
  if (flushing) await flushing;
  if (flushedAt >= proofAfter) return true;
  if (Date.now() - flushAttemptedAt < FLUSH_INTERVAL_MS) return false;
  const startedAt = Date.now();
  flushAttemptedAt = startedAt;
  flushing = ch.command({ query: 'SYSTEM FLUSH ASYNC INSERT QUEUE', clickhouse_settings: { max_execution_time: 30 } }).then(() => {
    flushedAt = startedAt;
  });
  try {
    await flushing;
  } finally {
    flushing = undefined;
  }
  return true;
}

/** Run outside a shared lock. Only matching retries, terminal grace cleanup and operators enter recovery. */
export async function recoverProjectIngest(
  ch: ClickHouseClient,
  projectId: string,
  eventIds?: string[],
  replay?: () => Promise<void>,
  candidates?: { input: unknown; eventId: string }[],
) {
  const now = Date.now();
  const expiredAt = new Date(now - INGEST_CLAIM_LEASE_MS - ASYNC_INSERT_FLUSH_BOUND_MS);
  const readyCutoff = new Date(now - INGEST_RECEIPT_WINDOW_MS);
  const eligible = {
    projectId,
    confirmedAt: null,
    OR: [{ claimedAt: { lt: expiredAt } }, { claimedAt: null }],
    ...(eventIds ? { eventId: { in: eventIds } } : {}),
  };
  const preview = await prisma.ingestReceipt.findMany({ where: eligible, take: 1000, orderBy: { claimedAt: { sort: 'desc', nulls: 'last' } } });
  if (!preview.length) return false;
  const actionable =
    !candidates ||
    preview.some(
      (r) =>
        (!r.claimedAt && r.receivedAt < readyCutoff) ||
        candidates.some(
          (c) => c.eventId === r.eventId && retryFingerprint(c.input, projectId, r.receivedAt, r.eventId, r.fingerprint, r.eventAt) === r.fingerprint,
        ),
    );
  if (!actionable) return false;
  const proofAfter = Math.max(
    0,
    ...preview.filter((r) => r.claimedAt).map((r) => (r.claimedAt?.getTime() ?? 0) + INGEST_CLAIM_LEASE_MS + ASYNC_INSERT_FLUSH_BOUND_MS),
  );
  // Avoid taking the project lock for a flush that the process-wide throttle will refuse.
  if (proofAfter > flushedAt && !flushing && now - flushAttemptedAt < FLUSH_INTERVAL_MS) return false;
  return withProjectLock(projectId, async () => {
    const newestClaim = await prisma.ingestReceipt.findFirst({
      where: { ...eligible, claimedAt: { lt: expiredAt } },
      orderBy: { claimedAt: 'desc' },
    });
    const requiredProof = newestClaim?.claimedAt ? newestClaim.claimedAt.getTime() + INGEST_CLAIM_LEASE_MS + ASYNC_INSERT_FLUSH_BOUND_MS : 0;
    if (requiredProof && !(await flushAfter(ch, requiredProof))) return false;
    // A failed MV can commit any subset of destinations. Repair before confirming any page.
    await rebuildProjectRollups(ch, projectId);
    let after: string | undefined;
    while (true) {
      const receipts = await prisma.ingestReceipt.findMany({
        where: { ...eligible, ...(after ? { AND: { eventId: { gt: after } } } : {}) },
        orderBy: { eventId: 'asc' },
        take: 1000,
      });
      if (!receipts.length) break;
      const confirmations: { eventId: string; fingerprint: string; receivedAt: Date; eventAt: Date }[] = [];
      const missing: string[] = [];
      const obsolete: string[] = [];
      const ids = receipts.map((r) => r.eventId);
      const stored = await rawEventIdentities(ch, projectId, ids);
      await repairEventIndex(ch, projectId, ids, stored);
      for (const receipt of receipts) {
        const identity = stored.get(receipt.eventId);
        // Stored evidence wins even when the abandoned claimant had different content.
        if (identity) confirmations.push({ eventId: receipt.eventId, ...identity });
        else if (!receipt.claimedAt && receipt.receivedAt < readyCutoff) obsolete.push(receipt.eventId);
        else missing.push(receipt.eventId);
      }
      await confirmIngestReceipts(projectId, confirmations);
      if (missing.length)
        await prisma.ingestReceipt.updateMany({ where: { projectId, eventId: { in: missing }, confirmedAt: null }, data: { claimedAt: null } });
      if (obsolete.length)
        await prisma.ingestReceipt.deleteMany({ where: { projectId, eventId: { in: obsolete }, confirmedAt: null, claimedAt: null } });
      after = receipts.at(-1)?.eventId;
    }
    if (replay) {
      await replay();
      return true;
    }
    return false;
  });
}
