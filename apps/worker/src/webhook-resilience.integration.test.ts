import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient } from '@clickhouse/client';
import { createClickHouseClient, createMaintenanceClickHouseClient, insertEvents, normalizeEvent, purgeProject } from '@logbird/clickhouse';
import { closeProjectLocks, prisma, type WebhookEndpoint } from '@logbird/database';
import { encryptWebhookSecret, WEBHOOK_LOG_RETENTION_MS, webhookSecretKey } from '@logbird/database/webhooks';
import { generateWebhookSecret, verifyWebhook } from '@logbird/sdk';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { deliverWebhooks } from './webhook-delivery';
import { discoverWebhookDeliveries } from './webhook-discovery';
import { pruneWebhookLogs } from './webhook-retention';

const projectId = `qa-webhook-resilience-${randomUUID()}`;
const ch = createClickHouseClient();
const secret = generateWebhookSecret();
const key = webhookSecretKey(process.env.BETTER_AUTH_SECRET ?? '', process.env.WEBHOOK_SECRET_KEY || undefined);
const requests: { path: string; payload: string; headers: IncomingHttpHeaders }[] = [];
const receiver = createServer(async (req, res) => {
  req.setEncoding('utf8');
  let payload = '';
  for await (const chunk of req) payload += chunk;
  const path = req.url ?? '';
  requests.push({ path, payload, headers: req.headers });
  if (path === '/upgrade') res.writeHead(101, { Connection: 'Upgrade', Upgrade: 'qa-fixture' }).end();
  else res.writeHead(204).end();
});

const options = {
  secretKey: key,
  concurrency: 1,
  perEndpoint: 1,
  failureLimit: 2,
  transport: { allowHttp: true, totalTimeoutMs: 1500, allowAddress: (address: string) => address === '127.0.0.1' },
};

async function endpoint(path: string, enabled = true, filterQuery = '') {
  const { port } = receiver.address() as AddressInfo;
  return prisma.webhookEndpoint.create({
    data: {
      projectId,
      url: `http://127.0.0.1:${port}/${path}`,
      enabled,
      filterQuery,
      cursorReceivedAt: new Date(Date.now() - 60_000),
      secrets: { create: { ciphertext: encryptWebhookSecret(secret, key) } },
    },
  });
}

async function storeEvents(ids: string[], receivedAt = new Date(Date.now() - 45_000), action = 'qa.webhook') {
  await insertEvents(
    ch,
    ids.map((id) => {
      const normalized = normalizeEvent({ action, id }, { projectId, receivedAt });
      if (!normalized.ok) throw new Error(normalized.reason);
      return normalized.row;
    }),
  );
  return receivedAt;
}

const enqueue = (hook: WebhookEndpoint, eventId: string, receivedAt: Date) =>
  prisma.webhookDelivery.create({ data: { endpointId: hook.id, eventId, receivedAt, expiresAt: new Date(Date.now() + WEBHOOK_LOG_RETENTION_MS) } });
const log = (id: string) => prisma.webhookDelivery.findUniqueOrThrow({ where: { id }, include: { attempts: { orderBy: { number: 'asc' } } } });
const tick = (client = ch) => deliverWebhooks(client, options, projectId);

beforeAll(async () => {
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  await prisma.organization.create({ data: { id: projectId, slug: projectId, name: projectId, createdAt: new Date() } });
  await prisma.project.create({ data: { id: projectId, organizationId: projectId, slug: projectId, name: projectId } });
});

afterEach(async () => {
  requests.length = 0;
  await prisma.webhookEndpoint.deleteMany({ where: { projectId } });
});

afterAll(async () => {
  receiver.closeAllConnections();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
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

it('settles HTTP 101 as a failed attempt and sends the next delivery to a different endpoint', async () => {
  const time = await storeEvents(['qa-upgrade', 'qa-healthy']);
  const upgrade = await enqueue(await endpoint('upgrade'), 'qa-upgrade', time);
  await tick();
  expect(await log(upgrade.id)).toMatchObject({
    status: 'pending',
    leaseUntil: null,
    attempts: [{ status: 'failed', responseCode: 101, error: 'network_error' }],
  });

  const healthy = await enqueue(await endpoint('healthy'), 'qa-healthy', time);
  await tick();
  expect(await log(healthy.id)).toMatchObject({ status: 'succeeded', attempts: [{ status: 'succeeded', responseCode: 204 }] });
  expect(requests.map(({ path }) => path)).toEqual(['/upgrade', '/healthy']);
});

it('sweeps old terminal records and attempts while an old pending event waits for re-enable', async () => {
  const old = new Date(Date.now() - WEBHOOK_LOG_RETENTION_MS - 10_000);
  await storeEvents(['qa-old'], old);
  const hook = await endpoint('reenabled', false);
  const pending = await prisma.webhookDelivery.create({
    data: {
      endpointId: hook.id,
      eventId: 'qa-old',
      receivedAt: old,
      createdAt: old,
      expiresAt: old,
      nextAttemptAt: old,
      attemptNumber: 1,
      attempts: { create: { number: 1, startedAt: old, status: 'failed' } },
    },
  });
  const terminal = await prisma.webhookDelivery.create({ data: { endpointId: hook.id, eventId: 'qa-expired', status: 'failed', expiresAt: old } });
  await pruneWebhookLogs(new Date(), projectId);
  expect(await prisma.webhookDelivery.findUnique({ where: { id: terminal.id } })).toBeNull();
  expect(await log(pending.id)).toMatchObject({ status: 'pending', attempts: [] });
  await tick();
  expect(requests).toEqual([]);

  await prisma.webhookEndpoint.update({ where: { id: hook.id }, data: { enabled: true } });
  const started = Date.now();
  await tick();
  const sent = await log(pending.id);
  expect(sent).toMatchObject({ status: 'succeeded', attempts: [{ number: 2, status: 'succeeded' }] });
  expect(+sent.expiresAt).toBeGreaterThanOrEqual(started + WEBHOOK_LOG_RETENTION_MS);
  expect(+sent.expiresAt).toBeLessThanOrEqual(Date.now() + WEBHOOK_LOG_RETENTION_MS);
  expect(requests.map(({ headers }) => headers['webhook-id'])).toEqual(['qa-old']);
});

it('preserves signed IDs for queued legacy deliveries with dotted, Unicode, and reserved-prefix IDs', async () => {
  const ids = ['qa.dot', 'qa-مرحبا', 'lb1_cWEuZG90'];
  const time = await storeEvents(ids, undefined, 'qa.webhook.encoded');
  const hook = await endpoint('encoded-ids', true, 'action:qa.webhook.encoded');
  for (const id of ids) await enqueue(hook, id, time);
  for (const _ of ids) await tick();
  expect(requests).toHaveLength(3);
  const headerIds = new Map<string, string>();
  for (const request of requests) {
    const event = await verifyWebhook<{ id: string }>({ ...request, secret });
    const header = request.headers['webhook-id'];
    expect(typeof header).toBe('string');
    if (typeof header === 'string') headerIds.set(event.id, header);
  }
  expect(headerIds).toEqual(
    new Map([
      ['qa.dot', 'lb1_cWEuZG90'],
      ['qa-مرحبا', `lb1_${Buffer.from('qa-مرحبا').toString('base64url')}`],
      ['lb1_cWEuZG90', `lb1_${Buffer.from('lb1_cWEuZG90').toString('base64url')}`],
    ]),
  );
});

it.each([5.3, 10.8])(
  'retries without charging the endpoint when eligibility takes %s seconds in PostgreSQL',
  { timeout: 25_000 },
  async (seconds) => {
    const time = await storeEvents([`qa-slow-eligibility-${seconds}`]);
    const hook = await endpoint('slow-eligibility');
    const delivery = await enqueue(hook, `qa-slow-eligibility-${seconds}`, time);
    let checked = false;
    let eligibility: Promise<unknown> | undefined;
    const delayed = prisma.$extends({
      query: {
        webhookEndpoint: {
          async count({ args, query }) {
            await prisma.$executeRaw`SELECT pg_sleep(${seconds}::double precision)`;
            const count = await query(args);
            checked = count === 1;
            return count;
          },
        },
      },
    });
    const count = vi.spyOn(prisma.webhookEndpoint, 'count').mockImplementation((args) => {
      const query = delayed.webhookEndpoint.count(args);
      eligibility = query.then((result) => result);
      return query;
    });
    try {
      const { totalTimeoutMs: _, ...transport } = options.transport;
      await deliverWebhooks(ch, { ...options, transport }, projectId);
      expect(count).toHaveBeenCalledTimes(1);
      expect(checked).toBe(seconds < 10);
      expect(await log(delivery.id)).toMatchObject({
        status: 'pending',
        leaseUntil: null,
        attempts: [{ error: 'lookup_failed', responseCode: null }],
      });
      const past = new Date(Date.now() - 1000);
      await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: past, retryUntil: past } });
      await tick();
      expect(await log(delivery.id)).toMatchObject({ status: 'failed', attempts: [{ error: 'lookup_failed' }] });
      expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id } })).toMatchObject({
        enabled: true,
        consecutiveFailures: 0,
        failingSince: null,
      });
      expect(await prisma.webhookDisableNotice.count({ where: { endpointId: hook.id } })).toBe(0);
      expect(requests).toEqual([]);
    } finally {
      count.mockRestore();
      await eligibility;
      expect(requests).toEqual([]);
    }
  },
);

it('keeps scan time monotonic and delivers relative-time matches once on a worker clock behind PostgreSQL', async () => {
  const [{ now }] = await prisma.$queryRaw<[{ now: Date }]>`SELECT clock_timestamp() AS now`;
  const from = new Date(+now - 8 * 60_000);
  const action = 'qa.webhook.clock-skew';
  const hook = await endpoint('clock-skew', true, `action:${action} AND occurredAt:[now-5m TO now]`);
  const where = { id: hook.id };
  const refetch = () => prisma.webhookEndpoint.findUniqueOrThrow({ where });
  const queuedIds = async () =>
    (await prisma.webhookDelivery.findMany({ where: { endpointId: hook.id }, orderBy: { eventId: 'asc' } })).map((d) => d.eventId);
  await prisma.webhookEndpoint.update({ where, data: { createdAt: from, cursorReceivedAt: from } });
  await storeEvents(['qa-outside-window'], from, action);
  await storeEvents(['qa-before-failure'], new Date(+from + 4 * 60_000), action);
  await storeEvents(['qa-after-failure'], new Date(+from + 6 * 60_000), action);
  const clock = { now, rollout: new Date(+from - 1) };
  const limited = createClient({
    url: process.env.CLICKHOUSE_URL,
    database: process.env.CLICKHOUSE_DATABASE,
    username: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD,
    clickhouse_settings: { max_bytes_to_read: '1' },
  });
  try {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(from);
    await discoverWebhookDeliveries(ch, await refetch(), clock);
    const committed = await refetch();
    expect(committed).toMatchObject({ cursorReceivedAt: new Date(+from + 5 * 60_000), lastScannedAt: expect.any(Date) });
    expect(await queuedIds()).toEqual(['qa-before-failure']);
    await expect(discoverWebhookDeliveries(limited, committed, clock)).rejects.toThrow('Query exceeded its resource budget');
    const failed = await refetch();
    expect(failed.cursorReceivedAt).toEqual(committed.cursorReceivedAt);
    expect(failed.lastScannedAt?.getTime()).toBeGreaterThanOrEqual(committed.lastScannedAt?.getTime() ?? Number.POSITIVE_INFINITY);
    await discoverWebhookDeliveries(ch, failed, clock);
    expect(await refetch()).toMatchObject({ cursorReviewRequired: false });
    expect(await queuedIds()).toEqual(['qa-after-failure', 'qa-before-failure']);
    // A delayed send is outside the window by its own clock. Recheck at the discovery instant.
    vi.setSystemTime(+now + 8 * 60_000);
    await tick();
    await tick();
    await tick();
    const ids = await Promise.all(requests.map(async (request) => (await verifyWebhook<{ id: string }>({ ...request, secret })).id));
    expect(ids.sort()).toEqual(['qa-after-failure', 'qa-before-failure']);
  } finally {
    vi.useRealTimers();
    await limited.close();
  }
});

it('retries real stored-event lookup errors and expires the claim without starting another attempt', async () => {
  const time = await storeEvents(['qa-lookup']);
  const hook = await endpoint('lookup');
  const delivery = await enqueue(hook, 'qa-lookup', time);
  const limited = createClient({
    url: process.env.CLICKHOUSE_URL,
    database: process.env.CLICKHOUSE_DATABASE,
    username: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD,
    clickhouse_settings: { max_bytes_to_read: '1' },
  });
  try {
    await tick(limited);
    const first = await log(delivery.id);
    expect(first).toMatchObject({ status: 'pending', leaseUntil: null, attempts: [{ status: 'failed', error: 'lookup_failed' }] });
    expect(first.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now());
    await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date() } });
    await tick(limited);
    const second = await log(delivery.id);
    expect(second.attempts.map(({ error }) => error)).toEqual(['lookup_failed', 'lookup_failed']);
    expect(second.retryUntil).toEqual(first.retryUntil);

    const past = new Date(Date.now() - 10_000);
    await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: past, retryUntil: past } });
    await tick();
    expect(await log(delivery.id)).toMatchObject({
      status: 'failed',
      nextAttemptAt: null,
      leaseUntil: null,
      attemptNumber: 2,
      attempts: second.attempts,
    });
    expect(await prisma.webhookEndpoint.findUnique({ where: { id: hook.id } })).toMatchObject({ enabled: true, consecutiveFailures: 0 });
    expect(requests).toEqual([]);
  } finally {
    await limited.close();
  }
});
