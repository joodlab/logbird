import { randomUUID } from 'node:crypto';
import { historyHorizonSchema } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';
import { generateApiKey } from './keys';

// GET /v1/project tells a read key how far back its history reaches: the project's retention policy and the oldest
// event the caller can find through search, within its scope. Fictional tenants and records in their own project; the
// empty project lives only in Postgres (nothing is ever written to ClickHouse for it).
let f: ImmutableFixture;
const emptyOrg = randomUUID();
const emptyProject = `qa-horizon-empty-${randomUUID()}`;
const secrets = { read: '', tenantB: '', targetA2: '', tenantNone: '', tenantFuture: '', embed: '', empty: '' };
const day = 86_400_000;
const now = Date.now();
// Millisecond instants that are not whole seconds, so a lost fraction shows.
const at = (ms: number) => new Date(Math.floor(ms / 1000) * 1000 + 487).toISOString();
const oldest = {
  c0: at(now - 25 * day),
  a1: at(now - 20 * day),
  b1: at(now - 12 * day),
  a2: at(now - 9 * day),
  recent: at(now - 3_600_000),
  future: at(now + 3_600_000),
};
const embedOrigin = 'https://embed.example.invalid';

async function key(projectId: string, name: string, scope?: object, embedOrigins: string[] = []) {
  const k = generateApiKey('read', Boolean(scope));
  await prisma.apiKey.create({
    data: { projectId, name, kind: 'read', hash: k.hash, prefix: k.prefix, embedOrigins, ...(scope ? { scope } : {}) },
  });
  return k.secret;
}

beforeAll(async () => {
  f = await immutableFixture('qa-horizon');
  await prisma.project.update({ where: { id: f.project }, data: { retentionDays: 30 } });
  secrets.read = await key(f.project, 'QA read');
  secrets.tenantB = await key(f.project, 'QA tenant b', { tenantId: 'tenant_b' });
  secrets.targetA2 = await key(f.project, 'QA record a2', { tenantId: 'tenant_a', target: { type: 'article', id: 'art_2' } });
  secrets.tenantNone = await key(f.project, 'QA tenant none', { tenantId: 'tenant_none' });
  secrets.tenantFuture = await key(f.project, 'QA tenant future', { tenantId: 'tenant_future' });
  secrets.embed = await key(f.project, 'QA embed', undefined, [embedOrigin]);
  await prisma.organization.create({ data: { id: emptyOrg, name: 'QA Horizon Empty', slug: emptyOrg, createdAt: new Date() } });
  await prisma.project.create({ data: { id: emptyProject, organizationId: emptyOrg, name: 'QA Horizon Empty', slug: emptyProject } });
  secrets.empty = await key(emptyProject, 'QA empty read');
  const events = [
    // The oldest event of the project, in a tenant no scoped caller below may see.
    { id: 'h-c0', tenant: 'tenant_c', target: 'art_1', action: 'article.created', occurredAt: oldest.c0 },
    { id: 'h-a1', tenant: 'tenant_a', target: 'art_1', action: 'article.created', occurredAt: oldest.a1 },
    { id: 'h-b1', tenant: 'tenant_b', target: 'art_1', action: 'article.created', occurredAt: oldest.b1 },
    { id: 'h-a2', tenant: 'tenant_a', target: 'art_2', action: 'article.created', occurredAt: oldest.a2 },
    { id: 'h-a2-edit', tenant: 'tenant_a', target: 'art_2', action: 'article.updated', occurredAt: oldest.recent },
    { id: 'h-b-comment', tenant: 'tenant_b', target: 'art_1', action: 'comment.created', occurredAt: oldest.recent },
    // Dated an hour ahead: ingest accepts up to a day after receipt, and the horizon must find it.
    { id: 'h-future', tenant: 'tenant_future', target: 'art_9', action: 'article.scheduled', occurredAt: oldest.future },
  ].map((e) => ({
    id: e.id,
    action: e.action,
    occurredAt: e.occurredAt,
    tenant: { id: e.tenant },
    actor: { type: 'user', id: 'usr_writer', email: 'writer@example.invalid' },
    targets: [{ type: 'article', id: e.target }],
  }));
  const ingest = await f.post(events);
  expect(ingest.status).toBe(202);
  expect(await ingest.json()).toMatchObject({ accepted: events.length, rejected: [] });
});
afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: emptyOrg } });
  await f.cleanup();
});

const app = () => f.replicas[0] as NonNullable<ImmutableFixture['replicas'][0]>;
const get = (path: string, secret: string, headers: Record<string, string> = {}, method = 'GET') =>
  app().request(path, { method, headers: { Authorization: `Bearer ${secret}`, ...headers } });
async function horizon(secret: string) {
  const response = await get('/v1/project', secret);
  expect(response.status).toBe(200);
  return historyHorizonSchema.parse(await response.json());
}
/** What the caller could already find: the first event of an ascending search over the widest window. */
async function firstSearchable(secret: string) {
  const range = new URLSearchParams({ from: '1900-01-01T00:00:00.000Z', to: '2299-12-31T23:59:59.999Z', order: 'asc', limit: '1' });
  const response = await get(`/v1/events?${range}`, secret);
  expect(response.status).toBe(200);
  const page = (await response.json()) as { data: { timestamp: string }[] };
  return page.data[0]?.timestamp ?? null;
}
async function viewerToken(scope: object) {
  const minted = await app().request('/v1/viewer-tokens', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secrets.embed}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, ttlSeconds: 300 }),
  });
  expect(minted.status).toBe(201);
  return ((await minted.json()) as { token: string }).token;
}

describe('GET /v1/project', () => {
  it('gives a project read key the retention policy and the oldest event in the project, past the 24-hour default window', async () => {
    expect(await horizon(secrets.read)).toEqual({ retentionDays: 30, oldestEventAt: oldest.c0 });
    expect(await firstSearchable(secrets.read)).toBe(oldest.c0);
  });

  it('gives a tenant-scoped key the oldest event of its own tenant only', async () => {
    expect(await horizon(secrets.tenantB)).toEqual({ retentionDays: 30, oldestEventAt: oldest.b1 });
    expect(await firstSearchable(secrets.tenantB)).toBe(oldest.b1);
  });

  it('gives a record-scoped key the oldest event of that record in that tenant', async () => {
    expect(await horizon(secrets.targetA2)).toEqual({ retentionDays: 30, oldestEventAt: oldest.a2 });
    expect(await firstSearchable(secrets.targetA2)).toBe(oldest.a2);
  });

  it('finds an event dated after now, which a search without `to` would not', async () => {
    expect(await horizon(secrets.tenantFuture)).toEqual({ retentionDays: 30, oldestEventAt: oldest.future });
    expect(await firstSearchable(secrets.tenantFuture)).toBe(oldest.future);
  });

  it('gives a viewer token the oldest event within the token scope, narrower than its key, masked or not', async () => {
    const token = await viewerToken({ tenantId: 'tenant_b', actionPrefixes: ['comment.'] });
    expect(await horizon(token)).toEqual({ retentionDays: 30, oldestEventAt: oldest.recent });
    expect(await firstSearchable(token)).toBe(oldest.recent);
    const masked = await viewerToken({ tenantId: 'tenant_a', mask: ['actor_email', 'ip', 'user_agent'] });
    expect(await horizon(masked)).toEqual({ retentionDays: 30, oldestEventAt: oldest.a1 });
    expect(await firstSearchable(masked)).toBe(oldest.a1);
    // From a browser, only an origin on the key's embed list can read the answer.
    const allowed = await get('/v1/project', token, { Origin: embedOrigin });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(embedOrigin);
    await allowed.text();
    const other = await get('/v1/project', token, { Origin: 'https://other.example.invalid' });
    expect(other.status).toBe(403);
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
    await other.text();
  });

  it('states the current retention policy to a viewer token right after it changes', async () => {
    const token = await viewerToken({ tenantId: 'tenant_b' });
    expect((await horizon(token)).retentionDays).toBe(30);
    await prisma.project.update({ where: { id: f.project }, data: { retentionDays: 90 } });
    try {
      expect((await horizon(token)).retentionDays).toBe(90);
      expect((await horizon(secrets.read)).retentionDays).toBe(90);
    } finally {
      await prisma.project.update({ where: { id: f.project }, data: { retentionDays: 30 } });
    }
  });

  it('answers null for a scope with no events and for an empty project', async () => {
    expect(await horizon(secrets.tenantNone)).toEqual({ retentionDays: 30, oldestEventAt: null });
    expect(await firstSearchable(secrets.tenantNone)).toBeNull();
    expect(await horizon(secrets.empty)).toEqual({ retentionDays: 90, oldestEventAt: null });
  });

  it('is fenced like every read while retention runs, and HEAD never reaches the query', async () => {
    const run = await prisma.retentionRun.create({
      data: { projectId: f.project, kind: 'retention', status: 'running', retentionDays: 30, cutoff: new Date(now - 30 * day) },
    });
    try {
      const fenced = await get('/v1/project', secrets.read);
      expect(fenced.status).toBe(503);
      expect(await fenced.json()).toMatchObject({ error: { code: 'retention_unavailable' } });
      const search = await get('/v1/events', secrets.read);
      expect(search.status).toBe(503);
      await search.text();
      const head = await get('/v1/project', secrets.read, {}, 'HEAD');
      expect(head.status).toBe(405);
      expect(head.headers.get('allow')).toBe('GET');
    } finally {
      await prisma.retentionRun.delete({ where: { id: run.id } });
    }
    expect((await get('/v1/project', secrets.read)).status).toBe(200);
  });

  it('refuses HEAD, ingest keys, missing keys and SQL mode', async () => {
    const head = await get('/v1/project', secrets.read, {}, 'HEAD');
    expect(head.status).toBe(405);
    expect(head.headers.get('allow')).toBe('GET');
    const ingest = await get('/v1/project', f.key.secret);
    expect(ingest.status).toBe(401);
    await ingest.text();
    const anonymous = await app().request('/v1/project');
    expect(anonymous.status).toBe(401);
    await anonymous.text();
    const sql = await get('/v1/project?lang=sql&q=1', secrets.read);
    expect(sql.status).toBe(422);
    await sql.text();
  });
});
