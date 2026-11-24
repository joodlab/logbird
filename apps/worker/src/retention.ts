import {
  applyRetention,
  committedReceivedAfter,
  createMaintenanceClickHouseClient,
  createSessionClickHouseClient,
  dropStagedRetentionRollups,
  hasExpiredEvents,
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
  BACKGROUND_RETENTION_CAPABILITY,
  cancelStagedRetention,
  databaseClock,
  type Prisma,
  ProjectBusyError,
  prisma,
  pruneIngestReceipts,
  purgeIngestReceipts,
  RETENTION_LEASE_MS,
  RETENTION_MATERIALIZING,
  RETENTION_STAGING,
  recoverAbandonedRetention,
  serversSupport,
  withProjectLock,
} from '@logbird/database';
import { beginDestructiveMaintenance, reconcileDestructiveMaintenance } from './destructive-maintenance';
import {
  flushProjectBeforeRetention,
  logIngestRecoveryFailure,
  projectInsertsSettled,
  settleProjectInserts,
  settleProjectReceiptsAfterRepair,
} from './ingest-recovery';
import { heartbeatMaintenanceRun } from './project-repair';
import { enqueueProjectRetention } from './queue';
import {
  baselineAtFenceB,
  logBaselineDrift,
  type RetentionVerification,
  readDriftBetweenFences,
  verifyRetentionRuns,
} from './retention-verification';
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
  // The database clock, not this worker's: an instance whose clock runs ahead must not delete inside the window (#268).
  const previewCutoff = new Date((await databaseClock(prisma)).getTime() - current.retentionDays * 86_400_000);
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
    const now = (await databaseClock(tx)).getTime();
    const cutoff = new Date(now - project.retentionDays * 86_400_000);
    // The synchronous purge also rewrites rollups. An unresolved insert must settle before any DELETE or rebuild.
    if (!(await settleProjectInserts(clickhouse, projectId, tx))) throw new ProjectBusyError();
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
          query: "SELECT count() n FROM events WHERE project_id={p:String} AND timestamp < {cutoff:DateTime64(3,'UTC')}",
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
      if (repairing) await settleProjectReceiptsAfterRepair(tagged, projectId, now).catch((error) => logIngestRecoveryFailure(error, projectId));
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

/**
 * A fence time F under the exclusive lock. Every insert accepted before the lock was granted was stamped at or before
 * F; we hold the lock until the clock has passed F's millisecond, so every later insert is stamped strictly after F.
 */
async function fenceClock(db: Prisma.TransactionClient) {
  const fence = await databaseClock(db);
  while ((await databaseClock(db)).getTime() <= fence.getTime()) await new Promise((resolve) => setTimeout(resolve, 1));
  return fence;
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
/**
 * The capability gate (#296, round-1 finding 15), checked at fence A and again right before the first DELETE. Every
 * API server seen in the heartbeat window must declare background retention; a server without it, or no server seen
 * at all (an older server does not heartbeat), selects the synchronous path. A rollback is covered by the same rule.
 */
async function backgroundRetentionAllowed(projectId: string, phase: 'fence_a' | 'fence_b') {
  const support = await serversSupport(BACKGROUND_RETENTION_CAPABILITY);
  if (!support.capable)
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'retention.capability_gate',
        projectId,
        phase,
        serversSeen: support.seen,
        serversMissing: support.missing,
      }),
    );
  return support.capable;
}
/** Test seams: run between the fences, and right after the DELETE mutations exist (before the replacement rows). */
export type BackgroundRetentionHooks = { betweenFences?: () => Promise<void>; afterDeletes?: () => Promise<void> };
/** The hourly sweep's per-project run. Unusual states fall back to (or wait for) the synchronous path. */
export async function runBackgroundRetention(projectId: string, hooks: BackgroundRetentionHooks = {}): Promise<BackgroundRetentionOutcome> {
  await pruneReceiptBackstop(projectId);
  const current = await prisma.project.findUnique({ where: { id: projectId } });
  if (!current) return 'skipped';
  // Runs completed since the last pass (by any caller) get their derived-table check first, outside the lock: a run
  // failed by it sends this pass down the synchronous repair path below.
  await verifyRetentionRuns(clickhouse, projectId, enqueueProjectRetention).catch(() =>
    console.warn(JSON.stringify({ level: 'warn', event: 'retention.verification_unavailable', projectId })),
  );
  const previous = await prisma.retentionRun.findFirst({ where: { projectId, kind: 'retention' }, orderBy: { startedAt: 'desc' } });
  // Earlier DELETEs still finishing (this project's or a stuck table-wide queue): wait for them. A synchronous run would
  // queue a waiting DELETE behind them under the lock, refusing ingest for as long as they take.
  if (previous?.status === RETENTION_MATERIALIZING) {
    // Finished in ClickHouse but not yet completed: complete it here too (the server's reconciler normally does; during
    // a rolling upgrade an older server's does not), then start this hour's run next time.
    await withProjectLock(projectId, () => reconcileDestructiveMaintenance(clickhouse, projectId), { waitMs: 100 }).catch(() => undefined);
    return 'deferred';
  }
  if ((await pendingProjectMutations(clickhouse, projectId)).length) return 'deferred';
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
  const cutoff = retentionCutoff((await databaseClock(prisma)).getTime(), current.retentionDays);
  if (!(await hasExpiredEvents(clickhouse, projectId, cutoff))) {
    if (await recordNothingExpired(projectId, current.retentionDays, cutoff)) return 'nothing_expired';
    await enforceProjectRetention(projectId);
    return 'synchronous';
  }
  if (!(await underPendingBound())) {
    console.warn(JSON.stringify({ level: 'warn', event: 'retention.deferred_pending_deletes', projectId, bound: RETENTION_MAX_PENDING_DELETES }));
    return 'deferred';
  }

  // Fence A. The project's maintenance and export generations are recorded here: any destructive work between the
  // fences (sample removal, a repair, a synchronous purge) bumps one of them, and fence B then refuses to publish rows
  // staged before it (#268).
  let generationsAtA: { maintenance: string; export: string } | undefined;
  const flushError = await flushProjectBeforeRetention(clickhouse, projectId).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'LOGBIRD_FLUSH_UNAVAILABLE')) throw error;
    return error;
  });
  const opened = await withProjectLock(projectId, async (tx) => {
    await recoverAbandonedRetention(tx, projectId);
    const now = await databaseClock(tx);
    await tx.retentionRun.updateMany({
      where: { projectId, kind: 'retention', status: RETENTION_STAGING, heartbeatAt: { lt: new Date(now.getTime() - RETENTION_LEASE_MS) } },
      data: { status: 'canceled', finishedAt: now, error: 'abandoned' },
    });
    if (await tx.retentionRun.findFirst({ where: { projectId, status: { in: ['running', RETENTION_STAGING, RETENTION_MATERIALIZING] } } }))
      return null;
    const project = await tx.project.findUnique({ where: { id: projectId } });
    if (!project || project.retentionDays !== current.retentionDays || project.exportDeleteStartedAt) return null;
    // Capability gate (#296, round-1 finding 15): every API server seen recently must support background retention.
    if (!(await backgroundRetentionAllowed(projectId, 'fence_a'))) return 'incapable' as const;
    if (flushError) {
      await tx.retentionRun.create({
        data: { projectId, retentionDays: project.retentionDays, cutoff, status: 'canceled', finishedAt: now, error: flushError.message },
      });
      return 'canceled' as const;
    }
    if (!(await projectInsertsSettled(projectId, tx))) return 'deferred' as const;
    const fenceA = await fenceClock(tx);
    generationsAtA = { maintenance: String(project.maintenanceGeneration), export: String(project.exportGeneration) };
    return tx.retentionRun.create({
      data: { projectId, retentionDays: project.retentionDays, cutoff, status: RETENTION_STAGING, startedAt: fenceA, heartbeatAt: fenceA },
    });
  });
  if (opened === null) return 'skipped';
  if (opened === 'deferred') return 'deferred';
  if (opened === 'canceled') return 'canceled';
  if (opened === 'incapable') {
    await enforceProjectRetention(projectId);
    return 'synchronous';
  }
  const run = opened;
  const fenceA = run.startedAt;
  const stopHeartbeat = heartbeatMaintenanceRun(run.id);
  const session = createSessionClickHouseClient(`logbird-retention-${run.id}`);
  let mutationsCreated = false;
  // The repair obligation recorded with fence B (round-1 finding 6), and its heartbeat while the run holds it.
  let repairId: string | undefined;
  let verification: RetentionVerification | undefined;
  let stopRepairHeartbeat: (() => void) | undefined;
  try {
    // Between the fences, without a lock: the expensive recompute, from rows that cannot change any more.
    const keys = await retentionAffectedKeys(clickhouse, projectId, cutoff, fenceA);
    const deletedEvents = await retentionDeletedCount(clickhouse, projectId, cutoff, fenceA);
    await stageRetentionRollups(session, projectId, cutoff, fenceA, keys);
    // The expensive derived-table drift reading, outside the lock (round-1 finding 7).
    const driftReading = await readDriftBetweenFences(clickhouse, projectId, cutoff);
    await hooks.betweenFences?.();
    await flushProjectBeforeRetention(clickhouse, projectId);
    // Fence B.
    const outcome = await withProjectLock(projectId, async (tx) => {
      const latest = await tx.retentionRun.findUnique({ where: { id: run.id } });
      if (latest?.status !== RETENTION_STAGING) return 'canceled' as const;
      const project = await tx.project.findUnique({ where: { id: projectId } });
      if (!project || project.retentionDays !== run.retentionDays) {
        await cancelRun(run.id, 'The retention period changed during the run; the next run uses the new period.');
        return 'canceled' as const;
      }
      if (String(project.maintenanceGeneration) !== generationsAtA?.maintenance || String(project.exportGeneration) !== generationsAtA?.export) {
        await cancelRun(run.id, 'Other maintenance changed the project during the run; the next run retries.');
        return 'canceled' as const;
      }
      if (!(await projectInsertsSettled(projectId, tx))) {
        await cancelRun(run.id, 'Recent writes were still settling; the next run retries.');
        return 'canceled' as const;
      }
      // Fence B's delta reaches every row already written: the database clock, or the committed ingest watermark when a
      // row was stamped later than it (round-1 finding 3).
      const clockB = await fenceClock(tx);
      const committed = await committedReceivedAfter(clickhouse, projectId, fenceA);
      const fenceB = committed && committed > clockB ? committed : clockB;
      // Settled and under the lock: the exact minute-bucket drift and the allowance for the earlier reading.
      verification = await baselineAtFenceB(clickhouse, projectId, cutoff, driftReading);
      // Check after the ClickHouse reads, immediately before publishing the destructive fence.
      if (!(await backgroundRetentionAllowed(projectId, 'fence_b'))) {
        await cancelRun(run.id, 'An API server without background retention support is running; retention runs synchronously.');
        return 'incapable' as const;
      }
      // Durable before any DELETE exists: the destructive fence, a new read generation, and `running` (which fences
      // ingest and rollup reads, both waiting on this lock anyway, for the few statements below).
      // The repair obligation commits with them: if this process dies after a DELETE exists but before the
      // replacement rollup rows do, the record outlives it. Its lease expires like the run's (recoverAbandonedRetention
      // marks it failed), a failed ingest_repair keeps every read fenced, and the next retention run rebuilds the
      // rollups. It is removed in the same transaction that records the replacement rows as written.
      repairId = await prisma.$transaction(async (db) => {
        await beginDestructiveMaintenance(projectId, db);
        await db.project.update({ where: { id: projectId }, data: { maintenanceGeneration: { increment: 1 } } });
        await db.retentionRun.update({
          where: { id: run.id },
          data: { status: 'running', heartbeatAt: new Date(), deletedEvents, verification: verification as unknown as Prisma.InputJsonValue },
        });
        const repair = await db.retentionRun.create({
          data: {
            projectId,
            kind: 'ingest_repair',
            retentionDays: run.retentionDays,
            cutoff,
            status: 'running',
            startedAt: fenceB,
            heartbeatAt: new Date(),
            error: 'Retention is replacing rollup rows; if it stops here, the next retention run rebuilds them.',
          },
        });
        return repair.id;
      });
      mutationsCreated = true;
      stopRepairHeartbeat = heartbeatMaintenanceRun(repairId);
      await applyRetention(session, projectId, cutoff, fenceA, fenceB, keys, hooks.afterDeletes);
      await prisma.$transaction([
        prisma.retentionRun.delete({ where: { id: repairId } }),
        prisma.retentionRun.update({ where: { id: run.id }, data: { status: RETENTION_MATERIALIZING, heartbeatAt: new Date() } }),
      ]);
      repairId = undefined;
      console.log(JSON.stringify({ level: 'info', event: 'retention.materializing', runId: run.id, projectId, deletedEvents }));
      return 'materializing' as const;
    });
    if (outcome === 'materializing' && verification) logBaselineDrift(projectId, run.id, verification);
    if (outcome !== 'incapable') return outcome;
    // Nothing destructive happened: this hour's retention runs on the synchronous path instead.
    await enforceProjectRetention(projectId);
    return 'synchronous';
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
      // The obligation recorded at fence B becomes a failed repair (it exists unless the replacement rows were written).
      const repairFailed = {
        status: 'failed',
        finishedAt: new Date(),
        error: 'Retention could not finish its rollup update; the next retention run rebuilds them.',
      };
      await prisma.$transaction([
        prisma.retentionRun.update({
          where: { id: run.id },
          data: { status: 'failed', finishedAt: new Date(), error: 'ClickHouse retention failed; retry required.' },
        }),
        repairId
          ? prisma.retentionRun.update({ where: { id: repairId }, data: repairFailed })
          : prisma.retentionRun.create({ data: { projectId, kind: 'ingest_repair', retentionDays: run.retentionDays, cutoff, ...repairFailed } }),
      ]);
    }
    throw error;
  } finally {
    stopHeartbeat();
    stopRepairHeartbeat?.();
    await dropStagedRetentionRollups(session);
    await session.close().catch(() => undefined);
  }
}
