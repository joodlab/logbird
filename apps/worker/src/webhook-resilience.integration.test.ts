import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient } from '@clickhouse/client';
import { createClickHouseClient, insertEvents, normalizeEvent, purgeProject } from '@logbird/clickhouse';
import { closeProjectLocks, prisma, type WebhookEndpoint } from '@logbird/database';
import { encryptWebhookSecret, WEBHOOK_LOG_RETENTION_MS, webhookSecretKey } from '@logbird/database/webhooks';
import { generateWebhookSecret, verifyWebhook } from '@logbird/sdk';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
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
  try {
    await purgeProject(ch, projectId);
  } finally {
    try {
      await prisma.organization.deleteMany({ where: { id: projectId } });
    } finally {
      await Promise.all([ch.close(), prisma.$disconnect(), closeProjectLocks()]);
    }
  }
}, 120_000);

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

it('signs dotted, Unicode, and reserved-prefix IDs without collisions and verifies original body IDs', async () => {
  const ids = ['qa.dot', 'qa-مرحبا', 'lb1_cWEuZG90'];
  await storeEvents(ids, undefined, 'qa.webhook.encoded');
  const hook = await endpoint('encoded-ids', true, 'action:qa.webhook.encoded');
  await discoverWebhookDeliveries(ch, hook);
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
