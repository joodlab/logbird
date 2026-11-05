import { prisma } from '@trailmark/database';
import { Worker } from 'bullmq';
import { env } from './env';
import { closeRetentionQueue, connection, retentionQueue, retentionQueueName } from './queue';
import { clickhouse, enforceProjectRetention } from './retention';

const worker = new Worker(
  retentionQueueName,
  async (job) => {
    if (job.name === 'retention.project') await enforceProjectRetention(job.data.projectId);
    else if (job.name === 'retention.enforce') {
      for (const project of await prisma.project.findMany({ select: { id: true } })) await enforceProjectRetention(project.id);
    } else throw new Error('Unknown retention job');
  },
  { connection, prefix: env.BULLMQ_PREFIX, concurrency: 1 },
);
worker.on('completed', (job) => console.log(JSON.stringify({ level: 'info', event: 'retention.completed', jobId: job.id, name: job.name })));
worker.on('failed', (job) => console.error(JSON.stringify({ level: 'error', event: 'retention.failed', jobId: job?.id })));
worker.on('error', () => console.error(JSON.stringify({ level: 'error', event: 'worker.error' })));
await retentionQueue.upsertJobScheduler('retention-hourly', { every: 3_600_000 }, { name: 'retention.enforce', data: {} });
console.log(JSON.stringify({ level: 'info', event: 'worker.ready' }));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await worker.close();
  const results = await Promise.allSettled([closeRetentionQueue(), clickhouse.close(), prisma.$disconnect()]);
  if (results.some((r) => r.status === 'rejected')) process.exitCode = 1;
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
