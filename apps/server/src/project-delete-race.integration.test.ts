import { read } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
import { afterEach, expect, it, vi } from 'vitest';
import { clickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';

/**
 * Sol round 2 (PR #109): an async INSERT that is still queued in ClickHouse after its ingest call ended ambiguously
 * must not survive a project delete — neither on the empty-project fast path nor on the full purge. Real Postgres,
 * ClickHouse and Mailpit, in process (no listeners), fictional fixture removed afterwards.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
let f: ImmutableFixture | undefined;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await f?.cleanup();
  f = undefined;
});

const BUSY_MS = 30_000;
const queuedEventInserts = async () =>
  Number(
    (
      await read<{ n: number }>(clickhouse, "SELECT count() n FROM system.asynchronous_inserts WHERE database=currentDatabase() AND table='events'")
    )[0]?.n ?? 0,
  );
/** Rows for the project in every project-scoped ClickHouse table (raw events, event ids, rollups). */
async function storedRows(projectId: string) {
  const tables = await read<{ name: string }>(
    clickhouse,
    `SELECT t.name AS name FROM system.tables t WHERE t.database = currentDatabase()
       AND t.engine NOT IN ('MaterializedView', 'View', 'LiveView', 'WindowView', 'Dictionary')
       AND t.name IN (SELECT c.table FROM system.columns c WHERE c.database = currentDatabase() AND c.name = 'project_id')`,
  );
  const counts: Record<string, number> = {};
  for (const { name } of tables)
    counts[name] = Number(
      (await read<{ n: number }>(clickhouse, `SELECT count() n FROM \`${name}\` WHERE project_id={p:String}`, { p: projectId }))[0]?.n ?? 0,
    );
  return counts;
}

it('real services: an insert still queued after an ambiguous ingest never outlives an empty-project delete', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now());
  f = await immutableFixture();
  await f.authorize();
  const fixture = f;

  // 1. Ingest ends ambiguously (wait_for_async_insert times out) while ClickHouse keeps the row queued.
  const insert = clickhouse.exec.bind(clickhouse);
  vi.spyOn(clickhouse, 'exec').mockImplementationOnce((params) =>
    insert({
      ...params,
      clickhouse_settings: {
        ...params.clickhouse_settings,
        async_insert: 1,
        wait_for_async_insert: 1,
        async_insert_use_adaptive_busy_timeout: 0,
        async_insert_busy_timeout_min_ms: BUSY_MS,
        async_insert_busy_timeout_max_ms: BUSY_MS,
        wait_for_async_insert_timeout: 1,
      },
    }),
  );
  const ingested = await fixture.post({ id: 'race-1', action: 'race.queued', actor: { id: 'qa-race', type: 'user' } });
  expect(ingested.status).toBe(503);
  expect((await ingested.json()).error.code).toBe('ingest_pending');
  expect(await prisma.ingestReceipt.count({ where: { projectId: fixture.project, confirmedAt: null, claimedAt: { not: null } } })).toBe(1);
  expect(await fixture.count()).toBe(0);
  expect(await queuedEventInserts()).toBeGreaterThan(0);
  const remove = () =>
    fixture.management(`/api/projects/${encodeURIComponent(fixture.project)}?confirm=${encodeURIComponent(fixture.project)}`, 'DELETE');

  // 2. Deleting while that insert may still land is refused, and nothing is deleted.
  const early = await remove();
  expect(early.status).toBe(503);
  expect((await early.json()).error.code).toBe('ingest_pending');
  expect(Number(early.headers.get('Retry-After'))).toBeGreaterThan(0);
  expect(await prisma.project.findUnique({ where: { id: fixture.project } })).not.toBeNull();
  expect(await prisma.ingestReceipt.count({ where: { projectId: fixture.project } })).toBe(1);

  // 3. Past the claim's lease + flush bound, with the row STILL queued and every table still empty: the delete settles
  //    the queue first, so the row becomes visible, the shortcut is not taken and the full purge removes it.
  vi.setSystemTime(Date.now() + 71_000);
  expect(await queuedEventInserts()).toBeGreaterThan(0);
  expect(await fixture.count()).toBe(0);
  const removed = await remove();
  expect(removed.status, await removed.clone().text()).toBe(204);
  expect(await prisma.project.findUnique({ where: { id: fixture.project } })).toBeNull();
  expect(await prisma.ingestReceipt.count({ where: { projectId: fixture.project } })).toBe(0);

  // 4. Whatever ClickHouse still had queued has landed by now: nothing remains for the deleted project anywhere.
  await clickhouse.command({ query: 'SYSTEM FLUSH ASYNC INSERT QUEUE' });
  const left = await storedRows(fixture.project);
  expect(Object.keys(left)).toEqual(expect.arrayContaining(['events', 'events_by_minute', 'entities', 'attribute_keys']));
  expect(
    Object.values(left).reduce((a, b) => a + b, 0),
    JSON.stringify(left),
  ).toBe(0);
});

it('real services: a never-used project still takes the fast path', async () => {
  f = await immutableFixture();
  await f.authorize();
  const fixture = f;
  const started = performance.now();
  const removed = await fixture.management(
    `/api/projects/${encodeURIComponent(fixture.project)}?confirm=${encodeURIComponent(fixture.project)}`,
    'DELETE',
  );
  expect(removed.status).toBe(204);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(Object.values(await storedRows(fixture.project)).reduce((a, b) => a + b, 0)).toBe(0);
});
