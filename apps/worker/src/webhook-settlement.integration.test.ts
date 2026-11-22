import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClickHouseClient } from '@logbird/clickhouse';
import { closeProjectLocks, prisma } from '@logbird/database';
import { encryptWebhookSecret, WEBHOOK_LOG_RETENTION_MS, webhookSecretKey } from '@logbird/database/webhooks';
import { generateWebhookSecret } from '@logbird/sdk';
import { afterAll, expect, it, vi } from 'vitest';
import { deliverWebhooks } from './webhook-delivery';

vi.hoisted(() => {
  // Set the limit before the worker's Prisma singleton is constructed in this isolated test file.
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.searchParams.set('connection_limit', '1');
  vi.stubEnv('DATABASE_URL', url.toString());
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all([prisma.$disconnect(), closeProjectLocks()]);
});

it('settles a sibling 204 once while a stalled dispatch occupies the only PostgreSQL connection', { timeout: 30_000 }, async () => {
  const projectId = `qa-webhook-settlement-${randomUUID()}`;
  const acknowledged = 'qa-acknowledged';
  const stalled = 'qa-stalled';
  const requests: string[] = [];
  let signalPost!: () => void;
  const posted = new Promise<void>((resolve) => {
    signalPost = resolve;
  });
  let signalLock!: () => void;
  const locked = new Promise<void>((resolve) => {
    signalLock = resolve;
  });
  const receiver = createServer((request, response) => {
    request.resume();
    request.on('end', async () => {
      const id = String(request.headers['webhook-id']);
      requests.push(id);
      if (id === acknowledged) {
        signalPost();
        await locked;
      }
      response.writeHead(204).end();
    });
  });
  const ch = createClickHouseClient();
  const secretKey = webhookSecretKey(process.env.BETTER_AUTH_SECRET ?? '', process.env.WEBHOOK_SECRET_KEY || undefined);
  const ciphertext = encryptWebhookSecret(generateWebhookSecret(), secretKey);
  try {
    receiver.listen(0, '127.0.0.1');
    await once(receiver, 'listening');
    const { port } = receiver.address() as AddressInfo;
    await prisma.organization.create({ data: { id: projectId, slug: projectId, name: projectId, createdAt: new Date() } });
    await prisma.project.create({ data: { id: projectId, organizationId: projectId, slug: projectId, name: projectId } });
    const enqueue = async (eventId: string) => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: { projectId, url: `http://${eventId}.example.invalid:${port}/test`, secrets: { create: { ciphertext } } },
      });
      return prisma.webhookDelivery.create({
        data: { endpointId: endpoint.id, eventId, expiresAt: new Date(Date.now() + WEBHOOK_LOG_RETENTION_MS) },
      });
    };
    const b = await enqueue(acknowledged);
    const a = await enqueue(stalled);
    const log = (id: string) => prisma.webhookDelivery.findUniqueOrThrow({ where: { id }, include: { attempts: { orderBy: { number: 'asc' } } } });
    const options = {
      secretKey,
      concurrency: 2,
      perEndpoint: 1,
      failureLimit: 50,
      transport: {
        allowHttp: true,
        allowAddress: (address: string) => address === '127.0.0.1',
        lookup: async (host: string) => {
          if (host === `${stalled}.example.invalid`) await posted;
          return [{ address: '127.0.0.1', family: 4 as const }];
        },
      },
    };
    let slept = false;
    await deliverWebhooks(
      ch,
      {
        ...options,
        beforeRequest: async (tx, delivery) => {
          if (delivery.id !== a.id) return;
          // B can receive its 204 only once A holds the single connection under the final-check locks.
          signalLock();
          await tx.$executeRaw`SELECT pg_sleep(8.5)`;
          await tx.$queryRaw`SELECT 1`;
          slept = true;
        },
      },
      projectId,
    );
    expect(slept).toBe(true);
    expect(await log(a.id)).toMatchObject({ status: 'pending', attempts: [{ error: 'lookup_failed', responseCode: null }] });
    expect(requests).toEqual([acknowledged]);
    const settled = await log(b.id);
    const past = new Date(Date.now() - 1000);
    await prisma.webhookDelivery.updateMany({
      where: { id: b.id, status: 'pending', leaseUntil: { not: null } },
      data: { leaseUntil: past },
    });
    await deliverWebhooks(ch, options, projectId);

    expect(requests).toEqual([acknowledged]);
    expect(settled).toMatchObject({ status: 'succeeded', leaseUntil: null, attempts: [{ number: 1, status: 'succeeded', responseCode: 204 }] });
    expect(await log(b.id)).toEqual(settled);
  } finally {
    signalLock();
    signalPost();
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    try {
      await prisma.organization.deleteMany({ where: { id: projectId } });
    } finally {
      await ch.close();
    }
  }
});
