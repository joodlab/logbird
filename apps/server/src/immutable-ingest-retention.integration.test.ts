import { insertEvents, read } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { enforceProjectRetention, clickhouse as retentionClickhouse } from '../../worker/src/retention';
import { clickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';

let f: ImmutableFixture;
vi.setConfig({ testTimeout: 90_000, hookTimeout: 30_000 });
beforeEach(async () => {
  f = await immutableFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
});
it('resumes an interrupted cutoff index delete after every expired raw row is already gone', async () => {
  const input = { id: 'expired', action: 'retention.old', occurredAt: new Date(Date.now() - 91 * 86_400_000).toISOString() };
  expect((await f.post(input)).status).toBe(202);
  const command = retentionClickhouse.command.bind(retentionClickhouse);
  let armed = true;
  vi.spyOn(retentionClickhouse, 'command').mockImplementation((params) => {
    if (armed && params.query.startsWith('DELETE FROM event_ids')) {
      armed = false;
      return Promise.reject(new Error('QA interruption between raw and index deletes'));
    }
    return command(params);
  });
  await expect(enforceProjectRetention(f.project)).rejects.toThrow('QA interruption');
  expect(await f.count()).toBe(0);
  expect((await read<{ n: number }>(clickhouse, 'SELECT count() n FROM event_ids WHERE project_id={p:String}', { p: f.project }))[0]?.n).toBe(1);
  vi.restoreAllMocks();
  await enforceProjectRetention(f.project);
  for (const table of ['events', 'event_ids', 'events_by_minute', 'entities', 'attribute_keys'])
    expect((await read<{ n: number }>(clickhouse, `SELECT count() n FROM ${table} WHERE project_id={p:String}`, { p: f.project }))[0]?.n).toBe(0);
  expect((await prisma.retentionRun.findFirstOrThrow({ where: { projectId: f.project }, orderBy: { startedAt: 'desc' } })).status).toBe('completed');
});
it('rebuilds an identity when its merged pointer expires but another raw timestamp survives', async () => {
  const id = 'legacy-retention',
    receivedAt = new Date();
  const expired = f.row({ id, action: 'legacy.expired', occurredAt: new Date(Date.now() - 91 * 86_400_000).toISOString() }, receivedAt);
  const retained = f.row({ id, action: 'customer.retained' }, new Date(receivedAt.getTime() - 1000));
  await insertEvents(clickhouse, [expired, retained]);
  // Reproduce the old replacing index after its merge retained only the now-expired pointer.
  await clickhouse.command({
    query: 'DELETE FROM event_ids WHERE project_id={p:String}',
    query_params: { p: f.project },
    clickhouse_settings: { mutations_sync: '2', lightweight_deletes_sync: '2' },
  });
  await clickhouse.insert({
    table: 'event_ids',
    format: 'JSONEachRow',
    values: [{ project_id: f.project, event_id: id, timestamp: expired.timestamp, received_at: expired.received_at }],
  });
  await enforceProjectRetention(f.project);
  expect(await f.count()).toBe(1);
  const conflict = await f.post({ id, action: 'overwrite', occurredAt: retained.timestamp });
  expect(conflict.status).toBe(202);
  expect(await conflict.json()).toMatchObject({ accepted: 0, rejected: [{ code: 'duplicate_id_conflict' }] });
  expect(await f.count()).toBe(1);
  expect(
    (
      await read<{ n: number }>(clickhouse, 'SELECT count() n FROM event_ids WHERE project_id={p:String} AND timestamp < {cutoff:DateTime64(3)}', {
        p: f.project,
        cutoff: new Date(Date.now() - 90 * 86_400_000).toISOString().replace('T', ' ').slice(0, -1),
      })
    )[0]?.n,
  ).toBe(0);
});
