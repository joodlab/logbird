import { randomUUID } from 'node:crypto';
import { prisma } from '@logbird/database';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, vi } from 'vitest';

vi.mock('@clickhouse/client', async (original) => {
  const client = await original<typeof import('@clickhouse/client')>();
  return {
    ...client,
    createClient: (options: Parameters<typeof client.createClient>[0]) => client.createClient({ ...options, request_timeout: 300_000 }),
  };
});

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
    await prisma.auditOutbox.deleteMany({ where: { namespace: prefix } });
    await prisma.authAuditWindow.deleteMany({ where: { namespace: prefix } });
    await prisma.authAuditBudget.deleteMany({ where: { namespace: prefix } });
  } finally {
    await queue.close();
    await connection.quit();
  }
});
