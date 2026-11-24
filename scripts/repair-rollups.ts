// Rebuilds one project's rollups (minute counts, entities, attribute keys) from its stored events, behind the same
// durable read fence as an ingest repair. For operators after killing a stuck Logbird mutation on a rollup table
// (docs/self-hosting.md, "Stuck retention deletes"). It holds the project's exclusive lock for the rebuild, so the
// project's ingest is refused with 503 project_busy (Retry-After) while it runs.
import { closeProjectLocks, prisma, withProjectLock } from '@logbird/database';
import { rebuildProjectReadModel } from '../apps/worker/src/project-repair';
import { closeRetentionQueue } from '../apps/worker/src/queue';
import { clickhouse, settleProjectInserts } from '../apps/worker/src/retention';

try {
  const projectId = process.argv[2];
  if (!projectId || process.argv.length !== 3 || projectId.startsWith('--'))
    throw new Error('Usage: node --env-file=.env --import tsx scripts/repair-rollups.ts PROJECT');
  if (!(await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } }))) throw new Error(`No project ${projectId}`);
  const started = Date.now();
  await withProjectLock(
    projectId,
    async () => {
      if (!(await settleProjectInserts(projectId))) throw new Error('Recent writes are still settling. Retry the rollup rebuild shortly.');
      await rebuildProjectReadModel(clickhouse, projectId);
    },
    { waitMs: 30_000 },
  );
  console.log(JSON.stringify({ projectId, rebuilt: true, durationMs: Date.now() - started }));
} finally {
  await Promise.all([clickhouse.close(), closeRetentionQueue(), closeProjectLocks(), prisma.$disconnect()]);
}
