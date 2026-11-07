import { randomUUID } from 'node:crypto';
import { Prisma, prisma } from '@logbird/database';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, vi } from 'vitest';

const { fixtureStreams } = vi.hoisted(() => ({ fixtureStreams: new Set<string>() }));
vi.mock('@logbird/clickhouse', async (original) => {
  const actual = await original<typeof import('@logbird/clickhouse')>();
  return {
    ...actual,
    purgeProject: async (...args: Parameters<typeof actual.purgeProject>) => {
      if (!args[2]) fixtureStreams.add(args[1]);
      return actual.purgeProject(...args);
    },
  };
});

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
    // The shared DB may already contain #62's additive index while this branch still has the old purge helper.
    // Record normal fixture purges without changing runtime assertions; finish optional index cleanup only here.
    if (fixtureStreams.size) {
      const { createClickHouseClient } = await import('@logbird/clickhouse');
      const ch = createClickHouseClient();
      try {
        const tables = await (await ch.query({ query: 'EXISTS TABLE event_ids', format: 'JSONEachRow' })).json<{ result: number }>();
        if (tables[0]?.result)
          for (const id of fixtureStreams)
            await ch.command({
              query: 'ALTER TABLE event_ids DELETE WHERE project_id={p:String}',
              query_params: { p: id },
              clickhouse_settings: { mutations_sync: '2' },
            });
        if (tables[0]?.result) {
          const remaining = await (
            await ch.query({
              query: 'SELECT count() n FROM event_ids WHERE project_id IN {ids:Array(String)}',
              query_params: { ids: [...fixtureStreams] },
              format: 'JSONEachRow',
            })
          ).json<{ n: number }>();
          if (Number(remaining[0]?.n) !== 0) throw new Error('Fixture event-id rows survived cleanup');
        }
      } finally {
        await ch.close();
      }
      const tables = await prisma.$queryRaw<{ name: string | null }[]>`SELECT to_regclass('"IngestReceipt"')::text name`;
      if (tables[0]?.name)
        await prisma.$executeRaw(Prisma.sql`DELETE FROM "IngestReceipt" WHERE "projectId" IN (${Prisma.join([...fixtureStreams])})`);
    }
    await prisma.auditOutbox.deleteMany({ where: { namespace: prefix } });
    await prisma.authAuditWindow.deleteMany({ where: { namespace: prefix } });
    await prisma.authAuditBudget.deleteMany({ where: { namespace: prefix } });
  } finally {
    await queue.close();
    await connection.quit();
  }
});
