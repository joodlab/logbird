import { createClient } from '@clickhouse/client';
import { prisma } from '@trailmark/database';
import { env } from './env';
export const clickhouse = createClient({
  url: env.CLICKHOUSE_URL,
  database: env.CLICKHOUSE_DATABASE,
  username: env.CLICKHOUSE_USER,
  password: env.CLICKHOUSE_PASSWORD,
});
export async function enforceProjectRetention(projectId: string) {
  // Re-read current policy for delayed/retried jobs; never use a stale retention value.
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return;
  const run = await prisma.retentionRun.create({
    data: { projectId, retentionDays: project.retentionDays, cutoff: new Date(Date.now() - project.retentionDays * 86_400_000), status: 'running' },
  });
  try {
    await clickhouse.command({
      query: 'DELETE FROM events WHERE project_id = {id:String} AND timestamp < now64(3) - toIntervalDay({days:UInt32})',
      query_params: { id: project.id, days: project.retentionDays },
      clickhouse_settings: { lightweight_deletes_sync: '1' },
    });
    await prisma.retentionRun.update({ where: { id: run.id }, data: { status: 'completed', finishedAt: new Date() } });
  } catch (error) {
    const skipped = typeof error === 'object' && error !== null && 'code' in error && String(error.code) === '60';
    await prisma.retentionRun.update({
      where: { id: run.id },
      data: {
        status: skipped ? 'skipped' : 'failed',
        finishedAt: new Date(),
        error: skipped ? 'Events table is not installed yet.' : 'ClickHouse retention command failed.',
      },
    });
    if (!skipped) throw error;
  }
}
