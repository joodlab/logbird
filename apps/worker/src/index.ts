import { closeProjectLocks, prisma } from '@logbird/database';
import { Worker } from 'bullmq';
import { env } from './env';
import { closeRetentionQueue, connection, retentionQueue, retentionQueueName } from './queue';
import { clickhouse, enforceProjectRetention } from './retention';

const worker = new Worker(
  retentionQueueName,
  async (job) => {
    if (job.name === 'retention.project') await enforceProjectRetention(job.data.projectId);
    else if (job.name === 'retention.enforce') {
      const failures: unknown[] = [];
      for (const project of await prisma.project.findMany({ select: { id: true } })) {
        try {
          await enforceProjectRetention(project.id);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Retention sweep failed for some projects');
    } else throw new Error('Unknown retention job');
  },
  { connection, prefix: env.BULLMQ_PREFIX, concurrency: 1 },
);
worker.on('completed', (job) => console.log(JSON.stringify({ level: 'info', event: 'retention.completed', jobId: job.id, name: job.name })));
worker.on('failed', (job) => console.error(JSON.stringify({ level: 'error', event: 'retention.failed', jobId: job?.id })));
worker.on('error', () => console.error(JSON.stringify({ level: 'error', event: 'worker.error' })));
await retentionQueue.upsertJobScheduler('retention-hourly', { every: 3_600_000 }, { name: 'retention.enforce', data: {} });
// Startup sweep uses the same locked recovery path as hourly and on-demand jobs.
for (const run of await prisma.retentionRun.findMany({ where: { status: 'running' }, distinct: ['projectId'], select: { projectId: true } }))
  await retentionQueue.add('retention.project', { projectId: run.projectId });
console.log(JSON.stringify({ level: 'info', event: 'worker.ready' }));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await worker.close();
  const results = await Promise.allSettled([closeRetentionQueue(), closeProjectLocks(), clickhouse.close(), prisma.$disconnect()]);
  if (results.some((r) => r.status === 'rejected')) process.exitCode = 1;
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
