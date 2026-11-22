import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClickHouseClient, insertEvents, normalizeEvent, purgeProject } from '@logbird/clickhouse';
import { closeProjectLocks, prisma } from '@logbird/database';
import { encryptWebhookSecret, webhookSecretKey } from '@logbird/database/webhooks';
import { generateWebhookSecret, verifyWebhook } from '@logbird/sdk';
import { Queue, QueueEvents, Worker } from 'bullmq';
import Redis from 'ioredis';
import { expect, it } from 'vitest';
import { claimWebhookDeliveries, deliverWebhooks } from './webhook-delivery';
import { discoverWebhookDeliveries } from './webhook-discovery';
import { sendWebhookDisableNotices } from './webhook-notices';

it('delivers late audit events once, retries across workers, signs tests and disables through the real services', { timeout: 60_000 }, async () => {
  const id = `qa-webhooks-${randomUUID()}`;
  const email = `${id}@example.invalid`;
  expect(['127.0.0.1', 'localhost', '::1']).toContain(process.env.SMTP_HOST);
  const ch = createClickHouseClient();
  const connection = new Redis(process.env.REDIS_URL ?? '', { maxRetriesPerRequest: null });
  const prefix = process.env.BULLMQ_PREFIX ?? '{logbird-t2w}';
  const queue = new Queue(id, { prefix, connection });
  const events = new QueueEvents(id, { prefix, connection });
  const key = webhookSecretKey(process.env.BETTER_AUTH_SECRET ?? '', process.env.WEBHOOK_SECRET_KEY || undefined);
  const primary = generateWebhookSecret();
  const rotated = generateWebhookSecret();
  const started = Date.now();
  const time = (offset: number) => new Date(started + offset);
  const requests: { payload: string; headers: IncomingHttpHeaders }[] = [];
  const responses: (number | 'timeout')[] = [];
  const receiver = createServer((req, res) => {
    req.setEncoding('utf8');
    let payload = '';
    req.on('data', (chunk) => {
      payload += chunk;
    });
    req.on('end', () => {
      requests.push({ payload, headers: req.headers });
      const status = responses.shift() ?? 204;
      if (status !== 'timeout') res.writeHead(status).end(status === 500 ? 'fixture error' : undefined);
    });
  });
  // The transport still uses its real HTTP stack. Only the test hostname may resolve to the loopback fixture.
  const options = {
    secretKey: key,
    concurrency: 4,
    perEndpoint: 2,
    failureLimit: 2,
    transport: {
      allowHttp: true,
      totalTimeoutMs: 400,
      lookup: async (hostname: string) => (hostname === 'webhook-fixture.example.invalid' ? [{ address: '127.0.0.1', family: 4 }] : []),
      allowAddress: (address: string) => address === '127.0.0.1',
    },
  };
  const tick = async () => {
    const worker = new Worker(id, () => deliverWebhooks(ch, options, id), { prefix, connection });
    try {
      await (await queue.add('tick', {})).waitUntilFinished(events, 15_000);
    } finally {
      await worker.close();
    }
  };
  const mailpit = process.env.MAILPIT_URL || 'http://127.0.0.1:8025';
  const mailSearch = async () => {
    const response = await fetch(new URL(`/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`, mailpit));
    expect(response.ok).toBe(true);
    return (await response.json()) as { messages: { ID: string; Subject: string }[] };
  };
  let organizationCreated = false;
  try {
    await events.waitUntilReady();
    receiver.listen(0, '127.0.0.1');
    await once(receiver, 'listening');
    const { port } = receiver.address() as AddressInfo;
    const url = `http://webhook-fixture.example.invalid:${port}/events`;
    await prisma.organization.create({ data: { id, slug: id, name: 'QA webhook workspace', createdAt: time(0) } });
    organizationCreated = true;
    await prisma.project.create({ data: { id, organizationId: id, name: id, slug: id } });
    await prisma.user.create({ data: { id, name: 'QA webhook admin', email } });
    await prisma.member.create({ data: { id, userId: id, organizationId: id, role: 'admin', createdAt: time(0) } });
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        projectId: id,
        url,
        cursorReceivedAt: time(-100_000),
        scopeTenantId: 't1',
        scopeTargetType: 'website',
        scopeTargetId: 'site_a',
        filterQuery: 'action:qa.deliver',
        secrets: {
          create: [{ ciphertext: encryptWebhookSecret(primary, key), expiresAt: time(60_000) }, { ciphertext: encryptWebhookSecret(rotated, key) }],
        },
      },
    });
    const lateTime = time(-60_000);
    const row = (eventId: string, receivedAt: Date, overrides = {}) => {
      const normalized = normalizeEvent(
        {
          id: eventId,
          action: 'qa.deliver',
          tenant: { id: 't1' },
          targets: [{ type: 'website', id: 'site_a' }],
          ...overrides,
        },
        { projectId: id, receivedAt },
      );
      if (!normalized.ok) throw new Error(normalized.reason);
      return normalized.row;
    };
    const first = row('newer-visible', time(-50_000));
    // Store both the raw numeric token and its exact public attribute projection.
    const numericId = '9876543210987654321';
    first.payload = `${first.payload.slice(0, -1)},"numericId":${numericId}}`;
    first.attributes = { ...first.attributes, numericId };
    const delayed = row('late-insert', lateTime);
    await prisma.ingestReceipt.create({
      data: { projectId: id, organizationId: id, eventId: delayed.event_id, eventAt: lateTime, receivedAt: lateTime, fingerprint: 'qa-receipt' },
    });
    await insertEvents(ch, [
      first,
      row('tenant-t2', time(-49_000), { tenant: { id: 't2' } }),
      row('wrong-action', time(-49_000), { action: 'qa.discard' }),
      row('different-targets', time(-49_000), {
        targets: [
          { type: 'website', id: 'x' },
          { type: 'page', id: 'site_a' },
        ],
      }),
    ]);
    await discoverWebhookDeliveries(ch, endpoint);
    expect(await prisma.webhookDelivery.count({ where: { endpointId: endpoint.id } })).toBe(0);
    await insertEvents(ch, [delayed]);
    await prisma.ingestReceipt.update({
      where: { projectId_eventId: { projectId: id, eventId: delayed.event_id } },
      data: { confirmedAt: new Date() },
    });
    const scan = async () => discoverWebhookDeliveries(ch, await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } }));
    await scan();
    await scan();
    await tick();
    await tick();
    expect(requests.map(({ headers }) => headers['webhook-id']).sort()).toEqual(['late-insert', 'newer-visible']);
    expect(requests.find(({ headers }) => headers['webhook-id'] === first.event_id)?.payload).toContain(`"numericId":"${numericId}"`);
    for (const request of requests) {
      expect((request.headers['webhook-signature'] as string).split(' ')).toHaveLength(2);
      for (const secret of [primary, rotated])
        expect(await verifyWebhook({ ...request, secret })).toMatchObject({ id: request.headers['webhook-id'], tenant: { id: 't1' } });
    }
    expect(await prisma.webhookDelivery.count({ where: { endpointId: endpoint.id, status: 'succeeded' } })).toBe(2);

    await prisma.webhookSecret.updateMany({ where: { endpointId: endpoint.id, expiresAt: { not: null } }, data: { expiresAt: time(-1) } });
    const ping = async () =>
      prisma.webhookDelivery.create({
        data: { endpointId: endpoint.id, eventId: randomUUID(), expiresAt: time(86_400_000) },
      });
    const dueNow = async (deliveryId: string, exhausted = false) =>
      prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { nextAttemptAt: new Date(), ...(exhausted ? { retryUntil: time(-1) } : {}) },
      });
    const log = async (deliveryId: string) =>
      prisma.webhookDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
        include: { attempts: { orderBy: { number: 'asc' } } },
      });

    const test = await ping();
    responses.push(500, 'timeout', 204);
    await tick();
    const failed = await log(test.id);
    expect(failed).toMatchObject({
      status: 'pending',
      attempts: [{ number: 1, status: 'failed', responseCode: 500, responseBody: 'fixture error' }],
    });
    expect(failed.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now());
    await tick();
    expect((await log(test.id)).attempts).toHaveLength(1);
    await dueNow(test.id);
    await tick();
    expect((await log(test.id)).attempts[1]).toMatchObject({ number: 2, status: 'failed', error: 'timeout' });
    await dueNow(test.id);
    await tick();
    expect(await log(test.id)).toMatchObject({ status: 'succeeded', attempts: [{ number: 1 }, { number: 2 }, { number: 3, responseCode: 204 }] });
    for (const request of requests.slice(2)) {
      expect(request.headers['webhook-id']).toBe(test.eventId);
      expect((request.headers['webhook-signature'] as string).split(' ')).toHaveLength(1);
      expect(await verifyWebhook({ ...request, secret: rotated })).toMatchObject({ action: 'logbird.webhook.test' });
      await expect(verifyWebhook({ ...request, secret: primary })).rejects.toMatchObject({ reason: 'no_matching_signature' });
    }

    const stranded = await ping();
    await claimWebhookDeliveries(options, id);
    expect(await log(stranded.id)).toMatchObject({ status: 'pending', attempts: [{ number: 1, status: 'sending' }] });
    await prisma.webhookDelivery.update({ where: { id: stranded.id }, data: { leaseUntil: new Date(Date.now() - 1) } });
    await tick();
    expect(await log(stranded.id)).toMatchObject({
      status: 'succeeded',
      attempts: [
        { number: 1, status: 'interrupted' },
        { number: 2, status: 'succeeded' },
      ],
    });
    expect(requests.at(-1)?.headers['webhook-id']).toBe(stranded.eventId);

    const missing = await prisma.webhookDelivery.create({
      data: { endpointId: endpoint.id, eventId: 'no-stored-row', receivedAt: time(-50_000), expiresAt: time(86_400_000) },
    });
    const beforeMissing = requests.length;
    await tick();
    expect(await log(missing.id)).toMatchObject({ status: 'failed', attempts: [{ error: 'event_unavailable' }] });
    expect(requests).toHaveLength(beforeMissing);

    const gone = await ping();
    responses.push(410);
    await tick();
    expect(await log(gone.id)).toMatchObject({ status: 'failed', attempts: [{ responseCode: 410 }] });
    expect(await prisma.webhookEndpoint.findUnique({ where: { id: endpoint.id } })).toMatchObject({ enabled: false, disabledReason: 'gone_410' });
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { enabled: true, disabledReason: null, disabledAt: null, consecutiveFailures: 0, failingSince: null },
    });
    for (const failure of [1, 2]) {
      const terminal = await ping();
      await dueNow(terminal.id, true);
      responses.push(500);
      await tick();
      expect(await log(terminal.id)).toMatchObject({ status: 'failed' });
      expect(await prisma.webhookEndpoint.findUnique({ where: { id: endpoint.id } })).toMatchObject({
        enabled: failure === 1,
        disabledReason: failure === 1 ? null : 'consecutive_failures',
      });
    }
    const audit = await prisma.auditOutbox.findMany({ where: { stream: `ws:${id}` }, orderBy: { createdAt: 'asc' } });
    expect(audit.map(({ payload }) => payload)).toMatchObject([
      { action: 'webhook.disabled', metadata: { webhook: { reason: 'gone_410' } } },
      { action: 'webhook.disabled', metadata: { webhook: { reason: 'consecutive_failures' } } },
    ]);
    await sendWebhookDisableNotices(id);
    await expect
      .poll(async () => (await mailSearch()).messages.map(({ Subject }) => Subject), { timeout: 5000 })
      .toEqual([`A webhook was disabled in ${id}`, `A webhook was disabled in ${id}`]);
  } finally {
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    try {
      await queue.obliterate({ force: true });
      if (organizationCreated) {
        await purgeProject(ch, id);
        await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${id}` } });
        await prisma.organization.deleteMany({ where: { id } });
        await prisma.user.deleteMany({ where: { id } });
        const found = await mailSearch();
        if (found.messages.length) {
          const cleaned = await fetch(new URL('/api/v1/messages', mailpit), {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ IDs: found.messages.map(({ ID }) => ID) }),
          });
          expect(cleaned.ok).toBe(true);
        }
      }
    } finally {
      await Promise.all([queue.close(), events.close(), closeProjectLocks(), prisma.$disconnect(), ch.close()]);
      await connection.quit();
    }
  }
});
