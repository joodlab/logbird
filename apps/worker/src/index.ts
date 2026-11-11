import { closeProjectLocks, prisma, sweepExpiredAuthRecords, sweepIngestReceipts } from '@logbird/database';
import { Queue, Worker } from 'bullmq';
import { env } from './env';
import { probeIngestRecovery } from './ingest-recovery';
import { closeRetentionQueue, connection, retentionQueue, retentionQueueName } from './queue';
import { runReceiptIndexCompaction } from './receipt-index-compaction';
import { clickhouse, enforceProjectRetention } from './retention';
import { enforceRetention } from './retention-sweep';

await probeIngestRecovery(clickhouse);
const worker = new Worker(
  retentionQueueName,
  async (job) => {
    if (job.name === 'retention.project') await enforceProjectRetention(job.data.projectId);
    else if (job.name === 'retention.enforce') await enforceRetention();
    else throw new Error('Unknown retention job');
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
receiptWorker.on('failed', (job, error) =>
  console.error(
    JSON.stringify({
      level: 'error',
      event: job?.name === 'auth-records.sweep' ? 'auth.records_sweep_failed' : 'ingest.receipt_sweep_failed',
      jobId: job?.id,
      // Prisma prefixes its own preamble, so keep the end of the message, where the database's reason is.
      code: (error as { code?: unknown } | undefined)?.code,
      reason: String(error?.message ?? error)
        .trim()
        .slice(-300),
    }),
  ),
);
receiptWorker.on('error', () => console.error(JSON.stringify({ level: 'error', event: 'ingest.receipt_worker_error' })));
await receiptQueue.upsertJobScheduler('ingest-receipts-minute', { every: 60_000 }, { name: 'ingest-receipts.prune', data: {} });
await receiptQueue.upsertJobScheduler('auth-records-hourly', { every: 3_600_000 }, { name: 'auth-records.sweep', data: {} });
// Recovery and fence lifting have their own worker; an online rebuild cannot occupy their queue.
const compactionQueueName = 'ingest-receipt-index-compaction';
const compactionQueue = new Queue(compactionQueueName, {
  connection,
  prefix: env.BULLMQ_PREFIX,
  defaultJobOptions: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
});
await compactionQueue.setGlobalConcurrency(1);
const compactionAbort = new AbortController();
const compactionWorker = new Worker(
  compactionQueueName,
  async (job) => {
    if (job.name !== 'ingest-receipt-index.compact') throw new Error('Unknown receipt index compaction job');
    await runReceiptIndexCompaction(
      connection,
      `${env.BULLMQ_PREFIX}:ingest-receipt-index-compaction:backoff`,
      job.attemptsMade,
      compactionAbort.signal,
    );
  },
  { connection, prefix: env.BULLMQ_PREFIX, concurrency: 1 },
);
compactionWorker.on('failed', (job) =>
  console.error(JSON.stringify({ level: 'error', event: 'ingest.receipt_index_compaction_job_failed', jobId: job?.id })),
);
compactionWorker.on('error', () => console.error(JSON.stringify({ level: 'error', event: 'ingest.receipt_index_compaction_worker_error' })));
await compactionQueue.upsertJobScheduler(
  'ingest-receipt-index-hourly',
  { every: 3_600_000 },
  { name: 'ingest-receipt-index.compact', data: {}, opts: { attempts: 1 } },
);
// Startup sweep uses the same locked recovery path as hourly and on-demand jobs.
for (const run of await prisma.retentionRun.findMany({ where: { status: 'running' }, distinct: ['projectId'], select: { projectId: true } }))
  await retentionQueue.add('retention.project', { projectId: run.projectId });
console.log(JSON.stringify({ level: 'info', event: 'worker.ready' }));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  // Close the REINDEX connection before waiting for workers; its invalid copy is dropped next run.
  compactionAbort.abort();
  await Promise.all([worker.close(), receiptWorker.close(), compactionWorker.close()]);
  await Promise.all([receiptQueue.close(), compactionQueue.close()]);
  const results = await Promise.allSettled([closeRetentionQueue(), closeProjectLocks(), clickhouse.close(), prisma.$disconnect()]);
  if (results.some((r) => r.status === 'rejected')) process.exitCode = 1;
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
