import {
  ASYNC_INSERT_FLUSH_BOUND_MS,
  type ClickHouseClient,
  INGEST_CLAIM_LEASE_MS,
  rawEventIdentities,
  repairEventIndex,
  retryFingerprint,
} from '@logbird/clickhouse';
import { confirmIngestReceipts, INGEST_RECEIPT_WINDOW_MS, ProjectBusyError, prisma, withProjectLock } from '@logbird/database';
import { rebuildProjectReadModel } from './project-repair';

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

async function hasFailedRepair(projectId: string) {
  return !!(await prisma.retentionRun.findFirst({ where: { projectId, kind: 'ingest_repair', status: 'failed' }, select: { id: true } }));
}
export async function ingestRecoveryRetryAfter(projectId: string) {
  // Retention owns failed repairs. Poll its durable result once a minute; requests never rebuild it again.
  if (await hasFailedRepair(projectId)) return 60;
  return Math.max(0, Math.ceil((flushAttemptedAt + FLUSH_INTERVAL_MS - Date.now()) / 1000));
}
export function logIngestRecoveryFailure(error: unknown, projectId?: string) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
  if (error instanceof ProjectBusyError || code === 'project_busy') return;
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'ingest.recovery_failed',
      projectId,
      code,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 512),
    }),
  );
}
export async function probeIngestRecovery(ch: ClickHouseClient) {
  try {
    await flushAfter(ch, Date.now());
    return true;
  } catch (error) {
    logIngestRecoveryFailure(error);
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'ingest.recovery_grant_unavailable',
        message: 'Grant SYSTEM FLUSH ASYNC INSERT QUEUE to the writer. Recovery requires one ClickHouse node.',
      }),
    );
    return false;
  }
}
export interface IngestRecoveryOptions {
  eventIds?: string[];
  replay?: () => Promise<void>;
  candidates?: { input: unknown; eventId: string }[];
}
/** Run outside a shared lock. Only matching retries, terminal grace cleanup and operators enter recovery. */
export async function recoverProjectIngest(ch: ClickHouseClient, projectId: string, { eventIds, replay, candidates }: IngestRecoveryOptions = {}) {
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
  if (!actionable || (await hasFailedRepair(projectId))) return false;
  const proofAfter = Math.max(
    0,
    ...preview.filter((r) => r.claimedAt).map((r) => (r.claimedAt?.getTime() ?? 0) + INGEST_CLAIM_LEASE_MS + ASYNC_INSERT_FLUSH_BOUND_MS),
  );
  // Avoid taking the project lock for a flush that the process-wide throttle will refuse.
  if (proofAfter > flushedAt && !flushing && now - flushAttemptedAt < FLUSH_INTERVAL_MS) return false;
  return withProjectLock(projectId, async () => {
    // A repair can fail while this request is acquiring the lock. Its queued retention job owns recovery.
    if (await hasFailedRepair(projectId)) return false;
    const newestClaim = await prisma.ingestReceipt.findFirst({
      where: { ...eligible, claimedAt: { lt: expiredAt } },
      orderBy: { claimedAt: 'desc' },
    });
    const requiredProof = newestClaim?.claimedAt ? newestClaim.claimedAt.getTime() + INGEST_CLAIM_LEASE_MS + ASYNC_INSERT_FLUSH_BOUND_MS : 0;
    if (requiredProof && !(await flushAfter(ch, requiredProof))) return false;
    // A failed MV can commit any subset of destinations. Repair before confirming any page.
    if (newestClaim) await rebuildProjectReadModel(ch, projectId);
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
