import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { ClientRequest, createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fieldMaskKey, insertEvents, normalizeEvent } from '@logbird/clickhouse';
import {
  createWebhookResponseSchema,
  listWebhooksResponseSchema,
  MAX_WEBHOOK_ENDPOINTS,
  SCOPE_MASKS,
  webhookEndpointSchema,
} from '@logbird/contracts';
import { prisma, withProjectLock } from '@logbird/database';
import { decryptWebhookSecret, encryptWebhookSecret, type WebhookLookup, webhookCursorClock, webhookSecretKey } from '@logbird/database/webhooks';
import { generateWebhookSecret, MAX_WEBHOOK_SIGNATURES, verifyWebhook } from '@logbird/sdk';
import { enforceProjectRetention } from '@logbird/worker/retention';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { deliverWebhooks } from '../../worker/src/webhook-delivery';
import { discoverWebhookDeliveries } from '../../worker/src/webhook-discovery';
import { sendWebhookFilterReviewNotices } from '../../worker/src/webhook-notices';
import { app } from './app';
import { clickhouse, purgeProjectEvents } from './clickhouse';
import { env } from './env';
import { immutableFixture } from './immutable-fixture';
import { loadWebhookReconciliation } from './webhook-reconciliation-fixture';

const control = vi.hoisted(() => ({ failAudit: false, lookup: undefined as WebhookLookup | undefined }));
vi.mock('@logbird/database/webhooks', async (original) => {
  const webhooks = await original<typeof import('@logbird/database/webhooks')>();
  return {
    ...webhooks,
    validateWebhookUrl: (url: string, allowHttp?: boolean, lookup?: WebhookLookup, organizationId?: string) =>
      webhooks.validateWebhookUrl(url, allowHttp, control.lookup ?? lookup, organizationId),
  };
});
vi.mock('@logbird/database', async (original) => {
  const db = await original<typeof import('@logbird/database')>();
  return {
    ...db,
    storeAuditEvent: async (...args: Parameters<typeof db.storeAuditEvent>) => {
      if (control.failAudit) throw new Error('QA outbox failure');
      return db.storeAuditEvent(...args);
    },
  };
});
const org = `qa-webhooks-${randomUUID()}`,
  otherOrg = `qa-webhooks-foreign-${randomUUID()}`;
const users: string[] = [];
const cookies: Record<string, string> = {};
let projectId = '',
  siblingId = '',
  foreignId = '';
const receiver = 'https://8.8.8.8/qa-events?token=qa-private-token';
const base = () => `/api/projects/${projectId}/webhooks`;
const request = (path: string, method = 'GET', body?: unknown, role = 'owner') =>
  app.request(path, {
    method,
    headers: { cookie: cookies[role] ?? '', Origin: env.APP_URL, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function create(role = 'owner', input: unknown = { url: receiver }) {
  const response = await request(base(), 'POST', input, role);
  expect(response.status, await response.clone().text()).toBe(201);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return createWebhookResponseSchema.parse(await response.json());
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withLocalReceiver(
  endpointId: string,
  work: (received: { headers: IncomingHttpHeaders; payload: string }[]) => Promise<void>,
  { hostname = '127.0.0.1', beforeRespond }: { hostname?: string; beforeRespond?: () => Promise<void> } = {},
) {
  const received: { headers: IncomingHttpHeaders; payload: string }[] = [];
  const receiver = createServer(async (req, res) => {
    req.setEncoding('utf8');
    let payload = '';
    for await (const chunk of req) payload += chunk;
    received.push({ headers: req.headers, payload });
    await beforeRespond?.();
    res.writeHead(204).end();
  });
  try {
    receiver.listen(0, '127.0.0.1');
    await once(receiver, 'listening');
    const { port } = receiver.address() as AddressInfo;
    await prisma.webhookEndpoint.update({ where: { id: endpointId }, data: { url: `http://${hostname}:${port}/test` } });
    await work(received);
  } finally {
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
}

const send = (project = projectId, overrides: Partial<Parameters<typeof deliverWebhooks>[1]> = {}) =>
  deliverWebhooks(
    clickhouse,
    {
      secretKey: webhookSecretKey(env.BETTER_AUTH_SECRET, env.WEBHOOK_SECRET_KEY),
      maskKey: fieldMaskKey(env.BETTER_AUTH_SECRET),
      concurrency: 1,
      perEndpoint: 1,
      failureLimit: 50,
      ...overrides,
      transport: { allowHttp: true, allowAddress: (address) => address === '127.0.0.1', ...overrides.transport },
    },
    project,
  );
beforeAll(async () => {
  for (const id of [org, otherOrg]) await prisma.organization.create({ data: { id, name: 'QA Webhooks', slug: id, createdAt: new Date() } });
  for (const role of ['owner', 'admin', 'member', 'viewer', 'unknown', 'outsider', 'foreign-owner']) {
    const id = `qa-webhooks-${randomUUID()}`;
    users.push(id);
    await prisma.user.create({ data: { id, name: `QA Webhook ${role}`, email: `${id}@example.invalid` } });
    const activeOrganizationId = role === 'foreign-owner' ? otherOrg : org;
    if (role !== 'outsider')
      await prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId: activeOrganizationId,
          userId: id,
          role: role === 'foreign-owner' ? 'owner' : role,
          createdAt: new Date(),
        },
      });
    const token = randomUUID();
    await prisma.session.create({
      data: { id: randomUUID(), userId: id, token, activeOrganizationId, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    cookies[role] =
      `logbird.session_token=${encodeURIComponent(`${token}.${createHmac('sha256', env.BETTER_AUTH_SECRET).update(token).digest('base64')}`)}`;
  }
  for (const [index, organizationId] of [org, org, otherOrg].entries()) {
    const project = await prisma.project.create({ data: { organizationId, name: 'QA Webhooks', slug: `qa-webhooks-${index}` } });
    if (index === 0) projectId = project.id;
    else if (index === 1) siblingId = project.id;
    else foreignId = project.id;
  }
});
beforeEach(async () => {
  control.failAudit = false;
  await prisma.webhookEndpoint.deleteMany({ where: { projectId } });
  await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${org}` } });
});
afterAll(async () => {
  control.failAudit = false;
  await prisma.organization.deleteMany({ where: { id: { in: [org, otherOrg] } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.auditOutbox.deleteMany({ where: { stream: { in: [`ws:${org}`, `ws:${otherOrg}`] } } });
});

it('creates, lists, reads, patches and deletes configuration; exposes the encrypted secret only once', async () => {
  const { endpoint, secret } = await create('owner', {
    url: receiver,
    description: 'QA receiver',
    filterQuery: 'action:qa.*',
    scope: { tenantId: 'qa-t1', target: { type: 'invoice', id: 'qa-1' } },
  });
  expect(secret).toMatch(/^whsec_/);
  const saved = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
  expect(saved.cursorReceivedAt.toISOString()).toBe(endpoint.createdAt);
  expect(endpoint).toMatchObject({
    enabled: true,
    disabledAt: null,
    disabledReason: null,
    filterQuery: 'action:qa.*',
    scope: { tenantId: 'qa-t1', target: { type: 'invoice', id: 'qa-1' } },
  });
  const stored = await prisma.webhookSecret.findFirstOrThrow({ where: { endpointId: endpoint.id } });
  expect(stored.ciphertext).not.toContain(secret);
  expect(decryptWebhookSecret(stored.ciphertext, webhookSecretKey(env.BETTER_AUTH_SECRET, env.WEBHOOK_SECRET_KEY))).toBe(secret);
  for (const path of [base(), `${base()}/${endpoint.id}`]) {
    const response = await request(path);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/secret|ciphertext|whsec_/i);
    expect(text).not.toContain(secret);
    if (path === base()) expect(listWebhooksResponseSchema.parse(JSON.parse(text)).data).toHaveLength(1);
    else webhookEndpointSchema.parse(JSON.parse(text));
  }
  const updated = await request(`${base()}/${endpoint.id}`, 'PATCH', {
    description: null,
    filterQuery: '',
    scope: null,
    url: 'https://1.1.1.1/qa-updated?token=qa-next-token',
  });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({ description: null, filterQuery: '', scope: null });
  const untouched = await request(`${base()}/${endpoint.id}`, 'PATCH', { description: 'QA updated' });
  expect(await untouched.json()).toMatchObject({ scope: null, filterQuery: '' });
  expect((await request(`${base()}/${endpoint.id}`, 'DELETE')).status).toBe(204);
  expect((await request(`${base()}/${endpoint.id}`)).status).toBe(404);
  expect(await prisma.webhookSecret.count({ where: { endpointId: endpoint.id } })).toBe(0);
});

it('returns a retryable 503 for PATCH, disable and rotation during a locked dispatch', async () => {
  const { endpoint } = await create();
  const path = `${base()}/${endpoint.id}`;
  const dispatch = deferred<void>();
  const release = deferred<void>();
  const blocker = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "WebhookEndpoint" WHERE id = ${endpoint.id} FOR SHARE`;
      dispatch.resolve();
      await release.promise;
    },
    { timeout: 20_000 },
  );
  try {
    await dispatch.promise;
    for (const [route, method, body] of [
      [path, 'PATCH', { description: 'qa-new-description' }],
      [path, 'PATCH', { enabled: false }],
      [`${path}/rotate-secret`, 'POST', { overlapSeconds: 0 }],
    ] as const) {
      const response = await request(route, method, body);
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('3');
      expect(await response.json()).toMatchObject({ error: { code: 'webhook_mutation_busy' } });
    }
    expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } })).toMatchObject({ enabled: true, description: null });
    expect(await prisma.webhookSecret.count({ where: { endpointId: endpoint.id } })).toBe(1);
  } finally {
    release.resolve();
    await blocker;
  }
  expect((await request(path, 'PATCH', { enabled: false })).status).toBe(200);
});

it('holds legacy filters and resumes the reviewed matches without moving the held cursors', async () => {
  const cases = [
    { legacy: 'record:site:12', confirmed: 'attr.record:"site:12"', id: 'qa-legacy-attribute', record: 'site:12' },
    { legacy: String.raw`qaTag:team\*`, confirmed: String.raw`qaTag:team\*`, id: 'qa-legacy-star', qaTag: 'team*' },
    { legacy: String.raw`qaLine:"a\rb"`, confirmed: String.raw`qaLine:"a\rb"`, id: 'qa-legacy-cr', qaLine: 'a\rb' },
    { legacy: 'qaNumber:1e-7', confirmed: 'qaNumber:0.0000001', id: 'qa-legacy-number', qaNumber: 1e-7 },
  ];
  const target = { id: 'qa-new-target', targets: [{ type: 'site', id: '12' }] };
  const time = new Date(Date.now() - 45_000);
  const cursorReceivedAt = new Date(+time - 1000);
  const expiresAt = new Date(Date.now() + 86_400_000);
  const lookup = (id: string) => prisma.webhookEndpoint.findUniqueOrThrow({ where: { id } });
  const warning = 'webhook_filter_review_required';
  const { endpoint: current, secret } = await create('owner', { url: receiver, filterQuery: 'record:site:12' });
  const { endpoint: empty } = await create();
  expect(await lookup(empty.id)).toMatchObject({ filterReviewRequired: false, filterReviewNoticeClaimedAt: null });
  expect(current).not.toHaveProperty('filterWarning');
  const legacy: { id: string; fixture: (typeof cases)[number] }[] = [];
  for (const fixture of cases) {
    const { endpoint } = await create('owner', { url: receiver, filterQuery: fixture.legacy });
    legacy.push({ id: endpoint.id, fixture });
    await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { filterReviewRequired: true, cursorReceivedAt, createdAt: cursorReceivedAt },
    });
  }
  try {
    await withLocalReceiver(current.id, async (received) => {
      const liveReceiver = (await lookup(current.id)).url;
      await prisma.webhookEndpoint.update({ where: { id: current.id }, data: { cursorReceivedAt, createdAt: cursorReceivedAt } });
      const rows = [...cases.map(({ legacy: _before, confirmed: _after, ...event }) => event), target].map((event) => {
        const result = normalizeEvent({ ...event, action: 'qa.filter-review' }, { projectId, receivedAt: time });
        if (!result.ok) throw new Error(result.reason);
        return result.row;
      });
      await insertEvents(clickhouse, rows);
      // A queued event also stays pending while the saved filter is held.
      const [first] = legacy;
      if (!first) throw new Error('Missing legacy filter fixture');
      const queued = await prisma.webhookDelivery.create({
        data: { endpointId: first.id, eventId: first.fixture.id, receivedAt: time, expiresAt },
      });
      for (const { id } of legacy) {
        await prisma.webhookEndpoint.update({ where: { id }, data: { url: liveReceiver } });
        const path = `${base()}/${id}`;
        expect(await (await request(path)).json()).toMatchObject({ filterWarning: warning });
        expect((await request(`${path}/test`, 'POST')).status).toBe(409);
        await discoverWebhookDeliveries(clickhouse, await lookup(id));
        expect(await lookup(id)).toMatchObject({ cursorReceivedAt, cursorEventId: null, lastScannedAt: null });
      }
      const list = listWebhooksResponseSchema.parse(await (await request(base())).json()).data;
      expect(
        list
          .filter((endpoint) => endpoint.filterWarning === warning)
          .map(({ id }) => id)
          .sort(),
      ).toEqual(legacy.map(({ id }) => id).sort());
      await send();
      expect(received).toHaveLength(0);
      expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: queued.id } })).toMatchObject({ status: 'pending', attemptNumber: 0 });
      await discoverWebhookDeliveries(clickhouse, await lookup(current.id));
      await send();
      expect(received).toHaveLength(1);
      const [targetWire] = received;
      if (!targetWire) throw new Error('Missing target delivery');
      expect(await verifyWebhook<{ id: string }>({ ...targetWire, secret })).toMatchObject({ id: target.id });

      for (const [index, { id, fixture }] of legacy.entries()) {
        const path = `${base()}/${id}`;
        const patch = await request(path, 'PATCH', { filterQuery: fixture.confirmed });
        expect(patch.status, await patch.clone().text()).toBe(200);
        expect(await patch.json()).not.toHaveProperty('filterWarning');
        expect(await lookup(id)).toMatchObject({ filterReviewRequired: false, cursorReceivedAt });
        await discoverWebhookDeliveries(clickhouse, await lookup(id));
        await send();
        await send();
        expect(received).toHaveLength(index + 2);
        const wire = received.at(-1);
        expect(wire && JSON.parse(wire.payload)).toMatchObject({ id: fixture.id });
        const updates = await prisma.auditOutbox.findMany({
          where: { stream: `ws:${org}`, payload: { path: ['action'], equals: 'webhook.updated' } },
        });
        expect(updates.map(({ payload }) => payload)).toContainEqual(
          expect.objectContaining({ targets: expect.arrayContaining([{ type: 'webhook', id }]), changes: [{ field: 'filterQuery' }] }),
        );
      }
    });
  } finally {
    await purgeProjectEvents(projectId);
  }
});

it('sends one filter-review email per held endpoint across repeated worker passes', async () => {
  expect(['127.0.0.1', 'localhost', '::1']).toContain(process.env.SMTP_HOST);
  const mailpit = process.env.MAILPIT_URL || 'http://127.0.0.1:8025';
  const administrators = await Promise.all(
    users.slice(0, 2).map(async (id) => (await prisma.user.findUniqueOrThrow({ where: { id }, select: { email: true } })).email),
  );
  const fixture = `qa-notice-${projectId}`;
  const search = async () => {
    const response = await fetch(new URL(`/api/v1/search?query=${encodeURIComponent(fixture)}`, mailpit));
    expect(response.ok).toBe(true);
    const { messages } = (await response.json()) as { messages: { ID: string; Subject: string; Bcc: { Address: string }[] }[] };
    return messages.filter(({ Subject }) => Subject === 'Review a webhook filter');
  };
  const held: string[] = [];
  try {
    for (const description of ['qa-legacy-first', 'qa-legacy-second']) {
      const { endpoint } = await create('owner', { url: receiver, filterQuery: 'record:site:12', description: `${fixture} ${description}` });
      await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { filterReviewRequired: true } });
      held.push(endpoint.id);
    }
    const { endpoint: current } = await create('owner', { url: receiver, filterQuery: 'record:site:12', description: `${fixture} qa-new-endpoint` });
    await Promise.all([sendWebhookFilterReviewNotices(projectId), sendWebhookFilterReviewNotices(projectId)]);
    await sendWebhookFilterReviewNotices(projectId);
    const messages = await search();
    expect(messages).toHaveLength(2);
    for (const { Bcc } of messages) expect(Bcc.map(({ Address }) => Address).sort()).toEqual(administrators.sort());
    const bodies = await Promise.all(
      messages.map(async ({ ID }) => {
        const response = await fetch(new URL(`/api/v1/message/${ID}`, mailpit));
        expect(response.ok).toBe(true);
        return ((await response.json()) as { Text: string }).Text;
      }),
    );
    expect(bodies.join('\n')).toMatch(/qa-legacy-first/);
    expect(bodies.join('\n')).toMatch(/qa-legacy-second/);
    for (const body of bodies) {
      expect(body).toContain('8.8.8.8');
      expect(body).toContain('Deliveries are paused');
      expect(body).toContain(`/p/${projectId}/settings/webhooks`);
      expect(body).not.toContain('qa-private-token');
    }
    expect(await prisma.webhookEndpoint.count({ where: { id: { in: held }, filterReviewNoticeClaimedAt: { not: null } } })).toBe(2);
    for (const id of held) {
      expect((await request(`${base()}/${id}`, 'PATCH', { filterQuery: 'record:site:12' })).status).toBe(200);
    }
    await sendWebhookFilterReviewNotices(projectId);
    expect((await search()).map(({ ID }) => ID).sort()).toEqual(messages.map(({ ID }) => ID).sort());
    expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: current.id } })).toMatchObject({ filterReviewNoticeClaimedAt: null });
  } finally {
    const messages = await search();
    if (messages.length) {
      const response = await fetch(new URL('/api/v1/messages', mailpit), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ IDs: messages.map(({ ID }) => ID) }),
      });
      expect(response.ok).toBe(true);
    }
  }
});

it('retries settlement of a known 204 under the same claim without posting again', async () => {
  const { endpoint } = await create();
  expect((await request(`${base()}/${endpoint.id}/test`, 'POST')).status).toBe(202);
  const transaction = vi.spyOn(prisma, '$transaction');
  try {
    await withLocalReceiver(
      endpoint.id,
      async (received) => {
        await send();
        await send();
        expect(received).toHaveLength(1);
        expect(await prisma.webhookDelivery.findFirstOrThrow({ where: { endpointId: endpoint.id }, include: { attempts: true } })).toMatchObject({
          status: 'succeeded',
          attemptNumber: 1,
          leaseUntil: null,
          attempts: [{ number: 1, status: 'succeeded', responseCode: 204 }],
        });
      },
      {
        beforeRespond: async () => {
          transaction.mockRejectedValueOnce(new Error('QA transient database error after POST'));
        },
      },
    );
  } finally {
    transaction.mockRestore();
  }
});

it('sends an API test ping and resend with the same signed ID and protects the delivery log', async () => {
  const { endpoint, secret } = await create();
  const path = `${base()}/${endpoint.id}`;
  expect((await request(`${path}/test`, 'POST', undefined, 'member')).status).toBe(403);
  expect((await request(`${path}/deliveries`, 'GET', undefined, 'member')).status).toBe(403);
  const queued = await request(`${path}/test`, 'POST', undefined, 'admin');
  expect(queued.status).toBe(202);
  const ping = await queued.json();
  expect(ping).toMatchObject({ eventId: expect.any(String), kind: 'test', status: 'pending' });
  const log = await request(`${path}/deliveries?status=pending`);
  expect(log.status).toBe(200);
  expect(log.headers.get('cache-control')).toBe('no-store');
  expect(await log.json()).toMatchObject({ data: [{ ...ping, attemptCount: 0, attempts: [] }], nextCursor: null });
  const resend = `${path}/deliveries/${ping.id}/resend`;
  expect((await request(resend, 'POST')).status).toBe(409);
  expect((await request(resend, 'POST', undefined, 'member')).status).toBe(403);
  await withLocalReceiver(endpoint.id, async (received) => {
    await send();
    const requeued = await request(resend, 'POST');
    expect(requeued.status).toBe(202);
    expect(await requeued.json()).toEqual(ping);
    await send();
    expect(received).toHaveLength(2);
    for (const message of received) {
      expect(message.headers['webhook-id']).toBe(ping.eventId);
      expect(await verifyWebhook({ ...message, secret })).toMatchObject({ id: ping.eventId, action: 'logbird.webhook.test' });
    }
    const completed = await request(`${path}/deliveries?status=succeeded`);
    expect(await completed.json()).toMatchObject({
      data: [
        {
          id: ping.id,
          attemptCount: 2,
          attempts: [
            { number: 1, responseCode: 204 },
            { number: 2, responseCode: 204 },
          ],
        },
      ],
    });
  });
  expect((await request(`/api/projects/${siblingId}/webhooks/${endpoint.id}/deliveries`)).status).toBe(404);
  expect(
    await prisma.auditOutbox.count({
      where: {
        stream: `ws:${org}`,
        OR: ['webhook.test_queued', 'webhook.resend_queued'].map((action) => ({ payload: { path: ['action'], equals: action } })),
      },
    }),
  ).toBe(2);
});

it('lists only the latest five retained attempts per delivery and includes the cumulative count', async () => {
  const { endpoint } = await create();
  const now = Date.now();
  for (const count of [8, 53]) {
    await prisma.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        eventId: `qa-history-${count}`,
        status: 'pending',
        expiresAt: new Date(now - 1000),
        attemptNumber: count,
        attempts: {
          create: Array.from({ length: count }, (_, index) => ({
            number: index + 1,
            status: 'failed',
            startedAt: new Date(now - (count - index) * 1000),
          })),
        },
      },
    });
  }
  const response = await request(`${base()}/${endpoint.id}/deliveries?status=pending`);
  expect(response.status).toBe(200);
  const { data } = await response.json();
  expect(data).toHaveLength(2);
  for (const row of data) {
    const count = row.eventId === 'qa-history-8' ? 8 : 53;
    expect(row.attemptCount).toBe(count);
    expect(row.attempts.map(({ number }: { number: number }) => number)).toEqual(Array.from({ length: 5 }, (_, offset) => count - 4 + offset));
  }
});

it('advances discovery while HTTP ingest keeps arriving behind a slow admitted write', async () => {
  const fixture = await immutableFixture('qa-webhook-ingest');
  const exec = clickhouse.exec.bind(clickhouse);
  let holdNextWrite = false;
  let held = false;
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const wrapped = vi.spyOn(clickhouse, 'exec').mockImplementation(async (params) => {
    const result = await exec(params);
    if (holdNextWrite && !held && params.query.startsWith('INSERT INTO events ')) {
      held = true;
      await writeGate;
      held = false;
      holdNextWrite = false;
    }
    return result;
  });
  let ongoing: Promise<unknown>[] = [];
  try {
    const from = new Date(Date.now() - 60_000);
    await insertEvents(clickhouse, [fixture.row({ id: 'qa-already-stored', action: 'qa.webhook' }, from)]);
    holdNextWrite = true;
    const hook = await prisma.webhookEndpoint.create({
      data: { projectId: fixture.project, url: receiver, createdAt: from, cursorReceivedAt: from },
    });
    const admitted = Promise.resolve(fixture.post({ id: 'qa-slow', action: 'qa.webhook' }));
    ongoing = [admitted];
    await expect.poll(() => held, { interval: 20, timeout: 20_000 }).toBe(true);
    const scan = discoverWebhookDeliveries(clickhouse, hook);
    const arrivals = [0, 100, 250, 400].map(async (ms) => {
      await delay(ms);
      return fixture.post({ id: `qa-arrival-${ms}`, action: 'qa.webhook' });
    });
    ongoing.push(scan, ...arrivals);
    const [, ...responses] = await Promise.all([scan, ...arrivals]);
    expect(held).toBe(true);
    for (const response of responses) expect(response.status, await response.clone().text()).toBe(202);
    expect(await prisma.ingestReceipt.count({ where: { projectId: fixture.project, eventId: 'qa-slow', confirmedAt: null } })).toBe(1);
    expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id } })).cursorReceivedAt.getTime()).toBeGreaterThan(+from);
    expect(await prisma.webhookDelivery.findMany({ where: { endpointId: hook.id }, select: { eventId: true } })).toEqual([
      { eventId: 'qa-already-stored' },
    ]);
    releaseWrite();
    expect((await admitted).status).toBe(202);
    expect(await fixture.count()).toBe(6);
  } finally {
    releaseWrite();
    await Promise.allSettled(ongoing);
    wrapped.mockRestore();
    await fixture.cleanup();
  }
});

it('documents and returns a retryable lookup error on create and update while another workspace can save', async () => {
  const { endpoint } = await create();
  const openapi = await app.request('/openapi.json');
  expect(openapi.status).toBe(200);
  const { paths } = await openapi.json();
  const documented = [paths['/api/projects/{projectId}/webhooks'].post, paths['/api/projects/{projectId}/webhooks/{id}'].patch];
  for (const route of documented) {
    expect(route.responses['503']).toMatchObject({
      headers: { 'Retry-After': { schema: { type: 'integer', example: 3 } } },
      content: { 'application/json': { schema: { properties: { error: { properties: { code: { const: 'webhook_lookup_busy' } } } } } } },
    });
  }
  let release!: (value: Awaited<ReturnType<WebhookLookup>>) => void;
  const stalled = new Promise<Awaited<ReturnType<WebhookLookup>>>((resolve) => {
    release = resolve;
  });
  const allowed = [{ address: '8.8.8.8', family: 4 }];
  let held = 0;
  control.lookup = (hostname) => {
    if (hostname !== 'stall.example.invalid') return Promise.resolve(allowed);
    held++;
    return stalled;
  };
  const input = { url: 'https://stall.example.invalid/receiver' };
  const waiting = [request(base(), 'POST', input), request(base(), 'POST', input)];
  try {
    await expect.poll(() => held, { timeout: 3000 }).toBe(2);
    for (const busy of await Promise.all([request(base(), 'POST', input), request(`${base()}/${endpoint.id}`, 'PATCH', input)])) {
      expect(busy.status).toBe(503);
      expect(busy.headers.get('Retry-After')).toBe('3');
      expect(await busy.json()).toMatchObject({ error: { code: 'webhook_lookup_busy' } });
    }
    expect((await request(`/api/projects/${foreignId}/webhooks`, 'POST', { url: 'https://ready.example.invalid' }, 'foreign-owner')).status).toBe(
      201,
    );
  } finally {
    release(allowed);
    await Promise.all(waiting);
    control.lookup = undefined;
  }
});

it('delivers a reused event ID once after seven-day retention while the first delivery is still retained', async () => {
  const fixture = await immutableFixture('qa-webhook-id-reuse');
  const eventId = 'qa-reused-after-retention';
  const secret = generateWebhookSecret();
  try {
    await prisma.project.update({ where: { id: fixture.project }, data: { retentionDays: 7 } });
    const now = new Date();
    const hook = await prisma.webhookEndpoint.create({
      data: {
        projectId: fixture.project,
        url: receiver,
        createdAt: now,
        cursorReceivedAt: now,
        secrets: { create: { ciphertext: encryptWebhookSecret(secret, webhookSecretKey(env.BETTER_AUTH_SECRET, env.WEBHOOK_SECRET_KEY)) } },
      },
    });
    const rows = () => prisma.webhookDelivery.findMany({ where: { endpointId: hook.id, eventId }, orderBy: { receivedAt: 'asc' } });
    const scan = async () => discoverWebhookDeliveries(clickhouse, await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id } }));
    const ingest = async (action: string, occurredAt?: string) => {
      const response = await fixture.post({ id: eventId, action, occurredAt });
      expect(response.status, await response.clone().text()).toBe(202);
      expect(await response.json()).toMatchObject({ accepted: 1, ids: [eventId] });
    };
    await withLocalReceiver(hook.id, async (received) => {
      const delivered = (count: number) =>
        expect
          .poll(
            async () => {
              await scan();
              await send(fixture.project);
              return received.length;
            },
            { timeout: 30_000, interval: 500 },
          )
          .toBe(count);
      await ingest('qa.original', new Date(+now - 8 * 86_400_000).toISOString());
      await delivered(1);
      expect(await rows()).toMatchObject([{ status: 'succeeded' }]);
      await enforceProjectRetention(fixture.project);
      expect(await fixture.count()).toBe(0);
      expect(await prisma.ingestReceipt.count({ where: { projectId: fixture.project, eventId } })).toBe(0);
      expect(await rows()).toMatchObject([{ status: 'succeeded' }]);

      await ingest('qa.reused');
      await delivered(2);
      const [first, second, extra] = await rows();
      expect([first?.status, second?.status, extra]).toEqual(['succeeded', 'succeeded', undefined]);
      if (!first?.receivedAt || !second?.receivedAt) throw new Error('Missing stored occurrence clocks');
      expect(+second.receivedAt).toBeGreaterThan(+first.receivedAt);
      const [original, reused] = received;
      if (!original || !reused) throw new Error('Missing signed receiver requests');
      expect(original.headers['webhook-id']).toBe(first.webhookId);
      expect(reused.headers['webhook-id']).toBe(second.webhookId);
      expect(second.webhookId).not.toBe(first.webhookId);
      expect(await verifyWebhook({ ...original, secret })).toMatchObject({ id: eventId, action: 'qa.original' });
      expect(await verifyWebhook({ ...reused, secret })).toMatchObject({ id: eventId, action: 'qa.reused' });

      // Revisiting the same stored occurrence must keep the original delivery row and signed ID.
      await prisma.webhookEndpoint.update({ where: { id: hook.id }, data: { cursorReceivedAt: second.receivedAt, cursorEventId: null } });
      await scan();
      await send(fixture.project);
      expect(await rows()).toEqual([first, second]);
      expect(received).toHaveLength(2);
    });
  } finally {
    await fixture.cleanup();
  }
});
it('rotates with default, zero and maximum overlap without extending already expiring secrets', async () => {
  const { endpoint, secret } = await create();
  let previous = await prisma.webhookSecret.findFirstOrThrow({ where: { endpointId: endpoint.id } });
  for (const overlapSeconds of [undefined, 0, 604_800]) {
    const start = Date.now();
    const response = await request(`${base()}/${endpoint.id}/rotate-secret`, 'POST', overlapSeconds === undefined ? {} : { overlapSeconds });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const next = await response.json();
    expect(Object.keys(next)).toEqual(['secret']);
    expect(next.secret).not.toBe(secret);
    const old = await prisma.webhookSecret.findUniqueOrThrow({ where: { id: previous.id } });
    expect(old.expiresAt?.getTime()).toBeGreaterThanOrEqual(start + (overlapSeconds ?? 86_400) * 1000);
    expect(old.expiresAt?.getTime()).toBeLessThanOrEqual(Date.now() + (overlapSeconds ?? 86_400) * 1000);
    const active = await prisma.webhookSecret.findMany({ where: { endpointId: endpoint.id, expiresAt: null } });
    expect(active).toHaveLength(1);
    if (!active[0]) throw new Error('Current webhook secret missing');
    expect(decryptWebhookSecret(active[0].ciphertext, webhookSecretKey(env.BETTER_AUTH_SECRET, env.WEBHOOK_SECRET_KEY))).toBe(next.secret);
    previous = active[0];
  }
  // The secrets the zero-overlap rotation retired were deleted by the next one: only the 7-day one is still waiting.
  const before = await prisma.webhookSecret.findMany({ where: { endpointId: endpoint.id, expiresAt: { not: null } } });
  expect(before).toHaveLength(1);
  // A later rotation caps every earlier expiry at its own window: exactly that window, neither later nor sooner.
  let start = Date.now();
  await request(`${base()}/${endpoint.id}/rotate-secret`, 'POST', { overlapSeconds: 600 });
  let end = Date.now();
  const capped = await prisma.webhookSecret.findMany({ where: { endpointId: endpoint.id, expiresAt: { not: null } } });
  expect(capped.map((row) => row.id)).toEqual(expect.arrayContaining([...before.map((row) => row.id), previous.id]));
  for (const row of capped) {
    expect(row.expiresAt?.getTime()).toBeGreaterThanOrEqual(start + 600_000);
    expect(row.expiresAt?.getTime()).toBeLessThanOrEqual(end + 600_000);
  }
  // A longer window never extends an expiry that's already sooner, and a secret still inside its window is kept.
  start = Date.now();
  await request(`${base()}/${endpoint.id}/rotate-secret`, 'POST', { overlapSeconds: 3600 });
  end = Date.now();
  for (const row of capped)
    expect((await prisma.webhookSecret.findUniqueOrThrow({ where: { id: row.id } })).expiresAt?.getTime()).toBe(row.expiresAt?.getTime());
  const latest = await prisma.webhookSecret.findMany({ where: { endpointId: endpoint.id, expiresAt: { gt: new Date(end + 600_000) } } });
  expect(latest).toHaveLength(1);
  expect(latest[0]?.expiresAt?.getTime()).toBeGreaterThanOrEqual(start + 3_600_000);
  expect(latest[0]?.expiresAt?.getTime()).toBeLessThanOrEqual(end + 3_600_000);
  for (const overlapSeconds of [-1, 604_801, 1.5])
    expect((await request(`${base()}/${endpoint.id}/rotate-secret`, 'POST', { overlapSeconds })).status).toBe(422);
});
it('a zero-overlap rotation retires every earlier secret, including one still inside an earlier window', async () => {
  const { endpoint } = await create();
  const first = await prisma.webhookSecret.findFirstOrThrow({ where: { endpointId: endpoint.id } });
  // A -> B with the default 24-hour overlap: A stays valid for a day.
  expect((await request(`${base()}/${endpoint.id}/rotate-secret`, 'POST', {})).status).toBe(200);
  const second = await prisma.webhookSecret.findFirstOrThrow({ where: { endpointId: endpoint.id, expiresAt: null } });
  // B -> C with no overlap (say, B leaked): neither A nor B may keep signing.
  const now = Date.now();
  expect((await request(`${base()}/${endpoint.id}/rotate-secret`, 'POST', { overlapSeconds: 0 })).status).toBe(200);
  for (const id of [first.id, second.id]) {
    expect((await prisma.webhookSecret.findUniqueOrThrow({ where: { id } })).expiresAt?.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await prisma.webhookSecret.findUniqueOrThrow({ where: { id } })).expiresAt?.getTime()).toBeGreaterThanOrEqual(now - 1000);
  }
  expect(await prisma.webhookSecret.count({ where: { endpointId: endpoint.id, expiresAt: null } })).toBe(1);
});

it('signs with only the new key after zero-overlap rotation when the API clock is ahead', async () => {
  const { endpoint, secret: oldSecret } = await create();
  const path = `${base()}/${endpoint.id}`;
  await withLocalReceiver(endpoint.id, async (received) => {
    const ahead = new Date(Date.now() + 120_000);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ahead);
    let rotated: Response;
    try {
      rotated = await request(`${path}/rotate-secret`, 'POST', { overlapSeconds: 0 });
    } finally {
      vi.useRealTimers();
    }
    expect(rotated.status).toBe(200);
    const { secret } = await rotated.json();
    expect((await request(`${path}/test`, 'POST')).status).toBe(202);
    await send();
    expect(received).toHaveLength(1);
    const wire = received[0];
    if (!wire) throw new Error('Missing receiver request');
    expect((wire.headers['webhook-signature'] as string).split(' ')).toHaveLength(1);
    await expect(verifyWebhook({ ...wire, secret })).resolves.toMatchObject({ action: 'logbird.webhook.test' });
    await expect(verifyWebhook({ ...wire, secret: oldSecret })).rejects.toMatchObject({ reason: 'no_matching_signature' });
  });
});

it('verifies with the oldest of ten active secrets and rejects the next overlapping rotation', async () => {
  const { endpoint, secret } = await create();
  const path = `${base()}/${endpoint.id}`;
  for (let count = 1; count < MAX_WEBHOOK_SIGNATURES; count++) {
    expect((await request(`${path}/rotate-secret`, 'POST', {})).status).toBe(200);
  }
  const overflow = await request(`${path}/rotate-secret`, 'POST', {});
  expect(overflow.status).toBe(409);
  expect(await overflow.json()).toMatchObject({ error: { code: 'webhook_secret_overlap_limit' } });
  expect(await prisma.webhookSecret.count({ where: { endpointId: endpoint.id } })).toBe(10);

  expect((await request(`${path}/test`, 'POST')).status).toBe(202);
  await withLocalReceiver(endpoint.id, async (received) => {
    await send();
    expect(received).toHaveLength(1);
    const [message] = received;
    if (!message) throw new Error('Missing fixture delivery');
    expect((message.headers['webhook-signature'] as string).split(' ')).toHaveLength(10);
    expect(await verifyWebhook({ ...message, secret })).toMatchObject({ action: 'logbird.webhook.test' });
  });
  expect((await request(`${path}/rotate-secret`, 'POST', { overlapSeconds: 0 })).status).toBe(200);
  expect(await prisma.webhookSecret.count({ where: { endpointId: endpoint.id, expiresAt: null } })).toBe(1);
});

it('reports a seeded legacy overlap above ten, warns once when sending, and clears the warning after zero-overlap rotation', async () => {
  const { endpoint, secret: currentSecret } = await create();
  const path = `${base()}/${endpoint.id}`;
  const key = webhookSecretKey(env.BETTER_AUTH_SECRET, env.WEBHOOK_SECRET_KEY);
  const oldSecrets = Array.from({ length: MAX_WEBHOOK_SIGNATURES }, () => generateWebhookSecret());
  const createdAt = Date.now() - 60_000;
  await prisma.webhookSecret.createMany({
    data: oldSecrets.map((secret, order) => ({
      endpointId: endpoint.id,
      ciphertext: encryptWebhookSecret(secret, key),
      createdAt: new Date(createdAt + order),
      expiresAt: new Date(createdAt + 600_000),
    })),
  });
  const warning = { secretOverlapWarning: 'webhook_secret_overlap_limit' };
  expect(await (await request(path)).json()).toMatchObject(warning);
  expect(await (await request(base())).json()).toMatchObject({ data: [warning] });
  expect(await (await request(path, 'PATCH', { description: 'QA legacy overlap' })).json()).toMatchObject(warning);
  // The count uses PostgreSQL time: an API host clock already past the legacy secrets' expiry still reports the overlap.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(Date.now() + 15 * 60_000));
  try {
    expect(await (await request(path)).json()).toMatchObject(warning);
    expect(await (await request(base())).json()).toMatchObject({ data: [warning] });
  } finally {
    vi.useRealTimers();
  }
  const log = vi.spyOn(console, 'warn');
  try {
    await withLocalReceiver(endpoint.id, async (received) => {
      for (let index = 0; index < 2; index++) {
        expect((await request(`${path}/test`, 'POST')).status).toBe(202);
        await send();
      }
      expect(received).toHaveLength(2);
      for (const message of received) {
        expect((message.headers['webhook-signature'] as string).split(' ')).toHaveLength(MAX_WEBHOOK_SIGNATURES);
        for (const secret of [...oldSecrets.slice(1), currentSecret])
          await expect(verifyWebhook({ ...message, secret })).resolves.toMatchObject({ action: 'logbird.webhook.test' });
        await expect(verifyWebhook({ ...message, secret: oldSecrets[0] ?? '' })).rejects.toMatchObject({ reason: 'no_matching_signature' });
      }
      expect(log.mock.calls.filter(([message]) => String(message).includes('webhook.secret_overlap_limit'))).toHaveLength(1);
      const rotated = await request(`${path}/rotate-secret`, 'POST', { overlapSeconds: 0 });
      expect(rotated.status).toBe(200);
      const { secret } = await rotated.json();
      expect(await (await request(path)).json()).not.toHaveProperty('secretOverlapWarning');
      expect((await request(`${path}/test`, 'POST')).status).toBe(202);
      await send();
      expect(received).toHaveLength(3);
      const message = received[2];
      if (!message) throw new Error('Missing fixture delivery');
      expect((message.headers['webhook-signature'] as string).split(' ')).toHaveLength(1);
      await expect(verifyWebhook({ ...message, secret })).resolves.toMatchObject({ action: 'logbird.webhook.test' });
    });
  } finally {
    log.mockRestore();
  }
});

it.each(['owner', 'admin'])('%s can manage endpoints', async (role) => {
  const { endpoint } = await create(role);
  expect((await request(`${base()}/${endpoint.id}`, 'PATCH', { enabled: false }, role)).status).toBe(200);
  expect((await request(`${base()}/${endpoint.id}/rotate-secret`, 'POST', {}, role)).status).toBe(200);
  expect((await request(`${base()}/${endpoint.id}`, 'DELETE', undefined, role)).status).toBe(204);
});
// A stored URL can itself be a credential (a Slack or Zapier hook path), so reading endpoints needs owner/admin too.
it.each(['member', 'viewer', 'unknown'])('%s can neither read nor manage endpoints', async (role) => {
  const { endpoint } = await create();
  for (const [path, method, body] of [
    [base(), 'GET', undefined],
    [`${base()}/${endpoint.id}`, 'GET', undefined],
    [base(), 'POST', { url: receiver }],
    [`${base()}/${endpoint.id}`, 'PATCH', { enabled: false }],
    [`${base()}/${endpoint.id}`, 'DELETE', undefined],
    [`${base()}/${endpoint.id}/rotate-secret`, 'POST', {}],
  ] as const)
    expect((await request(path, method, body, role)).status).toBe(403);
});
it('denies anonymous, missing membership, cross-project and cross-workspace access through every route', async () => {
  const { endpoint } = await create();
  for (const [suffix, method, body] of [
    ['', 'GET'],
    ['', 'POST', { url: receiver }],
    [`/${endpoint.id}`, 'GET'],
    [`/${endpoint.id}`, 'PATCH', { enabled: false }],
    [`/${endpoint.id}`, 'DELETE'],
    [`/${endpoint.id}/rotate-secret`, 'POST', {}],
  ] as const) {
    expect((await request(`${base()}${suffix}`, method, body, 'anonymous')).status).toBe(401);
    expect((await request(`${base()}${suffix}`, method, body, 'outsider')).status).toBe(method === 'GET' ? 404 : 403);
    expect((await request(`/api/projects/${foreignId}/webhooks${suffix}`, method, body)).status).toBe(404);
    if (suffix) expect((await request(`/api/projects/${siblingId}/webhooks${suffix}`, method, body)).status).toBe(404);
  }
});
it('writes safe, atomic own-audit events and records manual state changes', async () => {
  const { endpoint, secret } = await create();
  const disabled = await request(`${base()}/${endpoint.id}`, 'PATCH', { enabled: false, description: 'QA disabled' });
  expect(await disabled.json()).toMatchObject({ enabled: false, disabledReason: 'manual', disabledAt: expect.any(String) });
  await request(`${base()}/${endpoint.id}`, 'PATCH', { enabled: false });
  const enabled = await request(`${base()}/${endpoint.id}`, 'PATCH', { enabled: true });
  expect(await enabled.json()).toMatchObject({ enabled: true, disabledReason: null, disabledAt: null });
  await request(`${base()}/${endpoint.id}/rotate-secret`, 'POST', {});
  await request(`${base()}/${endpoint.id}`, 'DELETE');
  const rows = await prisma.auditOutbox.findMany({ where: { stream: `ws:${org}` } });
  const payloads = rows.map((r) => r.payload as { action: string; changes?: { field: string }[] });
  expect(payloads.map((p) => p.action).sort()).toEqual(
    [
      'webhook.created',
      'webhook.updated',
      'webhook.disabled',
      'webhook.updated',
      'webhook.enabled',
      'webhook.secret_rotated',
      'webhook.deleted',
    ].sort(),
  );
  expect(payloads.filter((p) => p.action === 'webhook.updated').map((p) => p.changes?.map((change) => change.field))).toContainEqual([
    'description',
    'enabled',
  ]);
  expect(rows.map((r) => r.payload)).toContainEqual(
    expect.objectContaining({ action: 'webhook.disabled', metadata: { webhook: { url: 'https://8.8.8.8', reason: 'manual' } } }),
  );
  expect(JSON.stringify(rows)).not.toMatch(/qa-events|qa-private-token|whsec_|ciphertext/);
  expect(JSON.stringify(rows)).not.toContain(secret);
});
it('rolls back create, update, rotation and deletion when audit storage fails', async () => {
  const { endpoint } = await create();
  const snapshot = async () =>
    JSON.stringify({
      endpoint: await prisma.webhookEndpoint.findMany({ where: { projectId } }),
      secrets: await prisma.webhookSecret.findMany({ where: { endpointId: endpoint.id } }),
    });
  const before = await snapshot();
  control.failAudit = true;
  for (const [path, method, body] of [
    [base(), 'POST', { url: receiver }],
    [`${base()}/${endpoint.id}`, 'PATCH', { enabled: false }],
    [`${base()}/${endpoint.id}/rotate-secret`, 'POST', {}],
    [`${base()}/${endpoint.id}`, 'DELETE', undefined],
  ] as const) {
    const response = await request(path, method, body);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('audit_storage_unavailable');
    expect(await snapshot()).toBe(before);
  }
});
it('enforces the project limit under concurrent creates and preserves a single current secret under concurrent rotation', async () => {
  const { endpoint } = await create();
  for (let i = 1; i < MAX_WEBHOOK_ENDPOINTS - 1; i++) await create();
  const statuses = await Promise.all([request(base(), 'POST', { url: receiver }), request(base(), 'POST', { url: receiver })]);
  expect(statuses.map((r) => r.status).sort()).toEqual([201, 400]);
  expect(await prisma.webhookEndpoint.count({ where: { projectId } })).toBe(MAX_WEBHOOK_ENDPOINTS);
  const rotations = await Promise.all([
    request(`${base()}/${endpoint.id}/rotate-secret`, 'POST', {}),
    request(`${base()}/${endpoint.id}/rotate-secret`, 'POST', {}),
  ]);
  expect(rotations.map((r) => r.status)).toEqual([200, 200]);
  expect(await prisma.webhookSecret.count({ where: { endpointId: endpoint.id, expiresAt: null } })).toBe(1);
});
it('rejects invalid filters, scopes and URLs on create and PATCH without writing rows', async () => {
  const { endpoint } = await create();
  for (const [input, status, code] of [
    [{ url: 'https://127.0.0.1' }, 400, 'webhook_url_not_allowed'],
    [{ url: `https://8.8.8.8/${'a'.repeat(2048)}` }, 400, 'webhook_url_not_allowed'],
    [{ filterQuery: '(' }, 422, 'invalid_query'],
    [{ scope: { target: { type: 'qa' } } }, 422, 'validation_error'],
    [{ scope: { tenantId: 'a'.repeat(251) } }, 422, 'validation_error'],
    [{ scope: { tenantId: ' qa-tenant' } }, 422, 'validation_error'],
    [{ scope: { tenantId: 'qa\0id' } }, 422, 'validation_error'],
    [{ scope: { target: { type: 'q'.repeat(61), id: 'qa-id' } } }, 422, 'validation_error'],
    [{ scope: { target: { type: 'qa', id: 'qa\uFFFD' } } }, 422, 'validation_error'],
    [{ scope: { target: { type: 'qa', id: 'qa\uD800' } } }, 422, 'validation_error'],
    [{ scope: { target: { type: 'qa', id: 'a'.repeat(251) } } }, 422, 'validation_error'],
  ] as const) {
    for (const method of ['POST', 'PATCH']) {
      const response = await request(method === 'POST' ? base() : `${base()}/${endpoint.id}`, method, { url: receiver, ...input });
      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(code);
    }
  }
  expect(await prisma.webhookEndpoint.count({ where: { projectId } })).toBe(1);
});

it('blocks a seeded legacy scope that would match a truncated tenant and resumes after correction', async () => {
  const legacyTenant = 'q'.repeat(256);
  const at = new Date(Date.now() - 60_000);
  const scanClock = () => ({ now: new Date(), rollout: new Date(+at - 1) });
  const { endpoint, secret } = await create();
  const path = `${base()}/${endpoint.id}`;
  const collision = normalizeEvent(
    { id: 'qa-legacy-collision', action: 'qa.webhook', tenant: { id: `${legacyTenant}-other` } },
    { projectId, receivedAt: at },
  );
  const target = { type: 'website', id: 'qa-site' };
  const matching = normalizeEvent({ id: 'qa-held-match', action: 'qa.webhook', targets: [target] }, { projectId, receivedAt: at });
  if (!collision.ok || !matching.ok) throw new Error('Invalid legacy scope fixtures');
  expect(collision.row.tenant_id).toBe(legacyTenant);
  try {
    await insertEvents(clickhouse, [collision.row, matching.row]);
    const hook = await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { createdAt: at, cursorReceivedAt: at, scopeTenantId: legacyTenant },
    });
    await discoverWebhookDeliveries(clickhouse, hook, scanClock());
    expect(await prisma.webhookDelivery.count({ where: { endpointId: hook.id } })).toBe(0);
    expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id } })).toMatchObject({ cursorReceivedAt: at, cursorEventId: null });
    const warning = { scope: { tenantId: legacyTenant }, scopeWarning: 'webhook_invalid_scope' };
    expect(await (await request(path)).json()).toMatchObject(warning);
    expect(await (await request(base())).json()).toMatchObject({ data: [warning] });
    const test = await request(`${path}/test`, 'POST');
    expect(test.status).toBe(409);
    expect(await test.json()).toMatchObject({ error: { code: 'webhook_invalid_scope' } });

    await withLocalReceiver(hook.id, async (received) => {
      // Legacy pending work includes both unattempted rows and earlier retries whose deadlines have passed.
      const queued = { endpointId: hook.id, receivedAt: at, nextAttemptAt: at, expiresAt: new Date(Date.now() + 60_000) };
      const outOfScope = await prisma.webhookDelivery.create({ data: { ...queued, eventId: collision.row.event_id } });
      const eligible = await prisma.webhookDelivery.create({
        data: {
          ...queued,
          eventId: matching.row.event_id,
          retryUntil: at,
          attemptNumber: 1,
          windowAttempts: 1,
          attempts: { create: { status: 'failed', error: 'lookup_failed', number: 1, startedAt: at } },
        },
      });
      for (let tick = 0; tick < 2; tick++) await send();
      expect(received).toHaveLength(0);
      const getEndpoint = () => prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id } });
      expect(await getEndpoint()).toMatchObject({ scopeReviewRequired: true, consecutiveFailures: 0, failingSince: null });
      for (const row of [eligible, outOfScope]) expect(await prisma.webhookDelivery.findUnique({ where: { id: row.id } })).toEqual(row);
      expect(await prisma.webhookAttempt.count({ where: { delivery: { endpointId: hook.id } } })).toBe(1);

      const fixed = await request(path, 'PATCH', { scope: { target } });
      expect(fixed.status).toBe(200);
      expect(await fixed.json()).not.toHaveProperty('scopeWarning');
      const corrected = await getEndpoint();
      expect(corrected.scopeReviewRequired).toBe(false);
      await discoverWebhookDeliveries(clickhouse, corrected, scanClock());
      expect(+(await getEndpoint()).cursorReceivedAt).toBeGreaterThan(+at);
      // The matching occurrence is already queued. Rediscovery must not create a second delivery.
      expect(await prisma.webhookDelivery.count({ where: { endpointId: hook.id } })).toBe(2);
      await send();
      expect(received).toHaveLength(0);
      expect(await getEndpoint()).toMatchObject({ enabled: true, consecutiveFailures: 0, failingSince: null });
      await send();
      await send();
      expect(received).toHaveLength(1);
      const [wire] = received;
      if (!wire) throw new Error('Missing signed delivery after scope correction');
      expect(await verifyWebhook({ ...wire, secret })).toMatchObject({ id: matching.row.event_id });
      expect(await (await request(`${path}/deliveries?status=skipped`)).json()).toMatchObject({
        data: [{ id: outOfScope.id, status: 'skipped', attempts: [{ status: 'skipped', error: 'scope_mismatch' }] }],
      });
      expect(await (await request(`${path}/deliveries?status=succeeded`)).json()).toMatchObject({
        data: [
          {
            id: eligible.id,
            attemptCount: 2,
            attempts: [
              { number: 1, error: 'lookup_failed' },
              { number: 2, status: 'succeeded' },
            ],
          },
        ],
      });
      expect(await getEndpoint()).toMatchObject({ enabled: true, consecutiveFailures: 0, failingSince: null });
      expect(await prisma.webhookDisableNotice.count({ where: { endpointId: hook.id } })).toBe(0);
    });
  } finally {
    await withProjectLock(projectId, () => purgeProjectEvents(projectId));
  }
});

it('rejects filters on masked columns and attribute paths using the combined old and new configuration', async () => {
  const scope = { target: { type: 'website', id: 'qa-site' }, mask: SCOPE_MASKS };
  const { endpoint } = await create('owner', { url: receiver, filterQuery: 'ip:*' });
  const path = `${base()}/${endpoint.id}`;
  const reject = async (response: Response) => {
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_query', details: { reason: 'not_allowed' } } });
  };
  await reject(await request(path, 'PATCH', { scope }));
  for (const filterQuery of ['ip:*', 'NOT actor.email:*', 'action:qa OR _exists_:attr.context.userAgent', 'attributes.actor.email:*'])
    await reject(await request(base(), 'POST', { url: receiver, scope, filterQuery }));
  expect((await request(path, 'PATCH', { scope, filterQuery: 'action:qa.webhook' })).status).toBe(200);
  await reject(await request(path, 'PATCH', { filterQuery: 'attr.context.ip:*' }));
  expect(await (await request(path)).json()).toMatchObject({ scope, filterQuery: 'action:qa.webhook' });
});

it('discards a prepared body after PATCH adds an email mask and sends the rebuilt body once', async () => {
  const tenantId = 'qa-race-tenant';
  const email = 'qa-race@example.invalid';
  const { endpoint, secret } = await create('owner', { url: receiver, scope: { tenantId } });
  const path = `${base()}/${endpoint.id}`;
  const receivedAt = new Date(+new Date(endpoint.createdAt) + 1);
  const event = normalizeEvent(
    { id: 'qa-mask-race', action: 'qa.webhook', tenant: { id: tenantId }, actor: { type: 'user', id: 'qa-actor', email } },
    { projectId, receivedAt },
  );
  if (!event.ok) throw new Error(event.reason);
  try {
    await insertEvents(clickhouse, [event.row]);
    await withLocalReceiver(
      endpoint.id,
      async (received) => {
        const queued = await prisma.webhookDelivery.create({
          data: { endpointId: endpoint.id, eventId: event.row.event_id, receivedAt, expiresAt: new Date(+receivedAt + 3_600_000) },
        });
        const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
        let patch: Response | undefined;
        await send(projectId, {
          transport: {
            // DNS is resolved after the unmasked body is built and before dispatch takes its locks.
            lookup: async () => {
              patch = await request(path, 'PATCH', { scope: { tenantId, mask: ['actor_email'] } });
              return lookup();
            },
          },
        });
        expect(patch?.status).toBe(200);
        expect(received).toHaveLength(0);
        expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: queued.id }, include: { attempts: true } })).toMatchObject({
          status: 'pending',
          attemptNumber: 0,
          windowAttempts: 0,
          leaseUntil: null,
          attempts: [],
        });
        await send(projectId, { transport: { lookup } });
        await send(projectId, { transport: { lookup } });
        expect(received).toHaveLength(1);
        const wire = received[0];
        if (!wire) throw new Error('Missing receiver request');
        expect(wire.payload).not.toContain(email);
        const digest = createHmac('sha256', fieldMaskKey(env.BETTER_AUTH_SECRET)).update(`${projectId}\0${email}`).digest('hex').slice(0, 24);
        await expect(verifyWebhook({ ...wire, secret })).resolves.toMatchObject({ actor: { email: `masked:${digest}` } });
        expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: queued.id }, include: { attempts: true } })).toMatchObject({
          status: 'succeeded',
          attemptNumber: 1,
          attempts: [{ status: 'succeeded', number: 1 }],
        });
      },
      { hostname: 'qa-webhook.example.invalid' },
    );
  } finally {
    await withProjectLock(projectId, () => purgeProjectEvents(projectId));
  }
});

it('blocks PATCH on the dispatch row lock until the HTTP request starts', async () => {
  const { endpoint } = await create('owner', { url: receiver, scope: { tenantId: 'qa-lock-tenant' } });
  const path = `${base()}/${endpoint.id}`;
  const reply = deferred<void>();
  await withLocalReceiver(
    endpoint.id,
    async (received) => {
      expect((await request(`${path}/test`, 'POST')).status).toBe(202);
      const { id, eventId } = await prisma.webhookDelivery.findFirstOrThrow({ where: { endpointId: endpoint.id } });
      const locked = deferred<number>();
      const release = deferred<void>();
      const end = vi.spyOn(ClientRequest.prototype, 'end');
      const started = () => end.mock.contexts.some((ctx) => ctx instanceof ClientRequest && ctx.getHeader('webhook-id') === eventId);
      const sending = send(projectId, {
        beforeRequest: async (tx) => {
          const [{ pid }] = await tx.$queryRaw<[{ pid: number }]>`SELECT pg_backend_pid() AS pid`;
          locked.resolve(pid);
          await release.promise;
        },
      });
      let patch: Promise<{ response: Response; startedBeforeSave: boolean }> | undefined;
      try {
        const pid = await Promise.race([
          locked.promise,
          sending.then(() => {
            throw new Error('Dispatch finished before acquiring the row lock');
          }),
        ]);
        patch = Promise.resolve(request(path, 'PATCH', { scope: { tenantId: 'qa-lock-tenant', mask: ['actor_email'] } })).then((response) => ({
          response,
          startedBeforeSave: started(),
        }));
        await vi.waitFor(async () => {
          const blockers = await prisma.$queryRaw<{ pid: number }[]>`SELECT pid FROM pg_stat_activity
          WHERE ${pid} = ANY(pg_blocking_pids(pid)) AND query LIKE '%WebhookEndpoint%FOR UPDATE%'`;
          expect(blockers).toHaveLength(1);
        });
        expect(started()).toBe(false);
        release.resolve();
        const saved = await patch;
        expect(saved.response.status).toBe(200);
        expect(saved.startedBeforeSave).toBe(true);
        reply.resolve();
        await sending;
        expect(received).toHaveLength(1);
        expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'succeeded', attemptNumber: 1 });
      } finally {
        release.resolve();
        reply.resolve();
        await Promise.allSettled([sending, patch]);
        end.mockRestore();
      }
    },
    { beforeRespond: () => reply.promise },
  );
});

it('signs identical masked bytes on initial delivery and resend of a target-only event', async () => {
  const at = new Date(Date.now() - 60_000);
  const ip = '203.0.113.27';
  const userAgent = 'QA-Private-UA/1.0';
  const email = 'qa-private@example.invalid';
  const scope = { target: { type: 'website', id: 'qa-site' }, mask: SCOPE_MASKS };
  const { endpoint, secret } = await create('owner', { url: receiver, scope });
  expect(endpoint.scope).toEqual(scope);
  await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { createdAt: at, cursorReceivedAt: at } });
  const event = normalizeEvent(
    {
      id: 'qa-masked-wire',
      action: 'qa.webhook',
      targets: [scope.target],
      context: { ip, userAgent },
      actor: { type: 'user', id: 'qa-actor', email },
      'context.ip': ip,
      'context.userAgent': userAgent,
      'actor.email': email,
      'qa.keep': 'visible',
    },
    { projectId, receivedAt: at },
  );
  if (!event.ok) throw new Error(event.reason);
  expect(event.row.attributes).toMatchObject({ 'context.ip': ip, 'context.userAgent': userAgent, 'actor.email': email });
  try {
    await insertEvents(clickhouse, [event.row]);
    await withLocalReceiver(endpoint.id, async (received) => {
      await discoverWebhookDeliveries(clickhouse, await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } }));
      await send();
      const delivery = await prisma.webhookDelivery.findFirstOrThrow({ where: { endpointId: endpoint.id, status: 'succeeded' } });
      expect((await request(`${base()}/${endpoint.id}/deliveries/${delivery.id}/resend`, 'POST')).status).toBe(202);
      await send();
      expect(received).toHaveLength(2);
      expect(received[0]?.payload).toBe(received[1]?.payload);
      expect(received[0]?.headers['webhook-id']).toBe(received[1]?.headers['webhook-id']);
      const emailPseudonym = createHmac('sha256', fieldMaskKey(env.BETTER_AUTH_SECRET)).update(`${projectId}\0${email}`).digest('hex').slice(0, 24);
      for (const wire of received) {
        for (const privateValue of [ip, userAgent, email]) expect(wire.payload).not.toContain(privateValue);
        const body = await verifyWebhook({ ...wire, secret });
        expect(body).toMatchObject({ id: 'qa-masked-wire', context: { ip: '', userAgent: '' }, actor: { email: `masked:${emailPseudonym}` } });
        expect(body).toHaveProperty('attributes', { 'qa.keep': 'visible' });
        expect(body).not.toHaveProperty('payload');
      }
    });
  } finally {
    await withProjectLock(projectId, () => purgeProjectEvents(projectId));
  }
});

it('preserves future and implausibly old rollout cursors, records a sticky warning, and scans after operator reconciliation', async () => {
  const { now, rollout } = await webhookCursorClock(prisma);
  const repairAt = new Date(+now - 60_000);
  const createdAt = new Date(Math.min(+rollout, +repairAt) - 60_000);
  for (const cursorReceivedAt of [new Date(+now + 60_000), new Date(+createdAt - 3_600_000)]) {
    const hook = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('TimeZone', 'America/Los_Angeles', true)`;
      return tx.webhookEndpoint.create({ data: { projectId, url: receiver, createdAt, cursorReceivedAt } });
    });
    await discoverWebhookDeliveries(clickhouse, hook);
    const blocked = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id } });
    expect(blocked).toMatchObject({ cursorReceivedAt, cursorEventId: null, lastScannedAt: null, cursorReviewRequired: true });
    const path = `${base()}/${hook.id}`;
    const warning = { cursorWarning: 'webhook_cursor_review_required' };
    expect(await (await request(path)).json()).toMatchObject(warning);
    expect((await (await request(base())).json()).data).toContainEqual(expect.objectContaining({ ...warning, id: hook.id }));
    const start = new Date(Math.max(+repairAt, +rollout));
    const reconciled = await prisma.webhookEndpoint.update({
      where: { id: hook.id },
      data: { cursorReceivedAt: start, lastScannedAt: now, cursorReviewRequired: false },
    });
    await discoverWebhookDeliveries(clickhouse, reconciled);
    expect(await (await request(path)).json()).not.toHaveProperty('cursorWarning');
    expect(await prisma.webhookDelivery.count({ where: { endpointId: hook.id } })).toBe(0);
  }
});

it('rejects a forward reconciliation and delivers the intervening occurrence once', async () => {
  const clock = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL TIME ZONE 'Pacific/Auckland'`;
    await tx.$executeRaw`CREATE TEMP TABLE "_prisma_migrations" (
      migration_name text, started_at timestamptz, finished_at timestamptz, rolled_back_at timestamptz
    ) ON COMMIT DROP`;
    await tx.$executeRaw`INSERT INTO "_prisma_migrations" VALUES (
      '20261122140000_webhook_deliveries', CURRENT_TIMESTAMP - interval '1 minute', CURRENT_TIMESTAMP, NULL
    )`;
    return webhookCursorClock(tx);
  });
  const held = new Date(+clock.rollout - 5 * 60_000);
  const receivedAt = new Date(+held + 2 * 60_000);
  const floor = new Date(+held - 5 * 60_000);
  const reconcile = await loadWebhookReconciliation();
  const secret = generateWebhookSecret();
  const hook = await prisma.webhookEndpoint.create({
    data: {
      projectId,
      url: receiver,
      createdAt: new Date(+floor - 60_000),
      cursorReceivedAt: held,
      lastScannedAt: held,
      filterQuery: 'action:qa.webhook.reconciled',
      secrets: { create: { ciphertext: encryptWebhookSecret(secret, webhookSecretKey(env.BETTER_AUTH_SECRET, env.WEBHOOK_SECRET_KEY)) } },
    },
  });
  const event = normalizeEvent({ id: 'qa-rebuilt-ledger', action: 'qa.webhook.reconciled' }, { projectId, receivedAt });
  if (!event.ok) throw new Error(event.reason);
  try {
    await insertEvents(clickhouse, [event.row]);
    const refetch = () => prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id } });
    await withLocalReceiver(hook.id, async (requests) => {
      await discoverWebhookDeliveries(clickhouse, await refetch(), clock);
      expect(await refetch()).toMatchObject({ cursorReviewRequired: true });
      expect(await prisma.webhookDelivery.count({ where: { endpointId: hook.id } })).toBe(0);
      expect(await reconcile(prisma, hook.id, projectId, floor, new Date(+held + 5 * 60_000))).toEqual([]);
      expect(await refetch()).toMatchObject({ cursorReceivedAt: held, cursorReviewRequired: true, cursorVerifiedFloor: null, lastScannedAt: held });
      expect(await reconcile(prisma, hook.id, projectId, floor, held)).toHaveLength(1);
      expect(await refetch()).toMatchObject({ cursorVerifiedFloor: floor, cursorReviewRequired: false });
      // A later hold must retain the original floor even when the rebuilt ledger proposes a newer one.
      await prisma.webhookEndpoint.update({ where: { id: hook.id }, data: { cursorReviewRequired: true } });
      const auditCount = () => prisma.auditOutbox.count({ where: { stream: `ws:${org}` } });
      expect(await auditCount()).toBe(1);
      expect(await reconcile(prisma, hook.id, projectId, clock.rollout, clock.rollout)).toEqual([]);
      expect(await reconcile(prisma, hook.id, projectId, new Date(+floor - 1), held)).toEqual([]);
      expect(await refetch()).toMatchObject({ cursorReceivedAt: held, cursorVerifiedFloor: floor, cursorReviewRequired: true, lastScannedAt: held });
      expect(await auditCount()).toBe(1);
      expect(await reconcile(prisma, hook.id, projectId, floor, held)).toHaveLength(1);
      for (let tick = 0; tick < 2; tick++) {
        await discoverWebhookDeliveries(clickhouse, await refetch(), clock);
        await send();
      }
      expect(await prisma.webhookDelivery.findMany({ where: { endpointId: hook.id } })).toMatchObject([
        { eventId: 'qa-rebuilt-ledger', receivedAt, status: 'succeeded' },
      ]);
      expect(requests).toHaveLength(1);
      const request = requests[0];
      if (!request) throw new Error('Missing webhook request');
      expect(await verifyWebhook({ ...request, secret })).toMatchObject({ id: 'qa-rebuilt-ledger' });
    });
  } finally {
    await withProjectLock(projectId, () => purgeProjectEvents(projectId));
  }
});

it('sets creator to null when deleted and cascades endpoint secrets on project deletion', async () => {
  const creator = `qa-webhook-creator-${randomUUID()}`;
  users.push(creator);
  await prisma.user.create({ data: { id: creator, name: 'QA creator', email: `${creator}@example.invalid` } });
  const project = await prisma.project.create({ data: { organizationId: org, name: 'QA cascade', slug: `qa-cascade-${randomUUID()}` } });
  const endpoint = await prisma.webhookEndpoint.create({
    data: { projectId: project.id, url: receiver, createdById: creator, secrets: { create: { ciphertext: 'qa-fictional-ciphertext' } } },
  });
  await prisma.user.delete({ where: { id: creator } });
  expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: endpoint.id } })).createdById).toBeNull();
  await prisma.project.delete({ where: { id: project.id } });
  expect(await prisma.webhookEndpoint.count({ where: { id: endpoint.id } })).toBe(0);
  expect(await prisma.webhookSecret.count({ where: { endpointId: endpoint.id } })).toBe(0);
});
