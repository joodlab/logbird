import { createClickHouseClient, purgeProject } from '@trailmark/clickhouse';
import { prisma, withProjectLock } from '@trailmark/database';
export const clickhouse = createClickHouseClient();
export async function enforceProjectRetention(projectId: string) {
  return withProjectLock(projectId, async (tx) => {
    const project = await tx.project.findUnique({ where: { id: projectId } });
    if (!project) return;
    const cutoff = new Date(Date.now() - project.retentionDays * 86_400_000);
    const run = await prisma.retentionRun.create({ data: { projectId, retentionDays: project.retentionDays, cutoff, status: 'running' } });
    try {
      const rows = await (
        await clickhouse.query({
          query: 'SELECT count() n FROM events WHERE project_id={p:String} AND timestamp < {cutoff:DateTime64(3)}',
          query_params: { p: projectId, cutoff: cutoff.toISOString().replace('T', ' ').slice(0, -1) },
          format: 'JSONEachRow',
        })
      ).json<{ n: string }>();
      await purgeProject(clickhouse, projectId, cutoff);
      await prisma.retentionRun.update({
        where: { id: run.id },
        data: { status: 'completed', finishedAt: new Date(), deletedEvents: Number(rows[0]?.n ?? 0) },
      });
    } catch (error) {
      await prisma.retentionRun.update({
        where: { id: run.id },
        data: { status: 'failed', finishedAt: new Date(), error: 'ClickHouse retention failed; retry required.' },
      });
      throw error;
    }
  });
}
