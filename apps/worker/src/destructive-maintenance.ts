import { type ClickHouseClient, maintenanceQueryPrefix, pendingProjectMutations, read, retentionRowsRemain } from '@logbird/clickhouse';
import { type Prisma, prisma, purgeIngestReceipts, RETENTION_MATERIALIZING } from '@logbird/database';

/** Caller holds the exclusive project lock. The marker and generation may join an existing short transaction. */
export async function beginDestructiveMaintenance(projectId: string, db: Prisma.TransactionClient = prisma) {
  await db.project.update({
    where: { id: projectId },
    data: { exportDeleteStartedAt: new Date(), exportGeneration: { increment: 1 } },
  });
}

/** Caller holds the exclusive project lock, outside a PG transaction. Failure always leaves the fence intact. */
export async function reconcileDestructiveMaintenance(ch: ClickHouseClient, projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { exportDeleteStartedAt: true } });
  if (!project?.exportDeleteStartedAt) {
    // An older server's reconciler (rolling upgrade) clears the fence without completing background runs.
    if (project) await finishMaterializedRetention(ch, projectId);
    return true;
  }
  // A completed HTTP request is not enough: lightweight DELETE continues as a background mutation.
  // Unknown/unscoped commands conservatively block reconciliation; ordinary project predicates are isolated.
  const pending = await read<{ n: string }>(
    ch,
    `SELECT count() n FROM (
      SELECT query_id FROM system.processes WHERE startsWith(query_id,{prefix:String})
      UNION ALL
      SELECT mutation_id FROM system.mutations WHERE database=currentDatabase() AND is_done=0
        AND table IN ('events','event_ids','events_by_minute','entities','attribute_keys')
        AND (position(command,{project:String})>0 OR position(command,{escaped:String})>0
          OR NOT match(command,'project_id\\\\s*='))
    )`,
    { prefix: maintenanceQueryPrefix(projectId), project: projectId, escaped: projectId.replace(/[\\']/g, '\\$&') },
    2,
  );
  if (Number(pending[0]?.n) !== 0) {
    await flagStuckRetention(ch, projectId);
    return false;
  }
  // Finish the runs first: if verification or the receipt purge fails, the marker stays and the reconciler retries
  // (it selects projects by the marker). It clears only once nothing is left to finish.
  await finishMaterializedRetention(ch, projectId);
  await prisma.project.updateMany({
    where: { id: projectId, exportDeleteStartedAt: project.exportDeleteStartedAt },
    data: { exportDeleteStartedAt: null },
  });
  return true;
}

/** A background retention run whose DELETEs have not finished after this long is reported as failed (they may still finish). */
export const RETENTION_MATERIALIZATION_ALERT_MS = 15 * 60_000;
const STUCK = 'ClickHouse has not finished deleting expired events';

/**
 * The project's DELETE mutations finished: complete each background run that waited for them. The check is a plain
 * read of the stored parts (pending mutations not applied), so a run is completed only when its rows are gone.
 */
async function finishMaterializedRetention(ch: ClickHouseClient, projectId: string) {
  const runs = await prisma.retentionRun.findMany({
    where: { projectId, kind: 'retention', OR: [{ status: RETENTION_MATERIALIZING }, { status: 'failed', error: { startsWith: STUCK } }] },
  });
  if (!runs.length || (await pendingProjectMutations(ch, projectId)).length) return;
  for (const run of runs) {
    // `startedAt` is the run's first fence: it deleted exactly the rows received by then and older than the cutoff.
    if (await retentionRowsRemain(ch, projectId, run.cutoff, run.startedAt)) {
      await prisma.retentionRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error: 'Expired events were still stored after ClickHouse finished deleting; the next run deletes them.',
        },
      });
      console.error(JSON.stringify({ level: 'error', event: 'retention.verification_failed', runId: run.id, projectId }));
      continue;
    }
    await purgeIngestReceipts(projectId, run.cutoff, run.startedAt);
    await prisma.retentionRun.update({ where: { id: run.id }, data: { status: 'completed', finishedAt: new Date(), error: null } });
    console.log(JSON.stringify({ level: 'info', event: 'retention.completed', runId: run.id, projectId, deletedEvents: run.deletedEvents }));
  }
}

/**
 * Still pending: after RETENTION_MATERIALIZATION_ALERT_MS, the run shows as failed in Settings with ClickHouse's reason.
 * Ingest and reads are unaffected (readers apply the pending DELETEs); exports stay refused until the fence clears, and
 * the run completes by itself if the DELETEs finish later.
 */
async function flagStuckRetention(ch: ClickHouseClient, projectId: string) {
  const run = await prisma.retentionRun.findFirst({ where: { projectId, kind: 'retention', status: RETENTION_MATERIALIZING } });
  if (!run || Date.now() - (run.heartbeatAt ?? run.startedAt).getTime() < RETENTION_MATERIALIZATION_ALERT_MS) return;
  const mutations = await pendingProjectMutations(ch, projectId).catch(() => []);
  const failing = mutations.find((m) => m.failReason);
  const reason = failing ? ` (${failing.table}: ${failing.failReason.split('\n')[0]?.slice(0, 200)})` : '';
  await prisma.retentionRun.update({
    where: { id: run.id },
    data: {
      status: 'failed',
      finishedAt: new Date(),
      error: `${STUCK} after 15 minutes${reason}. Ingest and reads continue; see "Stuck retention deletes" in the self-hosting guide.`,
    },
  });
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'retention.materialization_stuck',
      runId: run.id,
      projectId,
      pending: mutations.length,
      failing: failing ? { table: failing.table, mutationId: failing.mutationId } : null,
    }),
  );
}
