import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type ClickHouseClient,
  createClickHouseClient,
  createMaintenanceClickHouseClient,
  insertEvents,
  normalizeEvent,
  purgeProject,
} from '@logbird/clickhouse';
import { closeProjectLocks, prisma } from '@logbird/database';
import { encryptWebhookSecret, webhookCursorClock } from '@logbird/database/webhooks';
import { generateWebhookSecret } from '@logbird/sdk';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { deliverWebhooks } from './webhook-delivery';

const ch = createClickHouseClient();
const runId = randomUUID();
const projects = ['p1', 'p2'].map((name) => `qa-webhook-claims-${name}-${runId}`);
const secretKey = Buffer.alloc(32, 9);
const received: { path: string; id: string }[] = [];
const receiver = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  received.push({ path: req.url ?? '', id: JSON.parse(body).id });
  res.writeHead(204).end();
});
let port = 0;
let eventsInserted = false;

beforeAll(async () => {
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  port = (receiver.address() as AddressInfo).port;
  for (const id of projects) {
    await prisma.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
    await prisma.project.create({ data: { id, organizationId: id, name: id, slug: id } });
  }
});

afterAll(async () => {
  receiver.closeAllConnections();
  await new Promise<void>((done) => receiver.close(() => done()));
  const maintenance = createMaintenanceClickHouseClient();
  try {
    if (eventsInserted) await purgeProject(maintenance, projects[0] ?? '');
  } finally {
    try {
      await prisma.organization.deleteMany({ where: { id: { in: projects } } });
    } finally {
      await Promise.all([ch.close(), maintenance.close(), prisma.$disconnect(), closeProjectLocks()]);
    }
  }
}, 360_000);

const endpoint = (projectId: string, name: string) =>
  prisma.webhookEndpoint.create({
    data: {
      projectId,
      url: `http://127.0.0.1:${port}/${name}`,
      secrets: { create: { ciphertext: encryptWebhookSecret(generateWebhookSecret(), secretKey) } },
    },
  });
const options = (totalTimeoutMs?: number) => ({
  secretKey,
  concurrency: 1,
  perEndpoint: 1,
  failureLimit: 50,
  transport: { allowHttp: true, allowAddress: (address: string) => address === '127.0.0.1', totalTimeoutMs },
});

it('moves a row whose event load outlasts the lease budget back in the queue so another endpoint is delivered', { timeout: 240_000 }, async () => {
  const [projectId = ''] = projects;
  const { now } = await webhookCursorClock(prisma);
  const receivedAt = new Date(+now - 60_000);
  const expiresAt = new Date(+now + 86_400_000);
  const slowEventId = `qa-slow-load-${runId}`;
  const healthyEventId = `qa-healthy-${runId}`;
  const rows = [slowEventId, healthyEventId].map((id) => {
    const event = normalizeEvent({ action: 'qa.webhook.claims', id }, { projectId, receivedAt });
    if (!event.ok) throw new Error(event.reason);
    return event.row;
  });
  eventsInserted = true;
  await insertEvents(ch, rows);
  const slowEndpoint = await endpoint(projectId, 'slow');
  const healthyEndpoint = await endpoint(projectId, 'healthy');
  const initialNext = new Date(+now - 120_000);
  const slow = await prisma.webhookDelivery.create({
    data: { endpointId: slowEndpoint.id, eventId: slowEventId, receivedAt, expiresAt, nextAttemptAt: initialNext },
  });
  const healthy = await prisma.webhookDelivery.create({
    data: { endpointId: healthyEndpoint.id, eventId: healthyEventId, receivedAt, expiresAt, nextAttemptAt: new Date(+now - 60_000) },
  });
  // Only the slow row's event read stalls. It ends early only when the worker aborts it.
  const stalled = new Proxy(ch, {
    get(target, property, proxy) {
      if (property !== 'query') return Reflect.get(target, property, proxy);
      return async (params: Parameters<ClickHouseClient['query']>[0]) => {
        if ((params.query_params as Record<string, unknown> | undefined)?.id === slowEventId)
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 40_000);
            params.abort_signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new Error('QA slow event load aborted'));
              },
              { once: true },
            );
          });
        return target.query(params);
      };
    },
  });
  // A 31-second transport timeout leaves about 1.5 seconds of the two-minute lease for the event load
  // (lease − 56.5 s settlement reserve − two transport timeouts), so the test needs no long wait.
  let passes = 0;
  while (!received.some(({ id }) => id === healthyEventId) && passes < 3) {
    passes++;
    await deliverWebhooks(stalled, options(31_000), projectId);
  }
  expect(received.filter(({ id }) => id === healthyEventId)).toHaveLength(1);
  expect(passes).toBeLessThanOrEqual(2);
  expect(received.some(({ id }) => id === slowEventId)).toBe(false);
  const after = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: slow.id }, include: { attempts: true } });
  expect(after).toMatchObject({ status: 'pending', attemptNumber: 1, leaseUntil: null });
  expect(after.attempts).toMatchObject([{ number: 1, status: 'failed', error: 'lookup_failed' }]);
  const { now: settledAt } = await webhookCursorClock(prisma);
  expect(+(after.nextAttemptAt ?? 0)).toBeGreaterThan(+settledAt);
  expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: healthy.id } })).toMatchObject({ status: 'succeeded', attemptNumber: 1 });
  // A lookup failure is internal: the slow endpoint is not charged toward auto-disable.
  expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: slowEndpoint.id } })).toMatchObject({
    enabled: true,
    consecutiveFailures: 0,
    failingSince: null,
  });
});

it('claims and delivers another project once while the first project claim keeps failing', async () => {
  const [first = '', second = ''] = projects;
  const { now } = await webhookCursorClock(prisma);
  const expiresAt = new Date(+now + 86_400_000);
  const failing = await prisma.webhookDelivery.create({
    data: { endpointId: (await endpoint(first, 'p1')).id, eventId: `qa-p1-${runId}`, expiresAt, nextAttemptAt: new Date(+now - 120_000) },
  });
  const other = await prisma.webhookDelivery.create({
    data: { endpointId: (await endpoint(second, 'p2')).id, eventId: `qa-p2-${runId}`, expiresAt, nextAttemptAt: new Date(+now - 60_000) },
  });
  // Force an error on the first project's row only, in the claim's own write.
  const suffix = randomBytes(4).toString('hex');
  const fn = `qa_fail_claim_${suffix}`;
  const trigger = `qa_fail_claim_${suffix}`;
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA claim failure for project one'; END $$`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER ${trigger} BEFORE UPDATE ON "WebhookDelivery" FOR EACH ROW WHEN (OLD.id = '${failing.id}') EXECUTE FUNCTION ${fn}()`,
  );
  const sent = (id: string) => received.filter((message) => message.id === id).length;
  try {
    await deliverWebhooks(ch, { ...options(), concurrency: 4 }, [first, second]);
    expect(sent(other.eventId)).toBe(1);
    expect(sent(failing.eventId)).toBe(0);
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: failing.id } })).toMatchObject({
      status: 'pending',
      attemptNumber: 0,
      leaseUntil: null,
    });
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trigger} ON "WebhookDelivery"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
  }
  // Once the first project's claim can commit, it is delivered, and the second project's row is not sent again.
  await deliverWebhooks(ch, { ...options(), concurrency: 4 }, [first, second]);
  expect(sent(failing.eventId)).toBe(1);
  expect(sent(other.eventId)).toBe(1);
  expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ status: 'succeeded', attemptNumber: 1 });
});
