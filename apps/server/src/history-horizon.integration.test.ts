import { randomUUID } from 'node:crypto';
import { historyHorizonSchema } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';
import { generateApiKey } from './keys';

// GET /v1/project tells a read key how far back its history reaches: the project's retention window and the oldest
// event the caller can see, within its scope. Fictional tenants and records in their own project; the empty project
// lives only in Postgres (nothing is ever written to ClickHouse for it).
let f: ImmutableFixture;
const emptyOrg = randomUUID();
const emptyProject = `qa-horizon-empty-${randomUUID()}`;
const secrets = { read: '', tenantB: '', targetA2: '', tenantNone: '', embed: '', empty: '' };
const day = 86_400_000;
const now = Date.now();
// Whole seconds, so the expected instants can be written exactly.
const at = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString();
const oldest = { a1: at(now - 20 * day), b1: at(now - 12 * day), a2: at(now - 9 * day), recent: at(now - 3_600_000) };
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
  secrets.embed = await key(f.project, 'QA embed', undefined, [embedOrigin]);
  await prisma.organization.create({ data: { id: emptyOrg, name: 'QA Horizon Empty', slug: emptyOrg, createdAt: new Date() } });
  await prisma.project.create({ data: { id: emptyProject, organizationId: emptyOrg, name: 'QA Horizon Empty', slug: emptyProject } });
  secrets.empty = await key(emptyProject, 'QA empty read');
  const events = [
    { id: 'h-a1', tenant: 'tenant_a', target: 'art_1', action: 'article.created', occurredAt: oldest.a1 },
    { id: 'h-b1', tenant: 'tenant_b', target: 'art_1', action: 'article.created', occurredAt: oldest.b1 },
    { id: 'h-a2', tenant: 'tenant_a', target: 'art_2', action: 'article.created', occurredAt: oldest.a2 },
    { id: 'h-a2-edit', tenant: 'tenant_a', target: 'art_2', action: 'article.updated', occurredAt: oldest.recent },
    { id: 'h-b-comment', tenant: 'tenant_b', target: 'art_1', action: 'comment.created', occurredAt: oldest.recent },
  ].map((e) => ({
    id: e.id,
    action: e.action,
    occurredAt: e.occurredAt,
    tenant: { id: e.tenant },
    actor: { type: 'user', id: 'usr_writer' },
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

const get = (path: string, secret: string, headers: Record<string, string> = {}) =>
  (f.replicas[0] as NonNullable<ImmutableFixture['replicas'][0]>).request(path, { headers: { Authorization: `Bearer ${secret}`, ...headers } });
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

describe('GET /v1/project', () => {
  it('gives a project read key the retention window and the oldest event in the project, past the 24-hour default window', async () => {
    expect(await horizon(secrets.read)).toEqual({ retentionDays: 30, oldestEventAt: oldest.a1 });
    expect(await firstSearchable(secrets.read)).toBe(oldest.a1);
  });

  it('gives a tenant-scoped key the oldest event of its own tenant only', async () => {
    expect(await horizon(secrets.tenantB)).toEqual({ retentionDays: 30, oldestEventAt: oldest.b1 });
    expect(await firstSearchable(secrets.tenantB)).toBe(oldest.b1);
  });

  it('gives a record-scoped key the oldest event of that record in that tenant', async () => {
    expect(await horizon(secrets.targetA2)).toEqual({ retentionDays: 30, oldestEventAt: oldest.a2 });
    expect(await firstSearchable(secrets.targetA2)).toBe(oldest.a2);
  });

  it('gives a viewer token the oldest event within the token scope, narrower than its key', async () => {
    const minted = await (f.replicas[0] as NonNullable<ImmutableFixture['replicas'][0]>).request('/v1/viewer-tokens', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secrets.embed}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: { tenantId: 'tenant_b', actionPrefixes: ['comment.'] }, ttlSeconds: 300 }),
    });
    expect(minted.status).toBe(201);
    const { token } = (await minted.json()) as { token: string };
    expect(await horizon(token)).toEqual({ retentionDays: 30, oldestEventAt: oldest.recent });
    expect(await firstSearchable(token)).toBe(oldest.recent);
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

  it('answers null for a scope with no events and for an empty project', async () => {
    expect(await horizon(secrets.tenantNone)).toEqual({ retentionDays: 30, oldestEventAt: null });
    expect(await firstSearchable(secrets.tenantNone)).toBeNull();
    expect(await horizon(secrets.empty)).toEqual({ retentionDays: 90, oldestEventAt: null });
  });

  it('refuses ingest keys, missing keys and SQL mode', async () => {
    const ingest = await get('/v1/project', f.key.secret);
    expect(ingest.status).toBe(401);
    await ingest.text();
    const anonymous = await (f.replicas[0] as NonNullable<ImmutableFixture['replicas'][0]>).request('/v1/project');
    expect(anonymous.status).toBe(401);
    await anonymous.text();
    const sql = await get('/v1/project?lang=sql&q=1', secrets.read);
    expect(sql.status).toBe(422);
    await sql.text();
  });
});
