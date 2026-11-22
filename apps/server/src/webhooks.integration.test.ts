import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createWebhookResponseSchema, listWebhooksResponseSchema, MAX_WEBHOOK_ENDPOINTS, webhookEndpointSchema } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { decryptWebhookSecret, type WebhookLookup, webhookSecretKey } from '@logbird/database/webhooks';
import { verifyWebhook } from '@logbird/sdk';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { deliverWebhooks } from '../../worker/src/webhook-delivery';
import { app } from './app';
import { clickhouse } from './clickhouse';
import { env } from './env';

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
  expect(await log.json()).toMatchObject({ data: [{ ...ping, attempts: [] }], nextCursor: null });
  const resend = `${path}/deliveries/${ping.id}/resend`;
  expect((await request(resend, 'POST')).status).toBe(409);
  expect((await request(resend, 'POST', undefined, 'member')).status).toBe(403);
  const received: { headers: IncomingHttpHeaders; payload: string }[] = [];
  const receiver = createServer((req, res) => {
    req.setEncoding('utf8');
    let payload = '';
    req.on('data', (chunk) => {
      payload += chunk;
    });
    req.on('end', () => {
      received.push({ headers: req.headers, payload });
      res.writeHead(204).end();
    });
  });
  try {
    receiver.listen(0, '127.0.0.1');
    await once(receiver, 'listening');
    const { port } = receiver.address() as AddressInfo;
    // Pin only the local receiver in this fixture. Production saves and sends retain their address policies.
    await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { url: `http://127.0.0.1:${port}/test` } });
    const send = () =>
      deliverWebhooks(
        clickhouse,
        {
          secretKey: webhookSecretKey(env.BETTER_AUTH_SECRET, env.WEBHOOK_SECRET_KEY),
          concurrency: 1,
          perEndpoint: 1,
          failureLimit: 50,
          transport: { allowHttp: true, allowAddress: (address) => address === '127.0.0.1' },
        },
        projectId,
      );
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
          attempts: [
            { number: 1, responseCode: 204 },
            { number: 2, responseCode: 204 },
          ],
        },
      ],
    });
  } finally {
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
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

it('returns a retryable lookup error for a busy workspace and lets another workspace save', async () => {
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
    const busy = await request(base(), 'POST', input);
    expect(busy.status).toBe(503);
    expect(busy.headers.get('Retry-After')).toBe('3');
    expect(await busy.json()).toMatchObject({ error: { code: 'webhook_lookup_busy' } });
    expect((await request(`/api/projects/${foreignId}/webhooks`, 'POST', { url: 'https://ready.example.invalid' }, 'foreign-owner')).status).toBe(
      201,
    );
  } finally {
    release(allowed);
    await Promise.all(waiting);
    control.lookup = undefined;
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
  ] as const) {
    for (const method of ['POST', 'PATCH']) {
      const response = await request(method === 'POST' ? base() : `${base()}/${endpoint.id}`, method, { url: receiver, ...input });
      expect(response.status).toBe(status);
      expect((await response.json()).error.code).toBe(code);
    }
  }
  expect(await prisma.webhookEndpoint.count({ where: { projectId } })).toBe(1);
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
