import { getEvent, read } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
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
});
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
});
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
