import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { afterAll } from 'vitest';

// Each test file gets real Redis storage without sharing rate limits or retention
// jobs with another test file or the contributor's running worker.
const prefix = `{logbird-test-${randomUUID()}}`;
process.env.BULLMQ_PREFIX = prefix;

afterAll(async () => {
  const connection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 1 });
  const queue = new Queue('retention', { connection, prefix });
  try {
    // Only this file's disposable queue; never the shared application queue.
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
    await connection.quit();
  }
});
