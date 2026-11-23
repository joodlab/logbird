import {
  ASYNC_INSERT_FLUSH_BOUND_MS,
  applyRetention,
  createMaintenanceClickHouseClient,
  createSessionClickHouseClient,
  hasExpiredEvents,
  INGEST_CLAIM_LEASE_MS,
  pendingEventMutations,
  pendingProjectMutations,
  projectMaintenance,
  purgeProject,
  rebuildProjectRollups,
  retentionAffectedKeys,
  retentionCutoff,
  retentionDeletedCount,
  stageRetentionRollups,
} from '@logbird/clickhouse';
import {
  cancelStagedRetention,
  type Prisma,
  prisma,
  pruneIngestReceipts,
  purgeIngestReceipts,
  RETENTION_LEASE_MS,
  RETENTION_MATERIALIZING,
  RETENTION_STAGING,
  recoverAbandonedRetention,
  withProjectLock,
} from '@logbird/database';
import { beginDestructiveMaintenance, reconcileDestructiveMaintenance } from './destructive-maintenance';
import { logIngestRecoveryFailure, prepareReceiptSettlement } from './ingest-recovery';
import { heartbeatMaintenanceRun } from './project-repair';
export const clickhouse = createMaintenanceClickHouseClient();
const unfinishedRepair = (projectId: string) => ({ projectId, kind: 'ingest_repair', status: { in: ['running', 'failed'] } });
export function logReceiptPrune(result: { removed: number; batches: number; limited: boolean }, durationMs: number, projectId?: string) {
  // Limited means expired rows remain after the budget; the minute queue is the primary cleanup path.
  if (result.removed || result.limited)
    console[result.limited ? 'warn' : 'log'](
      JSON.stringify({
        level: result.limited ? 'warn' : 'info',
        event: 'ingest.receipts_pruned',
        scope: 'backstop',
        projectId,
        ...result,
        durationMs,
      }),
    );
}
export async function pruneReceiptBackstop(projectId?: string) {
  const pruneStarted = Date.now();
  try {
    logReceiptPrune(await pruneIngestReceipts(projectId), Date.now() - pruneStarted, projectId);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    console.error(JSON.stringify({ level: 'error', event: 'ingest.receipts_prune_failed', projectId, code }));
  }
}
/** Records a no-op run under the shared lock when nothing has expired; false when the project needs a real run. */
async function recordNothingExpired(projectId: string, retentionDays: number, previewCutoff: Date) {
  // A shared lock prevents a policy change, without blocking ingest or marking the project unavailable.
  return withProjectLock(
    projectId,
    async (tx) => {
      const latest = await tx.project.findUnique({ where: { id: projectId } });
      if (!latest) return true;
      // Any unfinished maintenance defeats the no-op; a completed repair rebuilt every rollup.
      const previous = await tx.retentionRun.findFirst({ where: { projectId }, orderBy: { startedAt: 'desc' } });
      if (
        latest.exportDeleteStartedAt ||
        latest.retentionDays !== retentionDays ||
        // A canceled background run changed nothing.
        (previous && previous.status !== 'completed' && previous.status !== 'canceled') ||
        (await tx.retentionRun.count({ where: unfinishedRepair(projectId) }))
      )
        return false;
      await tx.retentionRun.create({
        data: {
          projectId,
          retentionDays: latest.retentionDays,
          cutoff: previewCutoff,
          status: 'completed',
          finishedAt: new Date(),
          deletedEvents: 0,
        },
      });
      return true;
    },
    { mode: 'shared' },
  );
}
export async function enforceProjectRetention(projectId: string) {
  await pruneReceiptBackstop(projectId);
  const current = await prisma.project.findUnique({ where: { id: projectId } });
  if (!current) return;
  const previewCutoff = new Date(Date.now() - current.retentionDays * 86_400_000);
  if (
    !(await hasExpiredEvents(clickhouse, projectId, previewCutoff)) &&
    (await recordNothingExpired(projectId, current.retentionDays, previewCutoff))
  )
    return;
  return withProjectLock(projectId, async (tx) => {
    await recoverAbandonedRetention(tx, projectId);
    // This synchronous run changes what a staged background run counted: that one must not apply.
    await cancelStagedRetention(projectId, tx);
    if (await tx.retentionRun.findFirst({ where: { projectId, status: 'running' } })) return;
    const project = await tx.project.findUnique({ where: { id: projectId } });
    if (!project) return;
    // Derived repair completion cannot settle an older raw DELETE: the independent destructive fence survives it.
    const previous = await tx.retentionRun.findFirst({ where: { projectId }, orderBy: { startedAt: 'desc' } });
    const cutoff = new Date(Date.now() - project.retentionDays * 86_400_000);
    const run = await prisma.$transaction(async (db) => {
      await beginDestructiveMaintenance(projectId, db);
      await db.project.update({ where: { id: projectId }, data: { maintenanceGeneration: { increment: 1 } } });
      return db.retentionRun.create({
        data: { projectId, retentionDays: project.retentionDays, cutoff, status: 'running', startedAt: new Date(), heartbeatAt: new Date() },
      });
    });
    // Short Prisma statements remain independent of the session holding the project lock.
    const stopHeartbeat = heartbeatMaintenanceRun(run.id);
    try {
      const rows = await (
        await clickhouse.query({
          query: 'SELECT count() n FROM events WHERE project_id={p:String} AND timestamp < {cutoff:DateTime64(3)}',
          query_params: { p: projectId, cutoff: cutoff.toISOString().replace('T', ' ').slice(0, -1) },
          format: 'JSONEachRow',
        })
      ).json<{ n: string }>();
      // Resume index deletion even when an earlier attempt already removed every expired raw row.
      // Tagged: project deletion stops these statements if a failed call left them running in ClickHouse.
      const tagged = projectMaintenance(clickhouse, projectId);
      await purgeProject(tagged, projectId, cutoff);
      await purgeIngestReceipts(projectId, cutoff);
      const repairing = previous?.status === 'failed' || (await prisma.retentionRun.count({ where: unfinishedRepair(projectId) })) > 0;
      // Prove abandoned claims flushed before this rebuild, so it also covers them and no retry rebuilds again.
      const settle = repairing
        ? await prepareReceiptSettlement(tagged, projectId).catch((error) => {
            logIngestRecoveryFailure(error, projectId);
          })
        : undefined;
      if (project.exportDeleteStartedAt || repairing) await rebuildProjectRollups(tagged, projectId);
      if (await hasExpiredEvents(clickhouse, projectId, cutoff)) throw new Error('Retention cutoff invariant failed');
      await reconcileDestructiveMaintenance(clickhouse, projectId);
      await prisma.retentionRun.updateMany({
        where: unfinishedRepair(projectId),
        data: { status: 'completed', finishedAt: new Date(), error: null },
      });
      await prisma.retentionRun.update({
        where: { id: run.id },
        data: { status: 'completed', finishedAt: new Date(), deletedEvents: Number(rows[0]?.n ?? 0) },
      });
      // The read model is consistent now. A settlement failure leaves receipts for a retry or the hourly sweep.
      if (settle) await settle().catch((error) => logIngestRecoveryFailure(error, projectId));
    } catch (error) {
      const errorCode =
        typeof error === 'object' && error !== null && 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number')
          ? error.code
          : undefined;
      console.error(JSON.stringify({ level: 'error', event: 'retention.run_failed', runId: run.id, projectId, errorCode }));
      await prisma.retentionRun.update({
        where: { id: run.id },
        data: { status: 'failed', finishedAt: new Date(), error: 'ClickHouse retention failed; retry required.' },
      });
      throw error;
    } finally {
      stopHeartbeat();
    }
  });
}

// ── Hourly retention without the lock across ClickHouse mutations (#268) ───────────────────────────────────────────
// packages/clickhouse/src/retention.ts explains the method. Ingest waits for the project lock only during the two
// fences (milliseconds; the second creates five mutations and inserts a few rows), whatever the table's part count or
// the project's size. The run is `staging` between the fences and `materializing` until ClickHouse finishes the DELETEs;
// neither refuses ingest or reads. The server's destructive-maintenance reconciler completes it (finishMaterializedRetention).

export type BackgroundRetentionOutcome = 'nothing_expired' | 'synchronous' | 'deferred' | 'canceled' | 'materializing' | 'skipped';

/** The database clock (the one ingest stamps `received_at` with), at millisecond precision as stored. */
async function databaseClock(db: Prisma.TransactionClient) {
  const [row] = await db.$queryRaw<[{ now: Date }]>`SELECT clock_timestamp() AS now`;
  return new Date(row.now.getTime());
}
/**
 * A fence time F under the exclusive lock. Every insert accepted before the lock was granted was stamped at or before
 * F; we hold the lock until the clock has passed F's millisecond, so every later insert is stamped strictly after F.
 */
async function fenceClock(db: Prisma.TransactionClient) {
  const fence = await databaseClock(db);
  while ((await databaseClock(db)).getTime() <= fence.getTime()) await new Promise((resolve) => setTimeout(resolve, 1));
  return fence;
}

/**
 * `claimedAt` is stamped by the ingesting app instance's own clock, not the database's. An instance whose clock lags
 * the worker's by L makes an unresolved claim look L older than it is; the settle proof waits this much longer, so
 * an instance may lag by up to this much without an ambiguous insert landing after a fence it was judged settled for.
 */
export const RETENTION_CLOCK_SKEW_ALLOWANCE_MS = 30_000;
/**
 * Under the exclusive lock: proves no insert of the project can still land in ClickHouse (no unresolved claim, or the
 * newest is past its lease, flush bound and clock-skew allowance and the async queue was flushed). False when a claim
 * may still be in flight.
 */
async function settleProjectInserts(projectId: string) {
  const claim = await prisma.ingestReceipt.findFirst({
    where: { projectId, confirmedAt: null, claimedAt: { not: null } },
    orderBy: { claimedAt: 'desc' },
    select: { claimedAt: true },
  });
  if (!claim?.claimedAt) return true;
  if (claim.claimedAt.getTime() + INGEST_CLAIM_LEASE_MS + ASYNC_INSERT_FLUSH_BOUND_MS + RETENTION_CLOCK_SKEW_ALLOWANCE_MS > Date.now()) return false;
  try {
    await clickhouse.command({ query: 'SYSTEM FLUSH ASYNC INSERT QUEUE', clickhouse_settings: { max_execution_time: 30 } });
  } catch (error) {
    throw Object.assign(new Error('Retention needs the SYSTEM FLUSH ASYNC INSERT QUEUE grant on the ClickHouse writer.', { cause: error }), {
      code: 'LOGBIRD_FLUSH_UNAVAILABLE',
    });
  }
  return true;
}

const cancelRun = (id: string, error: string) =>
  prisma.retentionRun.updateMany({ where: { id, status: RETENTION_STAGING }, data: { status: 'canceled', finishedAt: new Date(), error } });

/**
 * Pending mutations on `events` slow every on-the-fly read of it (about 5-7 ms each per query, measured): the sweep
 * creates no more DELETEs while this many are pending, so read latency is bounded whatever the number of projects.
 */
export const RETENTION_MAX_PENDING_DELETES = 20;
const PENDING_WAIT_MS = 120_000;
async function underPendingBound() {
  const deadline = Date.now() + PENDING_WAIT_MS;
  while ((await pendingEventMutations(clickhouse)) >= RETENTION_MAX_PENDING_DELETES) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return true;
}
/** Test seams: run between the fences, and right after the DELETE mutations exist (before the replacement rows). */
export type BackgroundRetentionHooks = { betweenFences?: () => Promise<void>; afterDeletes?: () => Promise<void> };
/** The hourly sweep's per-project run. Unusual states fall back to (or wait for) the synchronous path. */
export async function runBackgroundRetention(projectId: string, hooks: BackgroundRetentionHooks = {}): Promise<BackgroundRetentionOutcome> {
  await pruneReceiptBackstop(projectId);
  const current = await prisma.project.findUnique({ where: { id: projectId } });
  if (!current) return 'skipped';
  const previous = await prisma.retentionRun.findFirst({ where: { projectId, kind: 'retention' }, orderBy: { startedAt: 'desc' } });
  // Earlier DELETEs still finishing (this project's or a stuck table-wide queue): wait for them. A synchronous run would
  // queue a waiting DELETE behind them under the lock, refusing ingest for as long as they take.
  if ((await pendingProjectMutations(clickhouse, projectId)).length) return 'deferred';
  if (previous?.status === RETENTION_MATERIALIZING) {
    // Finished in ClickHouse but not yet completed: complete it here too (the server's reconciler normally does; during
    // a rolling upgrade an older server's does not), then start this hour's run next time.
    await withProjectLock(projectId, () => reconcileDestructiveMaintenance(clickhouse, projectId), { waitMs: 100 }).catch(() => undefined);
    return 'deferred';
  }
  // Repairs and interrupted runs keep today's synchronous path.
  if (
    previous?.status === 'running' ||
    previous?.status === 'failed' ||
    current.exportDeleteStartedAt ||
    (await prisma.retentionRun.count({ where: unfinishedRepair(projectId) }))
  ) {
    await enforceProjectRetention(projectId);
    return 'synchronous';
  }
  const cutoff = retentionCutoff(Date.now(), current.retentionDays);
  if (!(await hasExpiredEvents(clickhouse, projectId, cutoff))) {
    if (await recordNothingExpired(projectId, current.retentionDays, cutoff)) return 'nothing_expired';
    await enforceProjectRetention(projectId);
    return 'synchronous';
  }
  if (!(await underPendingBound())) {
    console.warn(JSON.stringify({ level: 'warn', event: 'retention.deferred_pending_deletes', projectId, bound: RETENTION_MAX_PENDING_DELETES }));
    return 'deferred';
  }

  // Fence A.
  const opened = await withProjectLock(projectId, async (tx) => {
    await recoverAbandonedRetention(tx, projectId);
    await tx.retentionRun.updateMany({
      where: { projectId, kind: 'retention', status: RETENTION_STAGING, heartbeatAt: { lt: new Date(Date.now() - RETENTION_LEASE_MS) } },
      data: { status: 'canceled', finishedAt: new Date(), error: 'abandoned' },
    });
    if (await tx.retentionRun.findFirst({ where: { projectId, status: { in: ['running', RETENTION_STAGING, RETENTION_MATERIALIZING] } } }))
      return null;
    const project = await tx.project.findUnique({ where: { id: projectId } });
    if (!project || project.retentionDays !== current.retentionDays || project.exportDeleteStartedAt) return null;
    if (!(await settleProjectInserts(projectId))) return 'deferred' as const;
    const fenceA = await fenceClock(tx);
    return tx.retentionRun.create({
      data: { projectId, retentionDays: project.retentionDays, cutoff, status: RETENTION_STAGING, startedAt: fenceA, heartbeatAt: new Date() },
    });
  });
  if (opened === null) return 'skipped';
  if (opened === 'deferred') return 'deferred';
  const run = opened;
  const fenceA = run.startedAt;
  const stopHeartbeat = heartbeatMaintenanceRun(run.id);
  const session = createSessionClickHouseClient(`logbird-retention-${run.id}`);
  let mutationsCreated = false;
  try {
    // Between the fences, without a lock: the expensive recompute, from rows that cannot change any more.
    const keys = await retentionAffectedKeys(clickhouse, projectId, cutoff, fenceA);
    const deletedEvents = await retentionDeletedCount(clickhouse, projectId, cutoff, fenceA);
    await stageRetentionRollups(session, projectId, cutoff, fenceA, keys);
    await hooks.betweenFences?.();
    // Fence B.
    return await withProjectLock(projectId, async (tx) => {
      const latest = await tx.retentionRun.findUnique({ where: { id: run.id } });
      if (latest?.status !== RETENTION_STAGING) return 'canceled' as const;
      const project = await tx.project.findUnique({ where: { id: projectId } });
      if (!project || project.retentionDays !== run.retentionDays) {
        await cancelRun(run.id, 'The retention period changed during the run; the next run uses the new period.');
        return 'canceled' as const;
      }
      if (!(await settleProjectInserts(projectId))) {
        await cancelRun(run.id, 'Recent writes were still settling; the next run retries.');
        return 'canceled' as const;
      }
      const fenceB = await fenceClock(tx);
      // Durable before any DELETE exists: the destructive fence, a new read generation, and `running` (which fences
      // ingest and rollup reads, both waiting on this lock anyway, for the few statements below).
      await prisma.$transaction(async (db) => {
        await beginDestructiveMaintenance(projectId, db);
        await db.project.update({ where: { id: projectId }, data: { maintenanceGeneration: { increment: 1 } } });
        await db.retentionRun.update({ where: { id: run.id }, data: { status: 'running', heartbeatAt: new Date(), deletedEvents } });
      });
      mutationsCreated = true;
      await applyRetention(session, projectId, cutoff, fenceA, fenceB, keys, hooks.afterDeletes);
      await prisma.retentionRun.update({ where: { id: run.id }, data: { status: RETENTION_MATERIALIZING, heartbeatAt: new Date() } });
      console.log(JSON.stringify({ level: 'info', event: 'retention.materializing', runId: run.id, projectId, deletedEvents }));
      return 'materializing' as const;
    });
  } catch (error) {
    const errorCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
    console.error(JSON.stringify({ level: 'error', event: 'retention.run_failed', runId: run.id, projectId, errorCode, background: true }));
    if (!mutationsCreated) {
      // Nothing changed: the next run starts over.
      await cancelRun(
        run.id,
        errorCode === 'LOGBIRD_FLUSH_UNAVAILABLE' ? (error as Error).message : 'ClickHouse retention failed before deleting; the next run retries.',
      );
    } else {
      // A DELETE may exist without the rollup rows that replace it: fence reads until retention rebuilds the rollups.
      await prisma.$transaction([
        prisma.retentionRun.update({
          where: { id: run.id },
          data: { status: 'failed', finishedAt: new Date(), error: 'ClickHouse retention failed; retry required.' },
        }),
        prisma.retentionRun.create({
          data: {
            projectId,
            kind: 'ingest_repair',
            retentionDays: run.retentionDays,
            cutoff,
            status: 'failed',
            finishedAt: new Date(),
            error: 'Retention could not finish its rollup update; the next retention run rebuilds them.',
          },
        }),
      ]);
    }
    throw error;
  } finally {
    stopHeartbeat();
    await session.close().catch(() => undefined);
  }
}
