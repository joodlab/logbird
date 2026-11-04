import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { env } from './env';
export const retentionQueueName = 'retention';
export const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
export const retentionQueue = new Queue(retentionQueueName, {
  connection,
  prefix: env.BULLMQ_PREFIX,
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 100, removeOnFail: 100 },
});
export const enqueueProjectRetention = (projectId: string) => retentionQueue.add('retention.project', { projectId });
export async function closeRetentionQueue() {
  await retentionQueue.close();
  await connection.quit();
}
