import { createClickHouseClient, hasExpiredEvents, purgeProject, rebuildProjectRollups } from '@logbird/clickhouse';
import { prisma, recoverAbandonedRetention, withProjectLock } from '@logbird/database';
export const clickhouse = createClickHouseClient();
export async function enforceProjectRetention(projectId: string) {
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
    const previous = await tx.retentionRun.findFirst({ where: { projectId }, orderBy: { startedAt: 'desc' } });
    const cutoff = new Date(Date.now() - project.retentionDays * 86_400_000);
    const run = await prisma.retentionRun.create({ data: { projectId, retentionDays: project.retentionDays, cutoff, status: 'running' } });
    await prisma.project.update({ where: { id: projectId }, data: { exportGeneration: { increment: 1 } } });
    // Short Prisma statements remain independent of the session holding the project lock.
    const heartbeat = setInterval(() => {
      void prisma.retentionRun
        .updateMany({ where: { id: run.id, status: 'running' }, data: { heartbeatAt: new Date() } })
        .catch(() => console.error(JSON.stringify({ level: 'error', event: 'retention.heartbeat_failed', runId: run.id })));
    }, 30_000);
    try {
      const rows = await (
        await clickhouse.query({
          query: 'SELECT count() n FROM events WHERE project_id={p:String} AND timestamp < {cutoff:DateTime64(3)}',
          query_params: { p: projectId, cutoff: cutoff.toISOString().replace('T', ' ').slice(0, -1) },
          format: 'JSONEachRow',
        })
      ).json<{ n: string }>();
      if (Number(rows[0]?.n ?? 0) > 0) await purgeProject(clickhouse, projectId, cutoff);
      if (previous?.status === 'failed') await rebuildProjectRollups(clickhouse, projectId);
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
      clearInterval(heartbeat);
    }
  });
}
