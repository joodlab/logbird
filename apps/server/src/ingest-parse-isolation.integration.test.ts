import { Readable } from 'node:stream';
import type { ClickHouseSettings } from '@clickhouse/client';
import { AmbiguousInsertError, INGEST_INSERT_SETTINGS, insertEvents, read } from '@logbird/clickhouse';
import * as receipts from '@logbird/database';
import { prisma } from '@logbird/database';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';

let f: ImmutableFixture;
beforeEach(async () => {
  f = await immutableFixture('qa91');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f.cleanup();
  const counts = await destinationCounts();
  expect(counts).toEqual({ events: 0, event_ids: 0, events_by_minute: 0, entities: 0, attribute_keys: 0 });
  expect(await prisma.ingestReceipt.count({ where: { projectId: f.project } })).toBe(0);
  expect(await prisma.project.count({ where: { id: f.project } })).toBe(0);
  expect(await prisma.organization.count({ where: { id: f.org } })).toBe(0);
});

it('returns retryable unresolved indices when the lease budget expires after a proved parser rejection', async () => {
  const exec = clickhouse.exec.bind(clickhouse);
  vi.spyOn(clickhouse, 'exec').mockImplementationOnce(async (params) => {
    try {
      return await exec(params);
    } catch (error) {
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 21_000);
      throw error;
    }
  });
  const writes = vi.spyOn(clickhouse, 'exec');
  const response = await f.post([
    { ...event('bad'), metadata: { fixture: 'qa91', '\ud800': 'bad' } },
    event('unsent'),
    { description: 'missing action' },
  ]);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: {
      code: 'ingest_pending',
      details: {
        accepted: 0,
        ids: [],
        indices: [1],
        eventIds: ['unsent'],
        rejected: expect.arrayContaining([
          { index: 0, code: 'invalid_event', reason: expect.stringMatching(/^invalid_event:/) },
          { index: 2, code: 'invalid_event', reason: expect.stringMatching(/^invalid_event:/) },
        ]),
      },
    },
  });
  expect(response.headers.get('Retry-After')).toBe('1');
  expect(writes).toHaveBeenCalledTimes(1);
  expect(await destinationCounts()).toEqual({ events: 0, event_ids: 0, events_by_minute: 0, entities: 0, attribute_keys: 0 });
  expect(await prisma.ingestReceipt.count({ where: { projectId: f.project } })).toBe(0);
});

async function destinationCounts() {
  const counts: Record<string, number> = {};
  for (const table of ['events', 'event_ids', 'events_by_minute', 'entities', 'attribute_keys'])
    counts[table] = Number(
      (await read<{ n: number }>(clickhouse, `SELECT count() n FROM ${table} WHERE project_id={p:String}`, { p: f.project }))[0]?.n,
    );
  return counts;
}
const event = (id: string) => ({ id, action: 'qa91.fixture', actor: { id, type: 'user' }, metadata: { fixture: 'qa91' } });

async function assertHealthy(ids: string[]) {
  for (const table of ['events', 'event_ids']) {
    const raw = await read<{ id: string; n: number }>(
      clickhouse,
      `SELECT event_id id,count() n FROM ${table} WHERE project_id={p:String} GROUP BY event_id ORDER BY event_id`,
      { p: f.project },
    );
    expect(raw).toEqual(ids.toSorted().map((id) => ({ id, n: 1 })));
  }
  expect(await read(clickhouse, 'SELECT sum(events) n FROM events_by_minute WHERE project_id={p:String}', { p: f.project })).toEqual([
    { n: ids.length },
  ]);
  expect(
    await read(
      clickhouse,
      "SELECT entity_id id,sum(events) n FROM entities WHERE project_id={p:String} AND kind='actor' GROUP BY entity_id ORDER BY entity_id",
      { p: f.project },
    ),
  ).toEqual(ids.toSorted().map((id) => ({ id, n: 1 })));
  expect(await read(clickhouse, 'SELECT key,sum(count) n FROM attribute_keys WHERE project_id={p:String} GROUP BY key', { p: f.project })).toEqual([
    { key: 'metadata.fixture', n: ids.length },
  ]);
  const confirmed = await prisma.ingestReceipt.findMany({ where: { projectId: f.project }, orderBy: { eventId: 'asc' } });
  expect(confirmed.map((r) => r.eventId)).toEqual(ids.toSorted());
  expect(confirmed.every((r) => r.confirmedAt !== null)).toBe(true);
}

it('isolates a real normalized JSONEachRow rejection, confirms healthy siblings and exactly retries the same per-index result', async () => {
  const bad = { ...event('bad'), metadata: { fixture: 'qa91', '\ud800': 'bad' } };
  const capped = { ...event('healthy-b'), description: `${'a'.repeat(4095)}😀` };
  const batch = [event('healthy-a'), bad, capped, bad, { ...bad, action: 'qa91.conflict' }];
  // No transport or storage fake: prove a late parser rejection writes NONE of the destinations.
  await expect(
    insertEvents(
      clickhouse,
      batch.slice(0, 3).map((e) => f.row(e)),
    ),
  ).rejects.toMatchObject({ code: '25' });
  expect(await destinationCounts()).toEqual({ events: 0, event_ids: 0, events_by_minute: 0, entities: 0, attribute_keys: 0 });
  const response = await f.post(batch);
  expect(response.status).toBe(202);
  const body = await response.json();
  expect(body).toMatchObject({
    accepted: 2,
    ids: ['healthy-a', 'healthy-b'],
    rejected: expect.arrayContaining([
      { index: 1, code: 'invalid_event', reason: expect.stringMatching(/^invalid_event:/) },
      { index: 3, code: 'invalid_event', reason: expect.stringMatching(/^invalid_event:/) },
      { index: 4, code: 'duplicate_id_conflict', reason: expect.stringMatching(/^duplicate_id_conflict:/) },
    ]),
  });
  expect(body.rejected).toHaveLength(3);
  await assertHealthy(['healthy-a', 'healthy-b']);
  const writes = vi.spyOn(clickhouse, 'exec');
  const retry = await f.post(batch);
  expect(retry.status).toBe(202);
  expect(await retry.json()).toEqual(body);
  expect(writes).toHaveBeenCalled(); // Only the bad id is retried; storage evidence stays exactly once.
  await assertHealthy(['healthy-a', 'healthy-b']);
});

it('composes confirmed, parse-rejected, conflicting and ambiguous child indices without resending the ambiguous child', async () => {
  const batch = [
    event('healthy'),
    { ...event('bad'), metadata: { fixture: 'qa91', '\ud800': 'bad' } },
    event('pending'),
    { ...event('pending'), action: 'qa91.conflict' },
  ];
  const exec = clickhouse.exec.bind(clickhouse);
  let ambiguousStatements = 0;
  vi.spyOn(clickhouse, 'exec').mockImplementation(async (params) => {
    if (!('values' in params)) return exec(params);
    const chunks: Buffer[] = [];
    for await (const chunk of params.values as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const sent = body
      .toString()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    if (sent.length === 1 && sent[0].event_id === 'pending') {
      ambiguousStatements++;
      throw Object.assign(new Error('Parse failed (while pushing to view logbird.qa91_mv)'), { code: '25' });
    }
    try {
      return await exec({ ...params, values: Readable.from([body]) });
    } catch (error) {
      if (error instanceof Error) error.message = error.message.replace(/\(at row \d+\)/g, '');
      throw error;
    }
  });
  const response = await f.post(batch);
  expect(response.status).toBe(503);
  const body = await response.json();
  expect(body).toMatchObject({
    error: {
      code: 'ingest_pending',
      details: {
        accepted: 1,
        ids: ['healthy'],
        indices: [2],
        eventIds: ['pending'],
        rejected: expect.arrayContaining([
          { index: 1, code: 'invalid_event', reason: expect.stringMatching(/^invalid_event:/) },
          { index: 3, code: 'duplicate_id_conflict', reason: expect.stringMatching(/^duplicate_id_conflict:/) },
        ]),
      },
    },
  });
  expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
  expect(ambiguousStatements).toBe(1);
  expect(await prisma.ingestReceipt.findUnique({ where: { projectId_eventId: { projectId: f.project, eventId: 'bad' } } })).toBeNull();
  expect(await prisma.ingestReceipt.findUniqueOrThrow({ where: { projectId_eventId: { projectId: f.project, eventId: 'healthy' } } })).toMatchObject({
    confirmedAt: expect.any(Date),
  });
  expect(await prisma.ingestReceipt.findUniqueOrThrow({ where: { projectId_eventId: { projectId: f.project, eventId: 'pending' } } })).toMatchObject({
    confirmedAt: null,
    claimedAt: expect.any(Date),
  });
  expect(await read(clickhouse, 'SELECT event_id FROM events WHERE project_id={p:String}', { p: f.project })).toEqual([{ event_id: 'healthy' }]);
  vi.restoreAllMocks();
  // This fixture's fake consumed the body but deliberately never handed it to ClickHouse.
  await prisma.ingestReceipt.deleteMany({ where: { projectId: f.project, eventId: 'pending', confirmedAt: null } });
});

it('keeps acknowledged child claims if Postgres confirmation fails', async () => {
  const confirm = receipts.confirmIngestReceipts;
  vi.spyOn(receipts, 'confirmIngestReceipts').mockImplementation(async (...args) => {
    if (args[1].length) throw new Error('fictional confirmation failure');
    return confirm(...args);
  });
  const response = await f.post([event('healthy'), { ...event('bad'), metadata: { fixture: 'qa91', '\ud800': 'bad' } }]);
  expect(response.status).toBe(500);
  expect(await read(clickhouse, 'SELECT event_id FROM events WHERE project_id={p:String}', { p: f.project })).toEqual([{ event_id: 'healthy' }]);
  expect(await prisma.ingestReceipt.findMany({ where: { projectId: f.project } })).toEqual([
    expect.objectContaining({ eventId: 'healthy', confirmedAt: null, claimedAt: expect.any(Date) }),
  ]);
  vi.restoreAllMocks();
  // The real ClickHouse acknowledgement above proves this fixture's write completed; no insert remains in flight.
  await prisma.ingestReceipt.deleteMany({ where: { projectId: f.project, confirmedAt: null } });
});

const badEvent = (id: string) => ({ ...event(id), metadata: { fixture: 'qa91', '\ud800': 'bad' } });
it.each([5, 20, 80])('isolates a real 1000-row body with %i bad keys without rejecting a healthy row', async (badCount) => {
  const batch = Array.from({ length: 1000 }, (_, i) => (i < badCount ? badEvent(`bad-${i}`) : event(`healthy-${i}`)));
  const writes = vi.spyOn(clickhouse, 'exec');
  const response = await f.post(batch);
  const wire = await response.json();
  const details = response.status === 202 ? wire : wire.error.details;
  expect(details.rejected.every((r: { index: number }) => r.index < badCount)).toBe(true);
  if (badCount <= 20) {
    expect(response.status).toBe(202);
    expect(details.rejected).toHaveLength(badCount);
    expect(writes).toHaveBeenCalledTimes(badCount + 1);
    await assertHealthy(batch.slice(badCount).map((e) => e.id));
    expect((await f.post(batch)).status).toBe(202);
    await assertHealthy(batch.slice(badCount).map((e) => e.id));
  } else {
    expect(response.status).toBe(503);
    expect(wire.error.code).toBe('ingest_pending');
    expect(details.indices.length).toBeGreaterThan(0);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(await prisma.ingestReceipt.count({ where: { projectId: f.project } })).toBe(0);
    // Respect settled per-index results when resubmitting the unfinished work.
    const remaining = details.indices.map((i: number) => batch[i]);
    expect((await f.post(remaining)).status).toBe(202);
    await assertHealthy(batch.slice(badCount).map((e) => e.id));
    expect((await f.post(batch)).status).toBe(503);
    await assertHealthy(batch.slice(badCount).map((e) => e.id));
  }
});
it('repairs a lone surrogate in occurredAt and search columns without changing raw input', async () => {
  const input = { ...event('unicode'), occurredAt: '\ud800', description: '\udfff', changes: [{ field: 'name', before: '\ud800', after: '\udfff' }] };
  const response = await f.post(input);
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ ids: ['unicode'], rejected: [], warnings: [{ index: 0, reason: expect.any(String) }] });
  const [stored] = await read<{ payload: string; description: string; rejected: string }>(
    clickhouse,
    "SELECT payload,description,attributes['logbird.occurredAt.rejected'] rejected FROM events WHERE project_id={p:String}",
    { p: f.project },
  );
  expect(JSON.parse(stored!.payload)).toEqual(input);
  expect(stored).toMatchObject({ description: '\ufffd', rejected: '\ufffd' });
});
it('verifies the native row number identifies the first of several bad rows', async () => {
  await expect(
    insertEvents(
      clickhouse,
      [event('a'), badEvent('b'), event('c'), badEvent('d')].map((e) => f.row(e)),
    ),
  ).rejects.toMatchObject({ code: '25', message: expect.stringMatching(/\(at row 2\).*WaitForAsyncInsert/s) });
  expect((await destinationCounts()).events).toBe(0);
});
it('reproduces sync partial writes, fails safe under clamped pins, and prevents writes with pinned blocks', async () => {
  const rows = Array.from({ length: 3000 }, (_, i) => f.row(i === 2499 ? badEvent(`sync-${i}`) : event(`sync-${i}`)));
  const body = `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
  const low: ClickHouseSettings = {
    async_insert: 1,
    wait_for_async_insert: 1,
    async_insert_max_data_size: '1000',
    min_insert_block_size_rows: '100',
    min_insert_block_size_bytes: '1',
    max_insert_block_size: '100',
    input_format_parallel_parsing: 0,
  };
  const exec = clickhouse.exec.bind(clickhouse);
  const native = async (settings: ClickHouseSettings) => {
    const result = await exec({ query: 'INSERT INTO events FORMAT JSONEachRow', values: Readable.from([body]), clickhouse_settings: settings });
    for await (const _chunk of result.stream) {
      /* consume ack */
    }
  };
  await expect(native(low)).rejects.toMatchObject({ code: '25', message: expect.stringMatching(/\(at row 2500\)/) });
  const partial = await destinationCounts();
  expect(partial.events).toBeGreaterThan(0);
  expect(partial.event_ids).toBeGreaterThan(0);
  await f.cleanup();
  expect(await destinationCounts()).toEqual({ events: 0, event_ids: 0, events_by_minute: 0, entities: 0, attribute_keys: 0 });
  // Emulate a server constraint clamping both async and block pins, without changing any profile.
  vi.spyOn(clickhouse, 'exec').mockImplementation((params) => exec({ ...params, clickhouse_settings: { ...params.clickhouse_settings, ...low } }));
  await expect(insertEvents(clickhouse, rows)).rejects.toBeInstanceOf(AmbiguousInsertError);
  expect((await destinationCounts()).events).toBeGreaterThan(0);
  vi.restoreAllMocks();
  await f.cleanup();
  // A lowered async constraint still falls back to sync; query-level block pins keep it unwritten.
  vi.spyOn(clickhouse, 'exec').mockImplementation((params) =>
    exec({ ...params, clickhouse_settings: { ...low, ...params.clickhouse_settings, async_insert_max_data_size: '1000' } }),
  );
  await expect(insertEvents(clickhouse, rows)).rejects.toBeInstanceOf(AmbiguousInsertError);
  expect(await destinationCounts()).toEqual({ events: 0, event_ids: 0, events_by_minute: 0, entities: 0, attribute_keys: 0 });
  vi.restoreAllMocks();
  // Per-client lowered defaults emulate a session profile; all real query pins win over them.
  vi.spyOn(clickhouse, 'exec').mockImplementation((params) => exec({ ...params, clickhouse_settings: { ...low, ...params.clickhouse_settings } }));
  await expect(insertEvents(clickhouse, rows)).rejects.toMatchObject({ code: '25', message: expect.stringContaining('WaitForAsyncInsert') });
  expect(Number(INGEST_INSERT_SETTINGS.min_insert_block_size_rows)).toBeGreaterThanOrEqual(rows.length);
  expect(await destinationCounts()).toEqual({ events: 0, event_ids: 0, events_by_minute: 0, entities: 0, attribute_keys: 0 });
});
it.each([false, true])('keeps written siblings and composes unavailable with pending=%s', async (withPending) => {
  const claim = receipts.claimIngestReceipts;
  vi.spyOn(receipts, 'claimIngestReceipts').mockImplementation(async (...args) => {
    const found = await claim(...args);
    return found.map((r) => (r.eventId === 'unavailable' ? { ...r, claimedAt: new Date(Date.now() + 600_000) } : r));
  });
  const exec = clickhouse.exec.bind(clickhouse);
  vi.spyOn(clickhouse, 'exec').mockImplementation(async (params) => {
    if (!('values' in params)) return exec(params);
    const chunks: Buffer[] = [];
    for await (const chunk of params.values as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks),
      rows = body
        .toString()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    if (rows.length === 1 && rows[0].event_id === 'unavailable') throw Object.assign(new Error('Unknown table'), { code: '60' });
    if (rows.length === 1 && rows[0].event_id === 'pending') throw new Error('fictional reset after handoff');
    try {
      return await exec({ ...params, values: Readable.from([body]) });
    } catch (error) {
      if (error instanceof Error) error.message = error.message.replace(/\(at row \d+\)/g, '');
      throw error;
    }
  });
  const batch = [event('healthy-a'), event('healthy-b'), event('unavailable'), ...(withPending ? [event('pending')] : []), badEvent('bad')];
  const response = await f.post(batch);
  expect(response.status).toBe(503);
  const wire = await response.json();
  expect(wire.error.code).toBe(withPending ? 'ingest_pending' : 'ingest_unavailable');
  expect(wire.error.details).toMatchObject({
    ids: ['healthy-a', 'healthy-b'],
    accepted: 2,
    eventIds: withPending ? ['unavailable', 'pending'] : ['unavailable'],
    rejected: [{ index: batch.length - 1, code: 'invalid_event', reason: expect.any(String) }],
  });
  expect(Number(response.headers.get('Retry-After'))).toBeLessThan(100);
  expect(await prisma.ingestReceipt.findUnique({ where: { projectId_eventId: { projectId: f.project, eventId: 'unavailable' } } })).toBeNull();
  expect(await read(clickhouse, 'SELECT event_id FROM events WHERE project_id={p:String} ORDER BY event_id', { p: f.project })).toEqual([
    { event_id: 'healthy-a' },
    { event_id: 'healthy-b' },
  ]);
  vi.restoreAllMocks();
  await prisma.ingestReceipt.deleteMany({ where: { projectId: f.project, eventId: 'pending', confirmedAt: null } });
});
