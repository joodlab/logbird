import { read } from '@logbird/clickhouse';
import { closeProjectLocks, prisma, withProjectLock } from '@logbird/database';
import { clickhouse } from '../apps/server/src/clickhouse';
import { recoverProjectIngest } from '../apps/worker/src/ingest-recovery';

const argument = process.argv[2];
const removeOrphans = process.argv.includes('--delete-orphan-indexes');
if (!argument || (argument !== '--orphan-indexes' && process.argv.length !== 3))
  throw new Error('Usage: node --env-file=.env --import tsx scripts/reconcile-ingest.ts PROJECT | --orphan-indexes [--delete-orphan-indexes]');
async function projectExists(projectId: string) {
  return projectId.startsWith('ws:')
    ? !!(await prisma.organization.findUnique({ where: { id: projectId.slice(3) }, select: { id: true } }))
    : !!(await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } }));
}
try {
  if (argument === '--orphan-indexes') {
    // Report counts before any deletion. Never delete raw rows; preserve indexes for orphan raw evidence.
    const projects = await read<{ project_id: string; rows: number }>(
      clickhouse,
      'SELECT project_id,count() rows FROM event_ids GROUP BY project_id',
    );
    const orphans: { projectId: string; indexRows: number; rawRows: number }[] = [];
    for (const row of projects)
      if (!(await projectExists(row.project_id))) {
        const raw = await read<{ n: number }>(clickhouse, 'SELECT count() n FROM events WHERE project_id={p:String}', { p: row.project_id });
        orphans.push({ projectId: row.project_id, indexRows: Number(row.rows), rawRows: Number(raw[0]?.n ?? 0) });
      }
    console.log(
      JSON.stringify({
        phase: 'counts',
        orphanProjects: orphans,
        indexRows: orphans.reduce((n, r) => n + r.indexRows, 0),
        deleteRequested: removeOrphans,
      }),
    );
    let deletedProjects = 0;
    if (removeOrphans)
      for (const row of orphans.filter((r) => r.rawRows === 0))
        await withProjectLock(row.projectId, async () => {
          if (await projectExists(row.projectId)) return;
          const raw = await read<{ n: number }>(clickhouse, 'SELECT count() n FROM events WHERE project_id={p:String}', { p: row.projectId });
          if (Number(raw[0]?.n ?? 0)) return;
          await clickhouse.command({
            query: 'DELETE FROM event_ids WHERE project_id={p:String}',
            query_params: { p: row.projectId },
            clickhouse_settings: { mutations_sync: '2', lightweight_deletes_sync: '2' },
          });
          deletedProjects++;
        });
    console.log(JSON.stringify({ phase: 'complete', deletedProjects, skippedRawEvidence: orphans.filter((r) => r.rawRows > 0).length }));
  } else {
    await recoverProjectIngest(clickhouse, argument);
    const pending = await prisma.ingestReceipt.count({ where: { projectId: argument, confirmedAt: null, claimedAt: { not: null } } });
    const ready = await prisma.ingestReceipt.count({ where: { projectId: argument, confirmedAt: null, claimedAt: null } });
    console.log(JSON.stringify({ pending, readyForExactRetry: ready }));
  }
} finally {
  await clickhouse.close();
  await closeProjectLocks();
  await prisma.$disconnect();
}
