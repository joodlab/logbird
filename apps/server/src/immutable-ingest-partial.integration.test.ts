import { randomUUID } from 'node:crypto';
import { read } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';

const qa = process.env.CLICKHOUSE_DATABASE === 'logbird_qa_062';
let f: ImmutableFixture,
  clock = Date.now();
vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = Math.max(clock, Date.now()) + 61_000;
  vi.setSystemTime(clock);
  f = await immutableFixture();
});
afterEach(async () => {
  clock = Date.now();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await f.cleanup();
});
const input = { id: 'partial', action: 'partial.original', actor: { id: 'fixture-actor', type: 'user' }, metadata: { fixture: true } };
async function assertOne() {
  expect(await f.count()).toBe(1);
  const metrics = await read<{ ids: number; minutes: number; actors: number; attributes: number }>(
    clickhouse,
    "SELECT (SELECT uniqExact(event_id) FROM event_ids WHERE project_id={p:String}) ids,(SELECT sum(events) FROM events_by_minute WHERE project_id={p:String}) minutes,(SELECT sum(events) FROM entities WHERE project_id={p:String} AND kind='actor') actors,(SELECT sum(count) FROM attribute_keys WHERE project_id={p:String}) attributes",
    { p: f.project },
  );
  expect(metrics[0]).toEqual({ ids: 1, minutes: 1, actors: 1, attributes: 1 });
  expect(await prisma.ingestReceipt.count({ where: { projectId: f.project, confirmedAt: { not: null } } })).toBe(1);
}
it.runIf(qa)('retains a real async-wait timeout while its insertion remains queued', async () => {
  const insert = clickhouse.insert.bind(clickhouse);
  let serverCode = '';
  vi.spyOn(clickhouse, 'insert').mockImplementationOnce(async (params) => {
    try {
      return await insert({
        ...params,
        clickhouse_settings: {
          ...params.clickhouse_settings,
          async_insert: 1,
          wait_for_async_insert: 1,
          async_insert_use_adaptive_busy_timeout: 0,
          async_insert_busy_timeout_min_ms: 5000,
          async_insert_busy_timeout_max_ms: 5000,
          wait_for_async_insert_timeout: 1,
        },
      });
    } catch (error) {
      serverCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      throw error;
    }
  });
  const response = await f.post(input);
  expect(serverCode).toBe('159');
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe('ingest_pending');
  expect(await prisma.ingestReceipt.count({ where: { projectId: f.project, confirmedAt: null } })).toBe(1);
  expect(await f.count()).toBe(0);
  expect(
    (
      await read<{ n: number }>(clickhouse, "SELECT count() n FROM system.asynchronous_inserts WHERE database=currentDatabase() AND table='events'")
    )[0]?.n,
  ).toBeGreaterThan(0);
  await clickhouse.command({ query: 'SYSTEM FLUSH ASYNC INSERT QUEUE' });
  expect(await f.count()).toBe(1);
  // A visible raw row alone is not acknowledgement that every destination succeeded.
  expect((await f.post(input)).status).toBe(503);
  vi.setSystemTime(Date.now() + 80_000);
  expect((await f.post(input)).status).toBe(202);
  await assertOne();
});
it.runIf(qa).each(['event_ids', 'events_by_minute'] as const)(
  'repairs a real %s MV destination failure from raw evidence without re-insertion',
  async (target) => {
    const constraint = `qa_failure_${randomUUID().replaceAll('-', '')}`;
    await clickhouse.command({
      query: `ALTER TABLE ${target} ADD CONSTRAINT ${constraint} CHECK project_id != {p:String}`,
      query_params: { p: f.project },
    });
    try {
      const response = await f.post(input);
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe('ingest_pending');
      expect(await prisma.ingestReceipt.count({ where: { projectId: f.project, confirmedAt: null } })).toBe(1);
      expect(await f.count()).toBe(1);
      const absent =
        target === 'event_ids'
          ? 'SELECT count() n FROM event_ids WHERE project_id={p:String}'
          : 'SELECT sum(events) n FROM events_by_minute WHERE project_id={p:String}';
      expect((await read<{ n: number }>(clickhouse, absent, { p: f.project }))[0]?.n).toBe(0);
    } finally {
      await clickhouse.command({ query: `ALTER TABLE ${target} DROP CONSTRAINT IF EXISTS ${constraint}` });
    }
    vi.setSystemTime(Date.now() + 80_000);
    const writes = vi.spyOn(clickhouse, 'insert');
    expect((await f.post(input)).status).toBe(202);
    expect(writes.mock.calls.some(([p]) => p.table === 'events')).toBe(false);
    await assertOne();
  },
);
