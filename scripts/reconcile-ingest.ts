import { closeProjectLocks, prisma } from '@logbird/database';
import { clickhouse } from '../apps/server/src/clickhouse';
import { recoverProjectIngest } from '../apps/worker/src/ingest-recovery';

const projectId = process.argv[2];
if (!projectId || process.argv.length !== 3 || projectId.startsWith('--'))
  throw new Error('Usage: node --env-file=.env --import tsx scripts/reconcile-ingest.ts PROJECT');
try {
  await recoverProjectIngest(clickhouse, projectId);
  const pending = await prisma.ingestReceipt.count({ where: { projectId, confirmedAt: null, claimedAt: { not: null } } });
  const ready = await prisma.ingestReceipt.count({ where: { projectId, confirmedAt: null, claimedAt: null } });
  console.log(JSON.stringify({ pending, readyForExactRetry: ready }));
} finally {
  await clickhouse.close();
  await closeProjectLocks();
  await prisma.$disconnect();
}
