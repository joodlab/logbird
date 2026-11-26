import { TRUNCATED_ATTRIBUTES } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';
import { generateApiKey } from './keys';

// Cuts at ingest, through the real server: an event with more targets or changes than are indexed, or with a field
// name longer than the column, is accepted whole, warned about and marked on the stored event. Fictional data in its
// own project, deleted afterwards.
let f: ImmutableFixture;
const secrets = { read: '', scoped: '', masked: '' };
const occurredAt = new Date(Date.now() - 60_000).toISOString();
const range = { from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };
const longField = `menu.${'x'.repeat(300)}`;
// 300 changes, then one with a long name past the 256 indexed ones: not a field-name cut of the indexed copy.
const manyChanges: { field: string; before?: number; after: number }[] = Array.from({ length: 300 }, (_, i) => ({
  field: `menu.item${i}`,
  before: i,
  after: i + 1,
}));
manyChanges.push({ field: 'y'.repeat(400), after: 1 });
const events = [
  {
    id: 'cut-targets',
    action: 'doc.bulk_tagged',
    occurredAt,
    tenant: { id: 't1' },
    targets: Array.from({ length: 70 }, (_, i) => ({ type: 'doc', id: `doc_${i}` })),
  },
  {
    id: 'cut-changes',
    action: 'menu.updated',
    occurredAt,
    tenant: { id: 't1' },
    changes: manyChanges,
  },
  { id: 'cut-field', action: 'menu.updated', occurredAt, tenant: { id: 't1' }, changes: [{ field: longField, before: 'a', after: 'b' }] },
  // A producer cannot forge a cut: these keys never reach the attributes.
  {
    id: 'forged',
    action: 'doc.updated',
    occurredAt,
    tenant: { id: 't1' },
    logbird: { truncated: { targets: '999' } },
    targets: [{ type: 'doc', id: 'doc_1' }],
  },
  {
    id: 'plain',
    action: 'doc.updated',
    occurredAt,
    tenant: { id: 't2' },
    targets: Array.from({ length: 64 }, (_, i) => ({ type: 'doc', id: `doc_${i}` })),
  },
];

beforeAll(async () => {
  f = await immutableFixture('qa-ingest-cuts');
  const keys = { read: generateApiKey('read'), scoped: generateApiKey('read', true), masked: generateApiKey('read', true) };
  await prisma.apiKey.createMany({
    data: [
      { projectId: f.project, name: 'QA read', kind: 'read', hash: keys.read.hash, prefix: keys.read.prefix },
      { projectId: f.project, name: 'QA t1', kind: 'read', hash: keys.scoped.hash, prefix: keys.scoped.prefix, scope: { tenantId: 't1' } },
      {
        projectId: f.project,
        name: 'QA t1 masked',
        kind: 'read',
        hash: keys.masked.hash,
        prefix: keys.masked.prefix,
        scope: { tenantId: 't1', mask: ['ip', 'user_agent', 'actor_email'] },
      },
    ],
  });
  secrets.read = keys.read.secret;
  secrets.scoped = keys.scoped.secret;
  secrets.masked = keys.masked.secret;
  // One ingest for every test, so each read test also runs alone.
  const response = await f.post(events);
  ingested = { status: response.status, body: await response.json() };
});
let ingested: { status: number; body: { accepted: number; rejected: unknown[]; warnings: Record<string, unknown>[] } };
afterAll(async () => {
  await f.cleanup();
});

type Event = { id: string; targets: unknown[]; changes: { field: string }[]; attributes: Record<string, string> };
const get = async <T>(path: string, params: Record<string, string>, secret = secrets.read) => {
  const app = f.replicas[0];
  if (!app) throw new Error('fixture replica missing');
  const response = await app.request(`${path}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${secret}` } });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
};
const cutKeys = (e: Event) => Object.fromEntries(Object.entries(e.attributes).filter(([k]) => k.startsWith('logbird.truncated')));

it('accepts every event, and warns once per cut with a stable code and counts, never event data', async () => {
  expect(ingested.status).toBe(202);
  const { body } = ingested;
  expect(body.accepted).toBe(events.length);
  expect(body.rejected).toEqual([]);
  expect(body.warnings).toEqual([
    { index: 0, code: 'targets_truncated', sent: 70, indexed: 64, limit: 64, reason: expect.stringMatching(/^70 targets sent, 64 indexed/) },
    {
      index: 1,
      code: 'changes_truncated',
      sent: 301,
      indexed: 256,
      limit: 256,
      reason: expect.stringMatching(/^301 changes sent, the first 256 indexed/),
    },
    { index: 2, code: 'change_fields_truncated', cut: 1, limit: 256, reason: expect.stringMatching(/^1 change field name longer than 256/) },
  ]);
  // No warning text carries an id, a field name or a value from the events.
  for (const w of body.warnings) expect(String(w.reason)).not.toMatch(/doc_|menu\.|xxx|cut-/);
});

it('marks the stored event, readable by a read key in search and detail, and the payload keeps everything', async () => {
  const page = await get<{ data: Event[] }>('/v1/events', { ...range, q: 'action:doc.* OR action:menu.*', limit: '50' });
  const byId = new Map(page.data.map((e) => [e.id, e]));
  expect(byId.get('cut-targets')?.targets).toHaveLength(64);
  expect(cutKeys(byId.get('cut-targets') as Event)).toEqual({ [TRUNCATED_ATTRIBUTES.targets]: '70' });
  expect(byId.get('cut-changes')?.changes).toHaveLength(256);
  expect(cutKeys(byId.get('cut-changes') as Event)).toEqual({ [TRUNCATED_ATTRIBUTES.changes]: '301' });
  expect(byId.get('cut-field')?.changes[0]?.field).toHaveLength(256);
  expect(cutKeys(byId.get('cut-field') as Event)).toEqual({ [TRUNCATED_ATTRIBUTES.changeFields]: '1' });
  expect(cutKeys(byId.get('forged') as Event)).toEqual({});
  expect(cutKeys(byId.get('plain') as Event)).toEqual({});

  const detail = await get<{ event: Event; payload: { targets: unknown[] } }>('/v1/events/cut-targets', {});
  expect(detail.event.attributes[TRUNCATED_ATTRIBUTES.targets]).toBe('70');
  expect(detail.payload.targets).toHaveLength(70);
  const field = await get<{ payload: { changes: { field: string }[] } }>('/v1/events/cut-field', {});
  expect(field.payload.changes[0]?.field).toBe(longField);
});

it('finds every cut event by its reserved attribute, and a record past the 64th target does not find it', async () => {
  const cut = await get<{ data: Event[] }>('/v1/events', { ...range, q: `attr.${TRUNCATED_ATTRIBUTES.targets}:*` });
  expect(cut.data.map((e) => e.id)).toEqual(['cut-targets']);
  expect((await get<{ data: Event[] }>('/v1/events', { ...range, q: 'record:doc:doc_63 action:doc.bulk_tagged' })).data).toHaveLength(1);
  expect((await get<{ data: Event[] }>('/v1/events', { ...range, q: 'record:doc:doc_65 action:doc.bulk_tagged' })).data).toHaveLength(0);
});

it('shows the counts to a tenant-scoped key and under a field mask, which has no payload', async () => {
  const scoped = await get<{ event: Event; payload: unknown }>('/v1/events/cut-changes', {}, secrets.scoped);
  expect(scoped.event.attributes[TRUNCATED_ATTRIBUTES.changes]).toBe('301');
  const masked = await get<{ event: Event; payload: unknown }>('/v1/events/cut-targets', {}, secrets.masked);
  expect(masked.event.attributes[TRUNCATED_ATTRIBUTES.targets]).toBe('70');
  expect(masked.payload).toBeNull();
  const page = await get<{ data: Event[] }>('/v1/events', { ...range, q: `attr.${TRUNCATED_ATTRIBUTES.changeFields}:*` }, secrets.masked);
  expect(page.data.map((e) => e.id)).toEqual(['cut-field']);
});

it('sends no cut warning for an event it rejects: a conflicting id keeps the event stored before it', async () => {
  expect(
    (await f.post({ id: 'cut-conflict', action: 'doc.updated', occurredAt, tenant: { id: 't1' }, targets: [{ type: 'doc', id: 'doc_1' }] })).status,
  ).toBe(202);
  const conflict = await f.post({ id: 'cut-conflict', action: 'doc.updated', occurredAt, tenant: { id: 't1' }, targets: events[0]?.targets });
  const body = (await conflict.json()) as { accepted: number; rejected: { code: string }[]; warnings: unknown[] };
  expect(body).toMatchObject({ accepted: 0, rejected: [{ code: 'duplicate_id_conflict' }], warnings: [] });
  const stored = await get<{ event: Event }>('/v1/events/cut-conflict', {});
  expect(stored.event.targets).toHaveLength(1);
  expect(cutKeys(stored.event)).toEqual({});
});
