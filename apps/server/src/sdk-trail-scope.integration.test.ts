import { prisma } from '@logbird/database';
import { readAuditTrail, trailQuery } from '@logbird/sdk/read';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';
import { generateApiKey } from './keys';

// #263 against the real read path: a backend that reads with a project read key and forgets one null check must not
// show one customer every customer's history. Two fictional tenants in one project.
let f: ImmutableFixture;
let readSecret = '';
beforeEach(async () => {
  f = await immutableFixture('qa-trail-scope');
  const key = generateApiKey('read');
  await prisma.apiKey.create({ data: { projectId: f.project, name: 'QA read', kind: 'read', hash: key.hash, prefix: key.prefix } });
  readSecret = key.secret;
});
afterEach(async () => {
  await f.cleanup();
});

it('reads only the asked tenant; an empty query widens to every tenant, which trailQuery now refuses before any request', async () => {
  const occurredAt = new Date(Date.now() - 60_000).toISOString();
  const events = ['acme', 'globex'].flatMap((tenant) =>
    [1, 2].map((n) => ({ id: `${tenant}-${n}`, action: 'invoice.updated', tenant: { id: tenant }, occurredAt })),
  );
  expect((await f.post(events)).status).toBe(202);
  const app = f.replicas[0];
  if (!app) throw new Error('fixture replica missing');
  // readAuditTrail against the real server app (in process), with the project read key.
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => app.request(String(input).replace('http://logbird.test', ''), init));
  const options = { endpoint: 'http://logbird.test', readKey: readSecret, fetch: fetch as unknown as typeof globalThis.fetch };
  const range = { from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() };

  const scoped = await readAuditTrail(options, trailQuery({ tenant: 'acme', range }));
  expect(scoped.data.map((e) => e.id).sort()).toEqual(['acme-1', 'acme-2']);

  // What `trailQuery({ tenant: session.tenantId })` returned before the fix when the id was missing: q ''. The server
  // reads that as every event in the range, so the other customer's history comes back.
  const widened = await readAuditTrail(options, { ...range, q: '' });
  expect(widened.data.map((e) => e.id).sort()).toEqual(['acme-1', 'acme-2', 'globex-1', 'globex-2']);

  // After the fix the same call throws before anything is sent.
  const session: { tenantId?: string } = {};
  fetch.mockClear();
  await expect(async () => readAuditTrail(options, trailQuery({ tenant: session.tenantId, range }))).rejects.toThrow(TypeError);
  await expect(async () => readAuditTrail(options, trailQuery({ range }))).rejects.toThrow(/an empty trail would be the whole project/);
  expect(fetch).not.toHaveBeenCalled();
});

// #311 round 4: the Nuxt route re-authorizes every page. A cursor minted for tenant A, sent after authorize now scopes
// the read to tenant B (a session switch), only positions the read: the server never returns A's rows for it.
it("answers another tenant's cursor with the asked tenant's rows only, never the cursor's tenant", async () => {
  const now = Date.now();
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();
  const events = [
    { id: 'acme-1', tenant: 'acme', occurredAt: at(50) },
    { id: 'acme-2', tenant: 'acme', occurredAt: at(40) },
    { id: 'acme-3', tenant: 'acme', occurredAt: at(30) },
    { id: 'globex-newer', tenant: 'globex', occurredAt: at(20) },
    { id: 'globex-1', tenant: 'globex', occurredAt: at(45) },
    { id: 'globex-2', tenant: 'globex', occurredAt: at(35) },
  ].map((e) => ({ id: e.id, action: 'invoice.updated', tenant: { id: e.tenant }, occurredAt: e.occurredAt }));
  expect((await f.post(events)).status).toBe(202);
  const app = f.replicas[0];
  if (!app) throw new Error('fixture replica missing');
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => app.request(String(input).replace('http://logbird.test', ''), init);
  const options = { endpoint: 'http://logbird.test', readKey: readSecret, fetch: fetch as unknown as typeof globalThis.fetch };
  const range = { from: new Date(now - 3_600_000), to: new Date(now + 60_000) };

  const first = await readAuditTrail(options, trailQuery({ tenant: 'acme', range, limit: 1 }));
  expect(first.data.map((e) => e.id)).toEqual(['acme-3']);
  expect(first.nextCursor).toBeTruthy();
  const switched = await readAuditTrail(options, trailQuery({ tenant: 'globex', range, limit: 50, cursor: first.nextCursor ?? undefined }));
  // Only globex rows, older than the cursor's position: globex-newer is skipped (a gap), acme-1 and acme-2 never appear.
  expect(switched.data.map((e) => e.id)).toEqual(['globex-2', 'globex-1']);
  expect(switched.data.every((e) => e.tenant?.id === 'globex')).toBe(true);
});
