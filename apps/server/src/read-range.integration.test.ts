import { purgeProject } from '@logbird/clickhouse';
import { DEFAULT_RANGE_MS, RANGE_FROM_HEADER, RANGE_TO_HEADER } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';
import { generateApiKey } from './keys';

// Every /v1 read states the time window it applied (search and facets as `range`, export as headers), with the same
// half-open rule as the request: from inclusive, to exclusive, on `timestamp`. Fictional tenants in their own project.
let f: ImmutableFixture;
let readSecret = '';
let scopedSecret = '';
const now = Date.now();
// A whole second, so the boundary checks below can name it in several spellings.
const edge = new Date(Math.floor((now - 2 * 3_600_000) / 1000) * 1000);
const old = new Date(now - 30 * 3_600_000).toISOString();
const recent = new Date(now - 60_000).toISOString();

beforeAll(async () => {
  f = await immutableFixture('qa-read-range');
  const read = generateApiKey('read');
  const scoped = generateApiKey('read', true);
  await prisma.apiKey.createMany({
    data: [
      { projectId: f.project, name: 'QA read', kind: 'read', hash: read.hash, prefix: read.prefix },
      { projectId: f.project, name: 'QA t1', kind: 'read', hash: scoped.hash, prefix: scoped.prefix, scope: { tenantId: 't1' } },
    ],
  });
  readSecret = read.secret;
  scopedSecret = scoped.secret;
  const events = [
    { id: 'old-t1', tenant: 't1', occurredAt: old },
    { id: 'edge-t1', tenant: 't1', occurredAt: edge.toISOString() },
    { id: 'recent-t1', tenant: 't1', occurredAt: recent },
    { id: 'recent-t2', tenant: 't2', occurredAt: recent },
  ].map((e) => ({ id: e.id, action: 'document.updated', tenant: { id: e.tenant }, occurredAt: e.occurredAt, targets: [{ type: 'doc', id: 'd1' }] }));
  expect((await f.post(events)).status).toBe(202);
});
/** An export releases its admission lease after its outcome is confirmed, a moment after the body ends: wait for it. */
async function exportsSettled() {
  for (let i = 0; i < 60 && (await prisma.exportLease.count({ where: { workspaceId: f.org } })); i++) await new Promise((r) => setTimeout(r, 250));
}
afterAll(async () => {
  await exportsSettled();
  // Exports record workspace activity: remove it with the fixture.
  await prisma.exportLease.deleteMany({ where: { workspaceId: f.org } });
  await prisma.auditOutbox.deleteMany({ where: { stream: `ws:${f.org}` } });
  await purgeProject(clickhouse, `ws:${f.org}`);
  await f.cleanup();
});

const get = (path: string, params: Record<string, string>, secret = readSecret) =>
  (f.replicas[0] ?? f.replicas[1])?.request(`${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  }) as Promise<Response>;
type Page = { data: { id: string }[]; total: number; totalExact?: boolean; range?: { from: string; to: string } };
const ids = (page: Page) => page.data.map((e) => e.id).sort();

describe('search', () => {
  it('states the default window: the 24 hours before the server clock, and the history it returns is only that window', async () => {
    const before = Date.now();
    const response = await get('/v1/events', { q: 'record:doc:d1' });
    const after = Date.now();
    expect(response.status).toBe(200);
    const page = (await response.json()) as Page;
    expect(page.range).toBeDefined();
    const { from, to } = page.range as { from: string; to: string };
    expect(Date.parse(to)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(to)).toBeLessThanOrEqual(after);
    expect(Date.parse(to) - Date.parse(from)).toBe(DEFAULT_RANGE_MS);
    expect(from).toBe(new Date(from).toISOString());
    expect(to).toBe(new Date(to).toISOString());
    // The 30-hour-old event is outside the stated window, and the exact total covers only that window.
    expect(ids(page)).toEqual(['edge-t1', 'recent-t1', 'recent-t2']);
    expect(page).toMatchObject({ total: 3, totalExact: true });
  });

  it('echoes an explicit window in normalized form, and the stated window is exactly the one applied', async () => {
    const response = await get('/v1/events', {
      q: 'record:doc:d1',
      from: new Date(now - 48 * 3_600_000).toISOString(),
      to: '2199-01-01T02:00:00+02:00',
    });
    const page = (await response.json()) as Page;
    expect(page.range).toEqual({ from: new Date(now - 48 * 3_600_000).toISOString(), to: '2199-01-01T00:00:00.000Z' });
    expect(ids(page)).toEqual(['edge-t1', 'old-t1', 'recent-t1', 'recent-t2']);
    expect(page.total).toBe(4);
  });

  it('is half-open: an event at `from` is in, an event at `to` is out', async () => {
    const at = edge.toISOString();
    const startsAt = (await (await get('/v1/events', { q: 'record:doc:d1', from: at, to: recent })).json()) as Page;
    expect(startsAt.range).toEqual({ from: at, to: recent });
    expect(ids(startsAt)).toEqual(['edge-t1']);
    // The same instant without milliseconds is the same bound.
    const endsAt = (await (await get('/v1/events', { q: 'record:doc:d1', from: old, to: at.replace('.000Z', 'Z') })).json()) as Page;
    expect(endsAt.range).toEqual({ from: old, to: at });
    expect(ids(endsAt)).toEqual(['old-t1']);
  });

  it('fills in only the missing bound: `from` alone ends at the server clock, `to` alone starts 24 hours before it', async () => {
    const before = Date.now();
    const fromOnly = (await (await get('/v1/events', { q: 'record:doc:d1', from: old })).json()) as Page;
    expect(fromOnly.range?.from).toBe(old);
    expect(Date.parse(fromOnly.range?.to ?? '')).toBeGreaterThanOrEqual(before);
    expect(ids(fromOnly)).toEqual(['edge-t1', 'old-t1', 'recent-t1', 'recent-t2']);
    const toOnly = (await (await get('/v1/events', { q: 'record:doc:d1', to: recent })).json()) as Page;
    expect(toOnly.range).toEqual({ from: new Date(Date.parse(recent) - DEFAULT_RANGE_MS).toISOString(), to: recent });
    expect(ids(toOnly)).toEqual(['edge-t1']);
  });

  it('keeps the same window on every page when the first page’s range is sent back', async () => {
    const first = (await (await get('/v1/events', { q: 'record:doc:d1', limit: '1', order: 'asc', from: old })).json()) as Page & {
      nextCursor: string;
    };
    const range = first.range as { from: string; to: string };
    const second = (await (
      await get('/v1/events', { q: 'record:doc:d1', limit: '1', order: 'asc', cursor: first.nextCursor, ...range })
    ).json()) as Page;
    expect(second.range).toEqual(range);
    expect([...first.data, ...second.data].map((e) => e.id)).toEqual(['old-t1', 'edge-t1']);
  });

  it('states the window to a scoped key, inside its scope', async () => {
    const page = (await (await get('/v1/events', { q: 'record:doc:d1', from: old }, scopedSecret)).json()) as Page;
    expect(page.range?.from).toBe(old);
    expect(ids(page)).toEqual(['edge-t1', 'old-t1', 'recent-t1']);
    const fallback = (await (await get('/v1/events', {}, scopedSecret)).json()) as Page;
    expect(Date.parse(fallback.range?.to ?? '') - Date.parse(fallback.range?.from ?? '')).toBe(DEFAULT_RANGE_MS);
    expect(ids(fallback)).toEqual(['edge-t1', 'recent-t1']);
  });

  it('refuses an empty or reversed window as before', async () => {
    const response = await get('/v1/events', { from: recent, to: recent });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('invalid_query');
  });
});

describe('facets', () => {
  type Facets = { values: { value: string; count: number }[]; range?: { from: string; to: string } };
  it('states the default and an explicit window, and counts only that window', async () => {
    const before = Date.now();
    const fallback = (await (await get('/v1/facets', { field: 'tenant', q: 'record:doc:d1' })).json()) as Facets;
    expect(Date.parse(fallback.range?.to ?? '')).toBeGreaterThanOrEqual(before);
    expect(Date.parse(fallback.range?.to ?? '') - Date.parse(fallback.range?.from ?? '')).toBe(DEFAULT_RANGE_MS);
    expect(fallback.values).toEqual([expect.objectContaining({ value: 't1', count: 2 }), expect.objectContaining({ value: 't2', count: 1 })]);
    const all = (await (await get('/v1/facets', { field: 'tenant', q: 'record:doc:d1', from: old, to: recent })).json()) as Facets;
    expect(all.range).toEqual({ from: old, to: recent });
    expect(all.values).toEqual([expect.objectContaining({ value: 't1', count: 2 })]);
  });

  it('states the window to a scoped key, also under a second level', async () => {
    const scoped = (await (await get('/v1/facets', { field: 'tenant', by: 'action', from: old }, scopedSecret)).json()) as Facets;
    expect(scoped.range?.from).toBe(old);
    expect(scoped.values).toEqual([expect.objectContaining({ value: 't1', count: 3 })]);
  });
});

describe('export', () => {
  const lines = async (response: Response) =>
    (await response.text())
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { id: string }).id)
      .sort();
  it('states the window in headers, default and explicit, and streams only that window', async () => {
    const before = Date.now();
    await exportsSettled();
    const fallback = await get('/v1/export', { format: 'jsonl', q: 'record:doc:d1' });
    expect(fallback.status).toBe(200);
    const from = fallback.headers.get(RANGE_FROM_HEADER) ?? '';
    const to = fallback.headers.get(RANGE_TO_HEADER) ?? '';
    expect(Date.parse(to)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(to) - Date.parse(from)).toBe(DEFAULT_RANGE_MS);
    expect(await lines(fallback)).toEqual(['edge-t1', 'recent-t1', 'recent-t2']);

    await exportsSettled();
    const explicit = await get('/v1/export', { format: 'csv', q: 'record:doc:d1', from: old, to: '2199-01-01T00:00:00Z' });
    expect(explicit.headers.get(RANGE_FROM_HEADER)).toBe(old);
    expect(explicit.headers.get(RANGE_TO_HEADER)).toBe('2199-01-01T00:00:00.000Z');
    expect((await explicit.text()).trim().split('\n')).toHaveLength(5); // header + 4 events
  });

  it('states no window on a refusal: the headers come only with rows', async () => {
    await exportsSettled();
    const refused = await get('/v1/export', { format: 'jsonl', q: 'action:"unterminated', from: old });
    expect(refused.status).toBe(422);
    expect(refused.headers.get(RANGE_FROM_HEADER)).toBeNull();
    expect(refused.headers.get(RANGE_TO_HEADER)).toBeNull();
  });

  it('states the window to a scoped key', async () => {
    await exportsSettled();
    const scoped = await get('/v1/export', { format: 'jsonl', from: old, to: recent }, scopedSecret);
    expect(scoped.headers.get(RANGE_FROM_HEADER)).toBe(old);
    expect(scoped.headers.get(RANGE_TO_HEADER)).toBe(recent);
    expect(await lines(scoped)).toEqual(['edge-t1', 'old-t1']);
  });
});
