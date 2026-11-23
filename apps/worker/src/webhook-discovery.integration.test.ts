import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient } from '@clickhouse/client';
import { createClickHouseClient, createMaintenanceClickHouseClient, insertEvents, normalizeEvent, purgeProject } from '@logbird/clickhouse';
import { closeProjectLocks, prisma } from '@logbird/database';
import { encryptWebhookSecret, webhookCursorClock } from '@logbird/database/webhooks';
import { generateWebhookSecret } from '@logbird/sdk';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { deliverWebhooks } from './webhook-delivery';
import { discoverWebhookDeliveries, scanWebhooks, webhookEvent } from './webhook-discovery';

const ch = createClickHouseClient();
const runId = randomUUID();
const projectId = `qa-webhook-discovery-${runId}`;
const scanClock = (from: Date) => ({ now: new Date(), rollout: new Date(+from - 1) });

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

it('scans and sends the 33rd endpoint when the first 32 cannot finish their first scan', async () => {
  const { now } = await webhookCursorClock(prisma);
  const from = new Date(+now - 60_000);
  const rollout = new Date(+from - 1000);
  const blockedStart = new Date(+from + 1000);
  const early = new Date(+blockedStart - 11);
  const eventId = 'qa-fair-scan';
  const receiptId = 'qa-fair-scan-pending';
  const received: string[] = [];
  const receiver = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    received.push(JSON.parse(body).id);
    res.writeHead(204).end();
  });
  const blockedIds = Array.from({ length: 32 }, (_, index) => `qa-scan-${runId}-first-${String(index).padStart(2, '0')}`);
  const healthyId = `qa-scan-${runId}-last`;
  const secretKey = Buffer.alloc(32, 7);
  const receiptKey = { projectId, eventId: receiptId };
  try {
    receiver.listen(0, '127.0.0.1');
    await once(receiver, 'listening');
    const { port } = receiver.address() as AddressInfo;
    await prisma.webhookEndpoint.createMany({
      data: blockedIds.map((id) => ({
        id,
        projectId,
        url: 'https://fixture.example.invalid',
        createdAt: blockedStart,
        cursorReceivedAt: early,
        cursorVerifiedFloor: rollout,
      })),
    });
    await prisma.webhookEndpoint.create({
      data: {
        id: healthyId,
        projectId,
        url: `http://127.0.0.1:${port}/test`,
        createdAt: from,
        cursorReceivedAt: from,
        cursorVerifiedFloor: rollout,
        secrets: { create: { ciphertext: encryptWebhookSecret(generateWebhookSecret(), secretKey) } },
      },
    });
    // The pending receipt fences the watermark below the early endpoints' nominal start.
    // The healthy endpoint's event was received before the fence.
    const pendingAt = new Date(+early + 1);
    await prisma.ingestReceipt.create({
      data: { ...receiptKey, organizationId: projectId, fingerprint: 'qa-pending', receivedAt: pendingAt, eventAt: pendingAt },
    });
    const event = normalizeEvent({ action: 'qa.webhook.fair-scan', id: eventId }, { projectId, receivedAt: from });
    if (!event.ok) throw new Error(event.reason);
    await insertEvents(ch, [event.row]);

    const pass = async () => {
      await scanWebhooks(ch);
      await deliverWebhooks(
        ch,
        { secretKey, concurrency: 1, perEndpoint: 1, failureLimit: 50, transport: { allowHttp: true, allowAddress: (ip) => ip === '127.0.0.1' } },
        projectId,
      );
    };
    await pass();
    expect(await queuedIds(healthyId)).toEqual([]);
    // Discovery schedules across projects. The second-pass assertion requires an isolated database.
    await pass();
    expect(received).toEqual([eventId]);
    await pass();
    expect(received).toEqual([eventId]);
    expect(await prisma.webhookDelivery.findMany({ where: { endpointId: healthyId } })).toMatchObject([
      { eventId, status: 'succeeded', attemptNumber: 1 },
    ]);
    const blocked = await prisma.webhookEndpoint.findMany({ where: { id: { in: blockedIds } } });
    expect(blocked).toHaveLength(32);
    for (const hook of blocked) {
      expect(hook).toMatchObject({
        cursorReceivedAt: early,
        cursorEventId: null,
        scanAttemptedAt: expect.any(Date),
        lastScannedAt: null,
        cursorReviewRequired: false,
      });
    }
    expect(await prisma.webhookDelivery.count({ where: { endpointId: { in: blockedIds } } })).toBe(0);
  } finally {
    receiver.closeAllConnections();
    await new Promise<void>((done) => receiver.close(() => done()));
    await prisma.ingestReceipt.deleteMany({ where: receiptKey });
    await prisma.webhookEndpoint.deleteMany({ where: { projectId, id: { in: [...blockedIds, healthyId] } } });
  }
});

it('includes the creation millisecond across delivery batches with the same received_at', async () => {
  const from = new Date(Date.now() - 60_000);
  const { hook, row } = await fixture(from, 'created');
  const ids = Array.from({ length: 105 }, (_, index) => `same-${String(index).padStart(3, '0')}`);
  await insertEvents(ch, [row('before-creation', new Date(+from - 1)), ...ids.map((id) => row(id, from))]);
  await discoverWebhookDeliveries(ch, hook, scanClock(from));
  expect((await refetch(hook.id)).cursorEventId).toBeNull();
  expect(await queuedIds(hook.id)).toEqual(ids);
  await discoverWebhookDeliveries(ch, await refetch(hook.id), scanClock(from));
  expect(await queuedIds(hook.id)).toEqual(ids);
});

it.each([
  { offset: -11, review: false },
  { offset: -59_000, review: false },
  { offset: -61_000, review: true },
  { offset: 180_000, review: true },
])('sets cursor review=$review for a stored cursor $offset ms from creation', async ({ offset, review }) => {
  const start = new Date(Date.now() - 120_000);
  const { hook, row } = await fixture(start, `cursor.${offset}`);
  const early = new Date(+start + offset);
  const endpoint = await prisma.webhookEndpoint.update({ where: { id: hook.id }, data: { cursorReceivedAt: early } });
  if (!review) {
    await insertEvents(ch, [row('before-cursor', new Date(+early - 1)), row('at-cursor', early), row('at-start', start)]);
  }
  const clock = { now: new Date(), rollout: new Date(+start - 180_000) };
  await discoverWebhookDeliveries(ch, endpoint, clock);
  const after = await refetch(hook.id);
  expect(after.cursorReviewRequired).toBe(review);
  if (review) expect(after).toMatchObject({ cursorReceivedAt: early, cursorEventId: null, lastScannedAt: null });
  await discoverWebhookDeliveries(ch, after, clock);
  expect(await queuedIds(hook.id)).toEqual(review ? [] : ['at-cursor', 'at-start']);
  expect((await refetch(hook.id)).cursorReviewRequired).toBe(review);
});

it('keeps an early cursor eligible while waiting for the watermark and after an interrupted early batch', async () => {
  const now = Date.now();
  const start = new Date(now - 120_000);
  const early = new Date(+start - 11);
  const { hook, row } = await fixture(start, 'early-batch');
  const endpoint = await prisma.webhookEndpoint.update({ where: { id: hook.id }, data: { cursorReceivedAt: early } });
  const clock = { now: new Date(now), rollout: new Date(+start - 180_000) };
  const eventId = 'qa-early-pending';
  const receivedAt = new Date(+early + 1);
  await prisma.ingestReceipt.create({
    data: { projectId, eventId, organizationId: projectId, fingerprint: 'qa-pending', receivedAt, eventAt: receivedAt },
  });
  await discoverWebhookDeliveries(ch, endpoint, clock);
  expect(await refetch(hook.id)).toMatchObject({ cursorReceivedAt: early, cursorEventId: null, lastScannedAt: null, cursorReviewRequired: false });
  await prisma.ingestReceipt.delete({ where: { projectId_eventId: { projectId, eventId } } });
  const ids = Array.from({ length: 101 }, (_, index) => `qa-early-${String(index).padStart(3, '0')}`);
  await insertEvents(
    ch,
    ids.map((id) => row(id, early)),
  );
  const transaction = prisma.$transaction.bind(prisma);
  const interrupted = vi.spyOn(prisma, '$transaction').mockImplementation(async (...args) => {
    const result = await Reflect.apply(transaction, prisma, args);
    if (args[1] === undefined) throw new Error('QA interrupted after early delivery commit');
    return result;
  });
  try {
    await expect(discoverWebhookDeliveries(ch, endpoint, clock)).rejects.toThrow('QA interrupted after early delivery commit');
  } finally {
    interrupted.mockRestore();
  }
  const resumed = await refetch(hook.id);
  expect(resumed).toMatchObject({ cursorReceivedAt: early, cursorEventId: ids[99], cursorReviewRequired: false });
  expect(await queuedIds(hook.id)).toEqual(ids.slice(0, 100));
  await discoverWebhookDeliveries(ch, resumed, clock);
  expect(await queuedIds(hook.id)).toEqual(ids);
  expect((await refetch(hook.id)).cursorReviewRequired).toBe(false);
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
  const scan = async () => discoverWebhookDeliveries(limited, await refetch(hook.id), scanClock(from));
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

  await discoverWebhookDeliveries(ch, hook, scanClock(from));
  const first = await refetch(hook.id);
  expect(first).toMatchObject({ cursorReceivedAt: new Date(+from + 5 * 60_000), cursorEventId: null });
  expect(await queuedIds(hook.id)).toEqual(['first-slice']);
  await discoverWebhookDeliveries(ch, first, scanClock(from));
  const second = await refetch(hook.id);
  expect(second).toMatchObject({ cursorReceivedAt: secondEnd, cursorEventId: null });
  expect(await queuedIds(hook.id)).toEqual(['first-slice']);
  await discoverWebhookDeliveries(ch, second, scanClock(from));
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
    await expect(discoverWebhookDeliveries(limited, hook, scanClock(from))).rejects.toThrow('Query exceeded its resource budget');
    expect(await refetch(hook.id)).toMatchObject({
      cursorReceivedAt: from,
      cursorEventId: null,
      scanAttemptedAt: expect.any(Date),
      lastScannedAt: null,
    });
    expect(await queuedIds(hook.id)).toEqual([]);
    await discoverWebhookDeliveries(ch, await refetch(hook.id), scanClock(from));
    expect(await queuedIds(hook.id)).toEqual(ids);
  } finally {
    await limited.close();
  }
});

it('selects the same relative-time matches on an immediate, a delayed and a resumed scan', async () => {
  const { now } = await webhookCursorClock(prisma);
  // In a webhook filter, now is each event's arrival time: the same events match however late discovery runs.
  const endpoint = async (name: string, from: Date) => {
    const action = `qa.webhook.relative.${name}`;
    const hook = await prisma.webhookEndpoint.create({
      data: {
        projectId,
        url: 'https://fixture.example.invalid',
        createdAt: from,
        cursorReceivedAt: from,
        filterQuery: `action:${action} occurredAt:[now-5m TO now]`,
      },
    });
    const row = (id: string, occurredOffsetMs: number) => {
      const normalized = normalizeEvent(
        { action, id, occurredAt: new Date(+from + occurredOffsetMs).toISOString() },
        { projectId, receivedAt: from },
      );
      if (!normalized.ok) throw new Error(normalized.reason);
      return normalized.row;
    };
    return { hook, row };
  };
  // Occurred one minute and zero before arrival match; ten minutes before and one minute after do not.
  const shape = [
    ['inside-1m', -60_000],
    ['inside-0', 0],
    ['outside-10m', -600_000],
    ['outside-future', 60_000],
  ] as const;
  const suffixes = async (endpointId: string, name: string) => (await queuedIds(endpointId)).map((id) => id.slice(name.length + 1));

  // Immediate: the events arrived just behind the watermark and discovery runs right away.
  const immediateFrom = new Date(+now - 20_000);
  const immediate = await endpoint('immediate', immediateFrom);
  // Delayed: the worker was down for twenty minutes after the events arrived.
  const delayedFrom = new Date(+now - 20 * 60_000);
  const delayed = await endpoint('delayed', delayedFrom);
  await insertEvents(ch, [
    ...shape.map(([id, offset]) => immediate.row(`immediate-${id}`, offset)),
    ...shape.map(([id, offset]) => delayed.row(`delayed-${id}`, offset)),
  ]);
  await discoverWebhookDeliveries(ch, immediate.hook, scanClock(immediateFrom));
  await discoverWebhookDeliveries(ch, delayed.hook, scanClock(delayedFrom));
  const expected = ['inside-0', 'inside-1m'];
  expect(await suffixes(immediate.hook.id, 'immediate')).toEqual(expected);
  expect(await suffixes(delayed.hook.id, 'delayed')).toEqual(expected);
  // The send-time recheck uses the same per-event meaning, so a late send still finds each queued event.
  for (const delivery of await prisma.webhookDelivery.findMany({ where: { endpointId: delayed.hook.id } })) {
    if (!delivery.receivedAt) throw new Error('Missing event delivery fixture');
    expect(await webhookEvent(ch, delayed.hook, null, delivery.eventId, delivery.receivedAt)).toMatchObject({ id: delivery.eventId });
  }

  // Resumed: a partial page committed, the worker stopped, and a later scan resumed after the committed position.
  const resumed = await endpoint('resumed', delayedFrom);
  const inside = Array.from({ length: 101 }, (_, index) => `resumed-in-${String(index).padStart(3, '0')}`);
  await insertEvents(ch, [
    ...inside.map((id) => resumed.row(id, -60_000)),
    ...['resumed-out-000', 'resumed-out-050', 'resumed-out-200'].map((id) => resumed.row(id, -600_000)),
  ]);
  const transaction = prisma.$transaction.bind(prisma);
  const interrupted = vi.spyOn(prisma, '$transaction').mockImplementation(async (...args) => {
    const result = await Reflect.apply(transaction, prisma, args);
    if (args[1] === undefined) throw new Error('QA worker stopped after a partial page');
    return result;
  });
  try {
    await expect(discoverWebhookDeliveries(ch, resumed.hook, scanClock(delayedFrom))).rejects.toThrow('QA worker stopped after a partial page');
  } finally {
    interrupted.mockRestore();
  }
  expect(await refetch(resumed.hook.id)).toMatchObject({ cursorReceivedAt: delayedFrom, cursorEventId: inside[99] });
  expect(await queuedIds(resumed.hook.id)).toEqual(inside.slice(0, 100));
  await discoverWebhookDeliveries(ch, await refetch(resumed.hook.id), scanClock(delayedFrom));
  expect(await queuedIds(resumed.hook.id)).toEqual(inside);
});

it('holds an endpoint whose stored regex RE2 cannot compile after one scan, but not on a network failure', async () => {
  const from = new Date(Date.now() - 60_000);
  const { hook, row } = await fixture(from, 're2-size');
  await insertEvents(ch, [row('re2-size-event', from)]);
  // JavaScript and the save-time RE2 check accept this pattern; ClickHouse's RE2 refuses it as too large (code 427).
  // It stands for any stored filter that can never run, including filters saved before the check existed.
  const endpoint = await prisma.webhookEndpoint.update({ where: { id: hook.id }, data: { filterQuery: String.raw`action:/\pL{1000}/` } });
  const unreachable = createClient({ url: 'http://127.0.0.1:9', request_timeout: 2000 });
  try {
    await expect(discoverWebhookDeliveries(unreachable, endpoint, scanClock(from))).rejects.toThrow();
  } finally {
    await unreachable.close();
  }
  expect(await refetch(hook.id)).toMatchObject({ filterReviewRequired: false, filterReviewReason: null, cursorReceivedAt: from });
  const warn = vi.spyOn(console, 'warn');
  try {
    await discoverWebhookDeliveries(ch, await refetch(hook.id), scanClock(from));
    expect(warn.mock.calls.map(([message]) => String(message))).toContainEqual(expect.stringContaining('webhook.filter_invalid'));
  } finally {
    warn.mockRestore();
  }
  expect(await refetch(hook.id)).toMatchObject({
    filterReviewRequired: true,
    filterReviewReason: 'invalid_filter',
    filterReviewNoticeClaimedAt: null,
    cursorReceivedAt: from,
    cursorEventId: null,
    lastScannedAt: null,
  });
  expect(await queuedIds(hook.id)).toEqual([]);
  // A corrected filter (what PATCH stores) resumes from the saved cursor.
  const corrected = await prisma.webhookEndpoint.update({
    where: { id: hook.id },
    data: { filterQuery: String.raw`action:/qa\.webhook\.re2-size/`, filterReviewRequired: false, filterReviewReason: null },
  });
  await discoverWebhookDeliveries(ch, corrected, scanClock(from));
  expect(await queuedIds(hook.id)).toEqual(['re2-size-event']);
});
