import { projectMaintenance } from '@logbird/clickhouse';
import { closeProjectLocks, prisma, pruneIngestReceipts, sweepExpiredAuthRecords, sweepIngestReceipts } from '@logbird/database';
import { Queue, Worker } from 'bullmq';
import { env } from './env';
import { logIngestRecoveryFailure, probeIngestRecovery, recoverProjectIngest } from './ingest-recovery';
import { closeRetentionQueue, connection, retentionQueue, retentionQueueName } from './queue';
import { clickhouse, enforceProjectRetention } from './retention';

await probeIngestRecovery(clickhouse);
const worker = new Worker(
  retentionQueueName,
  async (job) => {
    if (job.name === 'retention.project') await enforceProjectRetention(job.data.projectId);
    else if (job.name === 'retention.enforce') {
      await pruneIngestReceipts(); // Includes idle workspace audit streams.
      const failures: unknown[] = [];
      for (const pending of await prisma.ingestReceipt.findMany({
        where: { confirmedAt: null },
        distinct: ['projectId'],
        select: { projectId: true },
      })) {
        try {
          // Tagged per project: deletion can stop a recovery statement left running by a failed call.
          await recoverProjectIngest(projectMaintenance(clickhouse, pending.projectId), pending.projectId);
        } catch (error) {
          logIngestRecoveryFailure(error, pending.projectId);
          failures.push(error);
        }
      }
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
// Separate queue: slow ClickHouse retention must not delay receipt expiry.
const receiptQueueName = 'ingest-receipts';
const receiptQueue = new Queue(receiptQueueName, {
  connection,
  prefix: env.BULLMQ_PREFIX,
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 100, removeOnFail: 100 },
});
await receiptQueue.setGlobalConcurrency(1);
const receiptWorker = new Worker(
  receiptQueueName,
  async (job) => {
    if (job.name === 'auth-records.sweep') {
      // Expired sessions, sign-in codes and invitations (#129): Postgres-only, short batches, so it shares this queue.
      const started = Date.now();
      const result = await sweepExpiredAuthRecords();
      console.log(
        JSON.stringify({
          level: result.limited ? 'warn' : 'info',
          event: 'auth.records_pruned',
          sessions: result.removed.session,
          verifications: result.removed.verification,
          invitations: result.removed.invitation,
          batches: result.batches,
          limited: result.limited,
          durationMs: Date.now() - started,
        }),
      );
      return;
    }
    const started = Date.now();
    const result = await sweepIngestReceipts();
    console.log(
      JSON.stringify({ level: result.limited ? 'warn' : 'info', event: 'ingest.receipts_pruned', ...result, durationMs: Date.now() - started }),
    );
  },
  { connection, prefix: env.BULLMQ_PREFIX, concurrency: 1 },
);
receiptWorker.on('failed', (job) =>
  console.error(
    JSON.stringify({
      level: 'error',
      event: job?.name === 'auth-records.sweep' ? 'auth.records_sweep_failed' : 'ingest.receipt_sweep_failed',
      jobId: job?.id,
    }),
  ),
);
receiptWorker.on('error', () => console.error(JSON.stringify({ level: 'error', event: 'ingest.receipt_worker_error' })));
await receiptQueue.upsertJobScheduler('ingest-receipts-minute', { every: 60_000 }, { name: 'ingest-receipts.prune', data: {} });
await receiptQueue.upsertJobScheduler('auth-records-hourly', { every: 3_600_000 }, { name: 'auth-records.sweep', data: {} });
// Startup sweep uses the same locked recovery path as hourly and on-demand jobs.
for (const run of await prisma.retentionRun.findMany({ where: { status: 'running' }, distinct: ['projectId'], select: { projectId: true } }))
  await retentionQueue.add('retention.project', { projectId: run.projectId });
console.log(JSON.stringify({ level: 'info', event: 'worker.ready' }));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await Promise.all([worker.close(), receiptWorker.close()]);
  await receiptQueue.close();
  const results = await Promise.allSettled([closeRetentionQueue(), closeProjectLocks(), clickhouse.close(), prisma.$disconnect()]);
  if (results.some((r) => r.status === 'rejected')) process.exitCode = 1;
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
