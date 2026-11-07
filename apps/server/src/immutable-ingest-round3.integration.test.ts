import { eventFingerprint, insertEvents, read } from '@logbird/clickhouse';
import { ingestPendingDetailsSchema } from '@logbird/contracts';
import { prisma, withProjectLock } from '@logbird/database';
import { recoverProjectIngest } from '@logbird/worker/ingest-recovery';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { legacyFingerprint3a1541f, normalizeEvent3a1541f } from '../../../packages/clickhouse/src/fixtures/identity-3a1541f';
import { clickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';

let f: ImmutableFixture,
  clock = Date.now();
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
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
const input = { id: 'original', action: 'original.event' };
it('settles a mismatching stored row terminally instead of keeping an expired claim', async () => {
  await f.pending(input, { expired: true });
  const stored = { ...input, action: 'stored.winner' };
  await insertEvents(clickhouse, [f.row(stored)]);
  const commands = vi.spyOn(clickhouse, 'command');
  await recoverProjectIngest(clickhouse, f.project);
  const result = await f.post(input);
  expect(result.status).toBe(202);
  expect(await result.json()).toMatchObject({ accepted: 0, rejected: [{ index: 0, code: 'duplicate_id_conflict' }] });
  expect((await f.post(stored)).status).toBe(202);
  expect(await f.count()).toBe(1);
  expect(commands.mock.calls.filter(([p]) => p.query === 'SYSTEM FLUSH ASYNC INSERT QUEUE')).toHaveLength(1);
  expect(await prisma.ingestReceipt.count({ where: { projectId: f.project, confirmedAt: { not: null } } })).toBe(1);
});
it('prechecks five different-content retries without a flush and releases a ready id after grace', async () => {
  await f.pending(input, { expired: true });
  await recoverProjectIngest(clickhouse, f.project);
  const commands = vi.spyOn(clickhouse, 'command');
  for (let i = 0; i < 5; i++) expect((await f.post({ ...input, action: 'new.content' })).status).toBe(503);
  expect(commands.mock.calls.filter(([p]) => p.query === 'SYSTEM FLUSH ASYNC INSERT QUEUE')).toHaveLength(0);
  vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
  expect((await f.post({ ...input, action: 'new.content' })).status).toBe(202);
  expect(await f.count()).toBe(1);
  expect(commands.mock.calls.filter(([p]) => p.query === 'SYSTEM FLUSH ASYNC INSERT QUEUE')).toHaveLength(0);
});
it('keeps the exclusive lock through a worker-readied replay', async () => {
  await f.pending(input, { expired: true });
  await recoverProjectIngest(clickhouse, f.project);
  const insert = clickhouse.insert.bind(clickhouse);
  let checked = false;
  vi.spyOn(clickhouse, 'insert').mockImplementation(async (params) => {
    if (params.table === 'events') {
      checked = true;
      await expect(withProjectLock(f.project, async () => undefined, { mode: 'shared', waitMs: 0 })).rejects.toMatchObject({
        name: 'ProjectBusyError',
      });
    }
    return insert(params);
  });
  expect((await f.post(input)).status).toBe(202);
  expect(checked).toBe(true);
  expect(await f.count()).toBe(1);
});
it('reports all settled indices, codes, warnings and lease-aware timing in a pending body', async () => {
  expect((await f.post({ id: 'conflict', action: 'first' })).status).toBe(202);
  await f.pending(input);
  const result = await f.post([
    input,
    { id: 'conflict', action: 'second' },
    { id: 'healthy', action: 'healthy', occurredAt: 'invalid' },
    { id: `unsafe${String.fromCharCode(0)}id`, action: 'unsafe' },
  ]);
  expect(result.status).toBe(503);
  expect(Number(result.headers.get('Retry-After'))).toBe(70);
  const details = ingestPendingDetailsSchema.parse((await result.json()).error.details);
  expect(details).toMatchObject({ accepted: 1, ids: ['healthy'], indices: [0], eventIds: ['original'], warnings: [{ index: 2 }] });
  expect(details.rejected).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ index: 1, code: 'duplicate_id_conflict' }),
      expect.objectContaining({ index: 3, code: 'invalid_event_id' }),
    ]),
  );
  expect(details.rejected.map((r) => r.index).sort()).toEqual([1, 3]);
  expect(await f.count()).toBe(2);
});
function oldRow(input: unknown, receivedAt: Date) {
  const result = normalizeEvent3a1541f(input, { projectId: f.project, receivedAt });
  if (!result.ok) throw new Error(result.reason);
  return result.row;
}
it('reads frozen old-admission evidence and upgrades its receipt without blocking a healthy sibling', async () => {
  const receivedAt = new Date(),
    oldInput = { id: 'x'.repeat(257), action: 'legacy.original' },
    row = oldRow(oldInput, receivedAt);
  await insertEvents(clickhouse, [row]);
  await prisma.ingestReceipt.create({
    data: {
      projectId: f.project,
      organizationId: f.org,
      eventId: row.event_id,
      fingerprint: legacyFingerprint3a1541f(row),
      receivedAt,
      eventAt: new Date(row.timestamp),
      confirmedAt: receivedAt,
    },
  });
  const response = await f.post([
    { ...oldInput, id: row.event_id },
    { id: 'healthy', action: 'healthy' },
  ]);
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ accepted: 1, ids: ['healthy'], rejected: [{ index: 0, code: 'duplicate_id_conflict' }] });
  expect(
    (await prisma.ingestReceipt.findUniqueOrThrow({ where: { projectId_eventId: { projectId: f.project, eventId: row.event_id } } })).fingerprint,
  ).toBe(eventFingerprint(row));
  expect(await f.count()).toBe(2);
});
it('recovers a missing old long-id claim using the safe stored id and its original clock', async () => {
  const receivedAt = new Date(Date.now() - 120_000),
    oldInput = { id: 'x'.repeat(257), action: 'legacy.missing' },
    row = oldRow(oldInput, receivedAt);
  await prisma.ingestReceipt.create({
    data: {
      projectId: f.project,
      organizationId: f.org,
      eventId: row.event_id,
      fingerprint: legacyFingerprint3a1541f(row),
      receivedAt,
      eventAt: new Date(row.timestamp),
      claimedAt: new Date(Date.now() - 80_000),
    },
  });
  expect((await f.post({ ...oldInput, id: row.event_id })).status).toBe(202);
  const stored = await read<{ received_at: string }>(clickhouse, 'SELECT received_at FROM events WHERE project_id={p:String}', { p: f.project });
  const first = stored[0];
  if (!first) throw new Error('Missing recovered row');
  expect(new Date(`${first.received_at.replace(' ', 'T')}Z`).toISOString()).toBe(receivedAt.toISOString());
  expect(
    (await prisma.ingestReceipt.findUniqueOrThrow({ where: { projectId_eventId: { projectId: f.project, eventId: row.event_id } } })).fingerprint,
  ).toMatch(/^v1:/);
});

it('throttles failed global flush attempts while healthy sibling rows still commit', async () => {
  await f.pending(input, { expired: true });
  const command = clickhouse.command.bind(clickhouse);
  const calls = vi
    .spyOn(clickhouse, 'command')
    .mockImplementation((params) =>
      params.query === 'SYSTEM FLUSH ASYNC INSERT QUEUE' ? Promise.reject(new Error('QA missing flush grant')) : command(params),
    );
  expect((await f.post(input)).status).toBe(503);
  for (let i = 0; i < 4; i++) {
    const response = await f.post([input, { id: `healthy-${i}`, action: 'healthy' }]);
    expect(response.status).toBe(503);
    expect((await response.json()).error.details).toMatchObject({ accepted: 1, ids: [`healthy-${i}`], indices: [0] });
  }
  expect(calls.mock.calls.filter(([p]) => p.query === 'SYSTEM FLUSH ASYNC INSERT QUEUE')).toHaveLength(1);
  expect(await f.count()).toBe(4);
});
