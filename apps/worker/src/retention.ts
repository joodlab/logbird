import { createMaintenanceClickHouseClient, hasExpiredEvents, projectMaintenance, purgeProject, rebuildProjectRollups } from '@logbird/clickhouse';
import { prisma, pruneIngestReceipts, purgeIngestReceipts, recoverAbandonedRetention, withProjectLock } from '@logbird/database';
import { heartbeatMaintenanceRun } from './project-repair';
export const clickhouse = createMaintenanceClickHouseClient();
export async function enforceProjectRetention(projectId: string) {
  await pruneIngestReceipts(projectId);
  const current = await prisma.project.findUnique({ where: { id: projectId } });
  if (!current) return;
  const previewCutoff = new Date(Date.now() - current.retentionDays * 86_400_000);
  if (!(await hasExpiredEvents(clickhouse, projectId, previewCutoff))) {
    // A shared lock prevents a policy change, without blocking ingest or marking the project unavailable.
    const skipped = await withProjectLock(
      projectId,
      async (tx) => {
        const latest = await tx.project.findUnique({ where: { id: projectId } });
        if (!latest) return true;
        // Any unfinished maintenance defeats the no-op; a completed repair rebuilt every rollup.
        const previous = await tx.retentionRun.findFirst({ where: { projectId }, orderBy: { startedAt: 'desc' } });
        if (latest.retentionDays !== current.retentionDays || (previous && previous.status !== 'completed')) return false;
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
    if (skipped) return;
  }
  return withProjectLock(projectId, async (tx) => {
    await recoverAbandonedRetention(tx, projectId);
    if (await tx.retentionRun.findFirst({ where: { projectId, status: 'running' } })) return;
    const project = await tx.project.findUnique({ where: { id: projectId } });
    if (!project) return;
    // A later successful ingest repair subsumes an earlier failed retention's rollup state.
    const previous = await tx.retentionRun.findFirst({ where: { projectId }, orderBy: { startedAt: 'desc' } });
    const cutoff = new Date(Date.now() - project.retentionDays * 86_400_000);
    const run = await prisma.$transaction(async (db) => {
      await db.project.update({ where: { id: projectId }, data: { maintenanceGeneration: { increment: 1 }, exportGeneration: { increment: 1 } } });
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
      if (
        previous?.status === 'failed' ||
        (await prisma.retentionRun.count({ where: { projectId, kind: 'ingest_repair', status: { in: ['running', 'failed'] } } }))
      )
        await rebuildProjectRollups(tagged, projectId);
      if (await hasExpiredEvents(clickhouse, projectId, cutoff)) throw new Error('Retention cutoff invariant failed');
      await prisma.retentionRun.updateMany({
        where: { projectId, kind: 'ingest_repair', status: { in: ['running', 'failed'] } },
        data: { status: 'completed', finishedAt: new Date(), error: null },
      });
      await prisma.retentionRun.update({
        where: { id: run.id },
        data: { status: 'completed', finishedAt: new Date(), deletedEvents: Number(rows[0]?.n ?? 0) },
      });
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
