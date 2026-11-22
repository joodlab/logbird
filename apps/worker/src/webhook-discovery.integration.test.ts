import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import { createClickHouseClient, createMaintenanceClickHouseClient, insertEvents, normalizeEvent, purgeProject } from '@logbird/clickhouse';
import { closeProjectLocks, prisma } from '@logbird/database';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { discoverWebhookDeliveries } from './webhook-discovery';

const ch = createClickHouseClient();
const projectId = `qa-webhook-discovery-${randomUUID()}`;

beforeAll(async () => {
  await prisma.organization.create({ data: { id: projectId, name: projectId, slug: projectId, createdAt: new Date() } });
  await prisma.project.create({ data: { id: projectId, organizationId: projectId, name: projectId, slug: projectId } });
});

async function fixture(from: Date, name: string) {
  const action = `qa.webhook.${name}`;
  const hook = await prisma.webhookEndpoint.create({
    data: { projectId, url: 'https://fixture.example.invalid', createdAt: from, cursorReceivedAt: from, filterQuery: `action:${action}` },
  });
  const row = (id: string, receivedAt: Date, occurredAt = receivedAt) => {
    const normalized = normalizeEvent({ action, id, occurredAt: occurredAt.toISOString() }, { projectId, receivedAt });
    if (!normalized.ok) throw new Error(normalized.reason);
    return normalized.row;
  };
  return { hook, row };
}

const refetch = (id: string) => prisma.webhookEndpoint.findUniqueOrThrow({ where: { id } });
const queuedIds = async (endpointId: string) =>
  (await prisma.webhookDelivery.findMany({ where: { endpointId }, select: { eventId: true }, orderBy: { eventId: 'asc' } })).map(
    ({ eventId }) => eventId,
  );

afterAll(async () => {
  const maintenance = createMaintenanceClickHouseClient();
  try {
    await purgeProject(maintenance, projectId);
  } finally {
    try {
      await prisma.organization.deleteMany({ where: { id: projectId } });
    } finally {
      await Promise.all([ch.close(), maintenance.close(), prisma.$disconnect(), closeProjectLocks()]);
    }
  }
}, 360_000);

it('includes the creation millisecond across delivery batches with the same received_at', async () => {
  const from = new Date(Date.now() - 60_000);
  const { hook, row } = await fixture(from, 'created');
  const ids = Array.from({ length: 105 }, (_, index) => `same-${String(index).padStart(3, '0')}`);
  await insertEvents(ch, [row('before-creation', new Date(+from - 1)), ...ids.map((id) => row(id, from))]);
  await discoverWebhookDeliveries(ch, hook);
  expect((await refetch(hook.id)).cursorEventId).toBeNull();
  expect(await queuedIds(hook.id)).toEqual(ids);
  await discoverWebhookDeliveries(ch, await refetch(hook.id));
  expect(await queuedIds(hook.id)).toEqual(ids);
});

it('resumes an interrupted batch and drains 25,000 events in receive-time and ID order', { timeout: 180_000 }, async () => {
  const from = new Date(Date.now() - 7 * 60_000);
  const { hook, row } = await fixture(from, 'drain');
  const expected = Array.from({ length: 25_000 }, (_, index) => ({
    eventId: `qa-drain-${String(index).padStart(5, '0')}`,
    receivedAt: new Date(+from + (index % 3)),
  })).sort((a, b) => +a.receivedAt - +b.receivedAt || a.eventId.localeCompare(b.eventId));
  // Write in reverse order, with thousands of events sharing each stored arrival millisecond.
  await insertEvents(
    ch,
    [...expected].reverse().map(({ eventId, receivedAt }) => row(eventId, receivedAt, new Date(+from - 30 * 86_400_000))),
  );
  const limited = createClient({
    url: process.env.CLICKHOUSE_URL,
    database: process.env.CLICKHOUSE_DATABASE,
    username: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD,
    clickhouse_settings: {
      date_time_input_format: 'best_effort',
      log_comment: projectId,
      max_rows_to_read: '5000000',
      max_result_rows: '10000',
      max_memory_usage: '134217728',
    },
  });
  const scan = async () => discoverWebhookDeliveries(limited, await refetch(hook.id));
  const pairs = () =>
    prisma.webhookDelivery.findMany({
      where: { endpointId: hook.id },
      orderBy: [{ receivedAt: 'asc' }, { eventId: 'asc' }],
      select: { eventId: true, receivedAt: true },
    });
  const expectCursor = async (count: number) => {
    const last = expected[count - 1];
    if (!last) throw new Error('Missing cursor fixture');
    expect(await refetch(hook.id)).toMatchObject({ cursorReceivedAt: last.receivedAt, cursorEventId: last.eventId });
  };
  try {
    const transaction = prisma.$transaction.bind(prisma);
    const interrupted = vi.spyOn(prisma, '$transaction').mockImplementation(async (...args) => {
      const result = await Reflect.apply(transaction, prisma, args);
      // The receipt gate passes a transaction option. Drop the acknowledgement of the first delivery commit.
      if (args[1] === undefined) throw new Error('QA interrupted after delivery commit');
      return result;
    });
    try {
      await expect(scan()).rejects.toThrow('QA interrupted after delivery commit');
    } finally {
      interrupted.mockRestore();
    }
    await expectCursor(100);
    expect(await pairs()).toEqual(expected.slice(0, 100));
    for (const count of [10_100, 20_100]) {
      await scan();
      await expectCursor(count);
      expect(await prisma.webhookDelivery.count({ where: { endpointId: hook.id } })).toBe(count);
    }
    await scan();
    expect(await refetch(hook.id)).toMatchObject({ cursorReceivedAt: new Date(+from + 5 * 60_000 + 2), cursorEventId: null });
    expect(await pairs()).toEqual(expected);
  } finally {
    await limited.close();
  }
});

it('walks five-minute slices across a backlog, including an empty slice and a late occurrence', async () => {
  const from = new Date(Date.now() - 16 * 60_000);
  const { hook, row } = await fixture(from, 'slices');
  const secondEnd = new Date(+from + 10 * 60_000);
  await insertEvents(ch, [row('first-slice', from), row('third-slice', secondEnd, new Date(+secondEnd - 60 * 86_400_000))]);

  await discoverWebhookDeliveries(ch, hook);
  const first = await refetch(hook.id);
  expect(first).toMatchObject({ cursorReceivedAt: new Date(+from + 5 * 60_000), cursorEventId: null });
  expect(await queuedIds(hook.id)).toEqual(['first-slice']);
  await discoverWebhookDeliveries(ch, first);
  const second = await refetch(hook.id);
  expect(second).toMatchObject({ cursorReceivedAt: secondEnd, cursorEventId: null });
  expect(await queuedIds(hook.id)).toEqual(['first-slice']);
  await discoverWebhookDeliveries(ch, second);
  expect(await queuedIds(hook.id)).toEqual(['first-slice', 'third-slice']);
});

it.each([
  { max_rows_to_read: '1', read_overflow_mode: 'break' as const },
  { max_result_rows: '1', result_overflow_mode: 'break' as const },
])('leaves the cursor and delivery table unchanged on ClickHouse overflow with %j', async (clickhouse_settings) => {
  const from = new Date(Date.now() - 60_000);
  const name = 'max_rows_to_read' in clickhouse_settings ? 'read' : 'result';
  const { hook, row } = await fixture(from, name);
  const ids = [`${name}-first`, `${name}-second`];
  await insertEvents(
    ch,
    ids.map((id) => row(id, from)),
  );
  const limited = createClient({
    url: process.env.CLICKHOUSE_URL,
    database: process.env.CLICKHOUSE_DATABASE,
    username: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD,
    clickhouse_settings,
  });
  try {
    await expect(discoverWebhookDeliveries(limited, hook)).rejects.toThrow('Query exceeded its resource budget');
    expect(await refetch(hook.id)).toMatchObject({ cursorReceivedAt: from, cursorEventId: null });
    expect(await queuedIds(hook.id)).toEqual([]);
    await discoverWebhookDeliveries(ch, await refetch(hook.id));
    expect(await queuedIds(hook.id)).toEqual(ids);
  } finally {
    await limited.close();
  }
});
