import { type ClickHouseClient, createClient } from '@clickhouse/client';
import { createMaintenanceClickHouseClient, maintenanceQueryPrefix, projectMaintenance, read, stopProjectMaintenance } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
import { recoverProjectIngest } from '@logbird/worker/ingest-recovery';
import { afterEach, expect, it, vi } from 'vitest';
import { clickhouse, maintenanceClickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';

/**
 * An async INSERT that is still queued in ClickHouse after its ingest call ended ambiguously
 * must not survive a project delete — neither on the empty-project fast path nor on the full purge. Real Postgres,
 * ClickHouse and Mailpit, in process (no listeners), fictional fixture removed afterwards.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
let f: ImmutableFixture | undefined;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // If a case failed midway, nothing of the fixture may land after its cleanup: stop its tagged statements and
  // settle queued inserts first (the cleanup purge itself does not settle).
  if (f) {
    await stopProjectMaintenance(clickhouse, f.project).catch(() => undefined);
    await clickhouse.command({ query: 'SYSTEM FLUSH ASYNC INSERT QUEUE' }).catch(() => undefined);
  }
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

const runningMaintenance = async (projectId: string) =>
  Number(
    (
      await read<{ n: number }>(clickhouse, 'SELECT count() n FROM system.processes WHERE startsWith(query_id, {prefix:String})', {
        prefix: maintenanceQueryPrefix(projectId),
      })
    )[0]?.n ?? 0,
  );

it('real services: a maintenance INSERT left running by a failed call never commits after the project is deleted', async () => {
  f = await immutableFixture();
  await f.authorize();
  const fixture = f;
  const stored = await fixture.post({ id: 'maint-1', action: 'maintenance.fixture', actor: { id: 'qa-maint', type: 'user' } });
  expect(stored.status).toBe(202);
  expect((await storedRows(fixture.project)).events_by_minute).toBeGreaterThan(0);

  // A rollup-style INSERT … SELECT that takes ~60 s server-side, issued through the maintenance tagging with a client
  // that gives up after 300 ms — exactly what a failed sample-removal / retention rebuild leaves behind.
  const impatient = createClient({
    url: process.env.CLICKHOUSE_URL,
    database: process.env.CLICKHOUSE_DATABASE,
    username: process.env.CLICKHOUSE_USER,
    password: process.env.CLICKHOUSE_PASSWORD,
  });
  const startedAt = Date.now();
  try {
    await expect(
      projectMaintenance(impatient, fixture.project).command({
        // Rows the rebuild has already computed (as a rollup INSERT … SELECT has once its SELECT ran), emitted over
        // ~60 s — longer than the delete's full purge — and committed at the end. Without the kill they land after
        // the purge as orphan rollup rows (verified by disabling the kill: the orphan check below fails).
        query: `INSERT INTO events_by_minute (project_id, environment, bucket, action, outcome, actor_type, executor_type, events)
          SELECT {p:String}, 'production', toStartOfMinute(now()), 'maintenance.rebuild', 'success', 'user', 'api', 1
          FROM numbers(1200) WHERE sleepEachRow(0.05) = 0
          SETTINGS max_block_size = 20`,
        query_params: { p: fixture.project },
        // The shared test setup raises request_timeout, so the caller gives up by aborting the HTTP request instead.
        abort_signal: AbortSignal.timeout(300),
      }),
    ).rejects.toThrow();
  } finally {
    await impatient.close();
  }
  // The call failed, but ClickHouse is still executing the INSERT.
  expect(await runningMaintenance(fixture.project)).toBeGreaterThan(0);

  const removed = await fixture.management(
    `/api/projects/${encodeURIComponent(fixture.project)}?confirm=${encodeURIComponent(fixture.project)}`,
    'DELETE',
  );
  expect(removed.status, await removed.clone().text()).toBe(204);

  // Wait past the moment the INSERT would have committed, then check every destination.
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, startedAt + 66_000 - Date.now())));
  await clickhouse.command({ query: 'SYSTEM FLUSH ASYNC INSERT QUEUE' });
  const left = await storedRows(fixture.project);
  expect(
    Object.values(left).reduce((a, b) => a + b, 0),
    JSON.stringify(left),
  ).toBe(0);
  expect(await runningMaintenance(fixture.project)).toBe(0);
}, 240_000);

it('real services: refused deletes say when to retry (503 + code + Retry-After) and delete nothing', async () => {
  f = await immutableFixture();
  await f.authorize();
  const fixture = f;
  const remove = () =>
    fixture.management(`/api/projects/${encodeURIComponent(fixture.project)}?confirm=${encodeURIComponent(fixture.project)}`, 'DELETE');
  const stillThere = async () => (await prisma.project.findUnique({ where: { id: fixture.project } })) !== null;

  // maintenance_pending: a tagged statement that survives KILL QUERY … SYNC (stubbed system.processes lookups only).
  const query = maintenanceClickhouse.query.bind(maintenanceClickhouse);
  const command = maintenanceClickhouse.command.bind(maintenanceClickhouse);
  const stuck = `${maintenanceQueryPrefix(fixture.project)}stuck`;
  const processes = vi
    .spyOn(maintenanceClickhouse, 'query')
    .mockImplementation(((params: { query: string }) =>
      params.query.includes('system.processes') ? Promise.resolve({ json: async () => [{ query_id: stuck }] }) : query(params as never)) as never);
  const kills = vi
    .spyOn(maintenanceClickhouse, 'command')
    .mockImplementation(((params: { query: string }) =>
      params.query.startsWith('KILL QUERY') ? Promise.resolve({}) : command(params as never)) as never);
  const maintenance = await remove();
  expect(maintenance.status).toBe(503);
  expect((await maintenance.json()).error.code).toBe('maintenance_pending');
  expect(maintenance.headers.get('Retry-After')).toBe('10');
  expect(kills.mock.calls.some(([params]) => String((params as { query: string }).query).includes(stuck))).toBe(true);
  expect(await stillThere()).toBe(true);
  processes.mockRestore();
  kills.mockRestore();

  // ingest_pending: a claim taken just now may still have an insert in flight.
  await fixture.pending({ id: 'retry-after-claim', action: 'retry.claim' });
  const ingest = await remove();
  expect(ingest.status).toBe(503);
  expect((await ingest.json()).error.code).toBe('ingest_pending');
  const retryAfter = Number(ingest.headers.get('Retry-After'));
  expect(retryAfter).toBeGreaterThan(60);
  expect(retryAfter).toBeLessThanOrEqual(70);
  expect(await stillThere()).toBe(true);
  expect(await prisma.ingestReceipt.count({ where: { projectId: fixture.project } })).toBe(1);
});

it('real services: operator recovery with a bare client (scripts/reconcile-ingest.ts) tags every statement it sends', async () => {
  f = await immutableFixture();
  const fixture = f;
  const stored = await fixture.post({ id: 'reconcile-1', action: 'reconcile.fixture', actor: { id: 'qa-reconcile', type: 'user' } });
  expect(stored.status).toBe(202);
  // An expired, unresolved claim: recovery flushes, rebuilds the read model and repairs the index for it.
  await fixture.pending({ id: 'reconcile-2', action: 'reconcile.pending' }, { expired: true });
  const bare = createMaintenanceClickHouseClient();
  const sent: { method: string; query_id?: string; what: string }[] = [];
  const recording = new Proxy(bare, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'query' || property === 'command' || property === 'insert' || property === 'exec')
        return (params: { query_id?: string; query?: string; table?: string }) => {
          sent.push({ method: property, query_id: params.query_id, what: String(params.query ?? params.table).slice(0, 60) });
          return value.call(target, params);
        };
      return value.bind(target);
    },
  }) as ClickHouseClient;
  try {
    // Exactly what the operator script does: a bare maintenance client straight into the shared helper.
    await recoverProjectIngest(recording, fixture.project);
  } finally {
    await bare.close();
  }
  const writes = sent.filter((s) => s.method !== 'query' || /^\s*(INSERT|DELETE|ALTER)/i.test(s.what));
  expect(writes.length).toBeGreaterThan(0);
  const prefix = maintenanceQueryPrefix(fixture.project);
  expect(sent.filter((s) => !s.query_id?.startsWith(prefix))).toEqual([]);
  expect(await prisma.ingestReceipt.count({ where: { projectId: fixture.project, confirmedAt: null, claimedAt: { not: null } } })).toBe(0);
});
