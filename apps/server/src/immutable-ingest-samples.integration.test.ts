import { deleteAndVerify, getEvent, insertEvents, read } from '@logbird/clickhouse';
import { prisma, pruneIngestReceipts, withProjectLock } from '@logbird/database';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';

vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });
let f: ImmutableFixture;
beforeEach(async () => {
  f = await immutableFixture();
  await f.authorize();
});
afterEach(async () => {
  await f.cleanup();
  // Two synchronous stream purges share the local ClickHouse two-slot mutation pool.
}, 60_000);
it('sample API preserves a retained customer sample-event-N identity', async () => {
  expect((await f.post({ id: 'sample-event-0', action: 'customer.original' })).status).toBe(202);
  const loaded = await f.management(`/api/projects/${f.project}/sample-data`, 'POST');
  expect(loaded.status, await loaded.clone().text()).toBe(200);
  expect((await getEvent(clickhouse, f.project, 'sample-event-0'))?.event.action).toBe('customer.original');
  const conflicts = await read<{ n: number }>(clickhouse, "SELECT count() n FROM events WHERE project_id={p:String} AND event_id='sample-event-0'", {
    p: f.project,
  });
  expect(conflicts[0]?.n).toBe(1);
  expect((await f.management(`/api/projects/${f.project}/sample-data`, 'DELETE')).status).toBe(204);
  expect(await f.count()).toBe(1);
  expect((await read<{ n: number }>(clickhouse, 'SELECT count() n FROM event_ids WHERE project_id={p:String}', { p: f.project }))[0]?.n).toBe(1);
  // Two synchronous purges of the sample stream share the local ClickHouse two-slot mutation pool.
}, 60_000);
it('sample removal reconciles receipts so the intentionally deleted event can retry', async () => {
  const input = { id: 'customer-sample-source', action: 'sample.original', source: 'logbird-sample' };
  expect((await f.post(input)).status).toBe(202);
  expect((await f.management(`/api/projects/${f.project}/sample-data`, 'DELETE')).status).toBe(204);
  expect(await getEvent(clickhouse, f.project, input.id)).toBeNull();
  expect(await prisma.ingestReceipt.count({ where: { projectId: f.project, eventId: input.id } })).toBe(0);
  expect((await f.post(input)).status).toBe(202);
  expect((await getEvent(clickhouse, f.project, input.id))?.event.action).toBe(input.action);
});
it('sample removal waits for an unresolved active write', async () => {
  await f.pending({ id: 'pending-sample', action: 'sample.original', source: 'logbird-sample' });
  const response = await f.management(`/api/projects/${f.project}/sample-data`, 'DELETE');
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe('ingest_pending');
  expect(await prisma.ingestReceipt.count({ where: { projectId: f.project, eventId: 'pending-sample', confirmedAt: null } })).toBe(1);
});

it('upgraded legacy sample/customer collisions retain and rebuild the customer fence', async () => {
  const customer = { id: 'sample-event-0', action: 'customer.retained', occurredAt: new Date(Date.now() - 10_000).toISOString() };
  expect((await f.post(customer)).status).toBe(202);
  const sample = f.row({ id: customer.id, action: 'old.sample', source: 'logbird-sample', occurredAt: new Date().toISOString() });
  await insertEvents(clickhouse, [sample]);
  // Verified: a skipped mutation on the shared server must not leave the old pointers behind.
  await deleteAndVerify(clickhouse, f.project, 'event_ids');
  await clickhouse.insert({
    table: 'event_ids',
    format: 'JSONEachRow',
    values: [{ project_id: f.project, event_id: customer.id, timestamp: sample.timestamp, received_at: sample.received_at }],
  });
  expect((await f.management(`/api/projects/${f.project}/sample-data`, 'DELETE')).status).toBe(204);
  expect(await f.count()).toBe(1);
  expect(await prisma.ingestReceipt.count({ where: { projectId: f.project, eventId: customer.id } })).toBe(1);
  await prisma.ingestReceipt.updateMany({ where: { projectId: f.project }, data: { confirmedAt: new Date(0) } });
  await pruneIngestReceipts(f.project);
  const conflict = await f.post({ ...customer, action: 'overwrite' });
  expect(conflict.status).toBe(202);
  expect(await conflict.json()).toMatchObject({ accepted: 0, rejected: [{ code: 'duplicate_id_conflict' }] });
  expect((await getEvent(clickhouse, f.project, customer.id))?.event.action).toBe(customer.action);
  expect(await f.count()).toBe(1);
}, 60_000);

it('an expired sample-removal crash cache cannot acknowledge or reject a missing raw row', async () => {
  const sample = { id: 'sample-crash-cache', action: 'sample.original', source: 'logbird-sample' };
  expect((await f.post(sample)).status).toBe(202);
  // Simulate a crash after raw deletion and before index/receipt reconciliation.
  await withProjectLock(f.project, () =>
    clickhouse.command({
      query: 'DELETE FROM events WHERE project_id={p:String}',
      query_params: { p: f.project },
      clickhouse_settings: { mutations_sync: '2', lightweight_deletes_sync: '2' },
    }),
  );
  const replacement = { id: sample.id, action: 'customer.after-expiry' };
  expect(await (await f.post(replacement)).json()).toMatchObject({ accepted: 0, rejected: [{ code: 'duplicate_id_conflict' }] });
  await prisma.ingestReceipt.createMany({
    data: Array.from({ length: 501 }, (_, n) => ({
      projectId: f.project,
      organizationId: f.org,
      eventId: `unrelated-expired-${n}`,
      fingerprint: 'v1:fixture',
      receivedAt: new Date(0),
      eventAt: new Date(0),
      confirmedAt: new Date(0),
    })),
  });
  await prisma.ingestReceipt.updateMany({ where: { projectId: f.project, eventId: sample.id }, data: { confirmedAt: new Date(1) } });
  expect(await (await f.post(replacement)).json()).toMatchObject({ accepted: 1, rejected: [] });
  expect((await getEvent(clickhouse, f.project, sample.id))?.event.action).toBe(replacement.action);
  expect(await f.count()).toBe(1);
  expect(await prisma.ingestReceipt.count({ where: { projectId: f.project, confirmedAt: { lt: new Date(2) } } })).toBe(501);
});
