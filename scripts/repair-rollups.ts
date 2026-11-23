// Rebuilds one project's rollups (minute counts, entities, attribute keys) from its stored events, behind the same
// durable read fence as an ingest repair. For operators after killing a stuck Logbird mutation on a rollup table
// (docs/self-hosting.md, "Stuck retention deletes"). It holds the project's exclusive lock for the rebuild, so the
// project's ingest is refused with 503 project_busy (Retry-After) while it runs.
import { createMaintenanceClickHouseClient } from '@logbird/clickhouse';
import { closeProjectLocks, prisma, withProjectLock } from '@logbird/database';
import { rebuildProjectReadModel } from '../apps/worker/src/project-repair';

const projectId = process.argv[2];
if (!projectId || process.argv.length !== 3 || projectId.startsWith('--'))
  throw new Error('Usage: node --env-file=.env --import tsx scripts/repair-rollups.ts PROJECT');
const clickhouse = createMaintenanceClickHouseClient();
try {
  if (!(await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } }))) throw new Error(`No project ${projectId}`);
  const started = Date.now();
  await withProjectLock(projectId, () => rebuildProjectReadModel(clickhouse, projectId), { waitMs: 30_000 });
  console.log(JSON.stringify({ projectId, rebuilt: true, durationMs: Date.now() - started }));
} finally {
  await clickhouse.close();
  await closeProjectLocks();
  await prisma.$disconnect();
}
