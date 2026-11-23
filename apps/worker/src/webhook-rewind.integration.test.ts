import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClickHouseClient, createMaintenanceClickHouseClient, insertEvents, normalizeEvent, purgeProject } from '@logbird/clickhouse';
import { closeProjectLocks, prisma } from '@logbird/database';
import { encryptWebhookSecret, webhookCursorClock } from '@logbird/database/webhooks';
import { generateWebhookSecret } from '@logbird/sdk';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { deliverWebhooks } from './webhook-delivery';
import { discoverWebhookDeliveries } from './webhook-discovery';

const ch = createClickHouseClient();
const runId = randomUUID();
const projectId = `qa-webhook-rewind-${runId}`;
const namespace = process.env.BULLMQ_PREFIX ?? '{logbird-t2w}';
const secretKey = Buffer.alloc(32, 5);

// The statement exactly as documented, with psql's :'name' variables bound as SQL literals.
const documented = (() => {
  const doc = readFileSync(new URL('../../../docs/self-hosting.md', import.meta.url), 'utf8');
  const section = doc.slice(doc.indexOf('### Rewind a webhook cursor after a missed delivery'));
  const block = /```sql\n([\s\S]*?)```/.exec(section)?.[1];
  if (!block?.startsWith('BEGIN;\n')) throw new Error('Documented rewind statement not found');
  return block.slice('BEGIN;\n'.length).trim().replace(/;$/, '');
})();
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
function rewind(variables: Record<string, string>) {
  const sql = documented.replace(/:'(\w+)'/g, (_, name: string) => {
    const value = variables[name];
    if (value === undefined) throw new Error(`Missing psql variable ${name}`);
    return literal(value);
  });
  // Commit only when the statement returned one audit ID, as the procedure says.
  return prisma.$transaction(async (tx) => {
    const ids = await tx.$queryRawUnsafe<{ id: string }[]>(sql);
    if (ids.length !== 1) throw new Error(`Rewind returned ${ids.length} rows; rolled back`);
    return ids;
  });
}

beforeAll(async () => {
  await prisma.organization.create({ data: { id: projectId, name: projectId, slug: projectId, createdAt: new Date() } });
  await prisma.project.create({ data: { id: projectId, organizationId: projectId, name: projectId, slug: projectId } });
});

afterAll(async () => {
  const maintenance = createMaintenanceClickHouseClient();
  try {
    await purgeProject(maintenance, projectId);
  } finally {
    try {
      await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${projectId}` } });
      await prisma.organization.deleteMany({ where: { id: projectId } });
    } finally {
      await Promise.all([ch.close(), maintenance.close(), prisma.$disconnect(), closeProjectLocks()]);
    }
  }
}, 360_000);

it('rewinds a valid cursor past a missed event with the documented SQL and delivers that event once', { timeout: 60_000 }, async () => {
  const received: string[] = [];
  const receiver = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    received.push(JSON.parse(body).id);
    res.writeHead(204).end();
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  try {
    const { port } = receiver.address() as AddressInfo;
    const { now } = await webhookCursorClock(prisma);
    const action = 'qa.webhook.rewind';
    // A new-API endpoint created 3 minutes ago, with a verified starting floor so the ledger's age does not matter.
    const createdAt = new Date(+now - 180_000);
    const floor = new Date(+createdAt - 1000);
    // A rolling-upgrade endpoint whose first cursor was stored 3 ms before creation by a previous-version API.
    const rollingCreatedAt = new Date(+createdAt + 10);
    const rollingStart = new Date(+rollingCreatedAt - 3);
    const endpoint = (data: { createdAt: Date; cursorReceivedAt: Date }) =>
      prisma.webhookEndpoint.create({
        data: {
          ...data,
          projectId,
          url: `http://127.0.0.1:${port}/rewind`,
          filterQuery: `action:${action}`,
          cursorVerifiedFloor: floor,
          secrets: { create: { ciphertext: encryptWebhookSecret(generateWebhookSecret(), secretKey) } },
        },
      });
    const hook = await endpoint({ createdAt, cursorReceivedAt: createdAt });
    const rolling = await endpoint({ createdAt: rollingCreatedAt, cursorReceivedAt: rollingStart });
    const row = (id: string, receivedAt: Date) => {
      const event = normalizeEvent({ action, id }, { projectId, receivedAt });
      if (!event.ok) throw new Error(event.reason);
      return event.row;
    };
    const clock = async () => webhookCursorClock(prisma);
    const refetch = (id: string) => prisma.webhookEndpoint.findUniqueOrThrow({ where: { id } });
    const pass = async () => {
      for (const id of [hook.id, rolling.id]) await discoverWebhookDeliveries(ch, await refetch(id), await clock());
      for (let index = 0; index < 4; index++)
        await deliverWebhooks(
          ch,
          { secretKey, concurrency: 4, perEndpoint: 4, failureLimit: 50, transport: { allowHttp: true, allowAddress: (ip) => ip === '127.0.0.1' } },
          projectId,
        );
    };
    await insertEvents(ch, [row('qa-before', new Date(+createdAt + 1000)), row('qa-after', new Date(+createdAt + 3000))]);
    await pass();
    // The documented incident: an eligible event is admitted behind the committed cursor (previous-version writer
    // overlap, or a PostgreSQL clock step). It is stored, but discovery has already scanned past it.
    const missedAt = new Date(+createdAt + 2000);
    const earlyAt = new Date(+rollingStart + 1);
    await insertEvents(ch, [row('qa-missed', missedAt), row('qa-early-missed', earlyAt)]);
    await pass();
    expect(received.sort()).toEqual(['qa-after', 'qa-after', 'qa-before', 'qa-before']);
    const fields = {
      id: true,
      createdAt: true,
      cursorReceivedAt: true,
      cursorEventId: true,
      lastScannedAt: true,
      cursorReviewRequired: true,
      cursorVerifiedFloor: true,
      updatedAt: true,
    } as const;
    const before = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id }, select: fields });
    const rollingBefore = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: rolling.id }, select: fields });
    expect(before.cursorReviewRequired).toBe(false);
    expect(+before.cursorReceivedAt).toBeGreaterThan(+missedAt);
    const common = { project_id: projectId, evidence_ref: 'qa-incident-rewind', audit_namespace: namespace };
    // eligible_start is no longer part of the procedure. It is still bound so that earlier versions of the statement,
    // which trusted an operator-supplied start up to 60 s before creation, run here unchanged.
    const variables = (endpoint: typeof before, checkpoint: Date, overrides: Record<string, string> = {}) => ({
      ...common,
      endpoint_id: endpoint.id,
      expected_cursor: endpoint.cursorReceivedAt.toISOString(),
      expected_event_id: endpoint.cursorEventId ?? '',
      eligible_start: checkpoint.toISOString(),
      checkpoint: checkpoint.toISOString(),
      ...overrides,
    });
    const refused = (values: Record<string, string>) => expect(rewind(values)).rejects.toThrow('Rewind returned 0 rows');
    // Compare and swap: a stale cursor value changes nothing.
    await refused(variables(before, missedAt, { expected_cursor: new Date(+before.cursorReceivedAt - 1).toISOString() }));
    // Never before the endpoint's start, max(createdAt, starting bound): not 1 ms before a new-API endpoint's creation,
    // not below its floor, and not to a rolling endpoint's earlier first cursor, for which no verified record is stored.
    await refused(variables(before, new Date(+createdAt - 1)));
    await refused(variables(before, new Date(+floor - 1)));
    await refused(variables(rollingBefore, rollingStart));
    await refused(variables(rollingBefore, new Date(+rollingCreatedAt - 1)));
    expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id }, select: fields })).toEqual(before);
    expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: rolling.id }, select: fields })).toEqual(rollingBefore);

    const [audit] = await rewind(variables(before, missedAt));
    // The rolling endpoint rewinds as far as its creation time.
    await rewind(variables(rollingBefore, rollingCreatedAt));
    const after = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id }, select: fields });
    const rollingAfter = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: rolling.id }, select: fields });
    expect(after).toMatchObject({
      cursorReceivedAt: missedAt,
      cursorEventId: null,
      lastScannedAt: before.lastScannedAt,
      cursorReviewRequired: false,
    });
    expect(rollingAfter).toMatchObject({
      cursorReceivedAt: rollingCreatedAt,
      cursorEventId: null,
      lastScannedAt: rollingBefore.lastScannedAt,
      cursorReviewRequired: false,
    });
    const outbox = await prisma.auditOutbox.findUniqueOrThrow({ where: { id: audit?.id ?? '' } });
    expect(outbox).toMatchObject({ namespace, stream: `ws:${projectId}` });
    expect(outbox.payload).toMatchObject({
      action: 'webhook.cursor_rewound',
      metadata: { evidenceRef: 'qa-incident-rewind', previousEventId: before.cursorEventId },
    });

    await pass();
    await pass();
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { endpointId: { in: [hook.id, rolling.id] } },
      select: { endpointId: true, eventId: true, status: true, attemptNumber: true },
      orderBy: [{ endpointId: 'asc' }, { eventId: 'asc' }],
    });
    const settled = await prisma.webhookEndpoint.findMany({ where: { id: { in: [hook.id, rolling.id] } }, select: fields });
    console.log(JSON.stringify({ b1: { before: [before, rollingBefore], after: [after, rollingAfter], settled, deliveries, received } }, null, 2));
    // Each endpoint delivered every event once; the rewind added only the missed one. The rolling endpoint's event from
    // before its creation is not delivered again: that is the documented limit of the procedure.
    expect(received.sort()).toEqual(['qa-after', 'qa-after', 'qa-before', 'qa-before', 'qa-missed', 'qa-missed']);
    expect(deliveries.every(({ status, attemptNumber }) => status === 'succeeded' && attemptNumber === 1)).toBe(true);
    expect(settled.every(({ cursorReviewRequired }) => !cursorReviewRequired)).toBe(true);
  } finally {
    receiver.closeAllConnections();
    await new Promise<void>((done) => receiver.close(() => done()));
  }
});
