import { Readable } from 'node:stream';
import type { ClickHouseSettings } from '@clickhouse/client';
import { AmbiguousInsertError, INGEST_INSERT_SETTINGS, insertEvents, read } from '@logbird/clickhouse';
import * as receipts from '@logbird/database';
import { prisma } from '@logbird/database';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';
import { installIngestStorageFault, storageFaultBody } from './ingest-storage-fault-fixture';

let f: ImmutableFixture;
beforeEach(async () => {
  f = await immutableFixture('qa91');
  installIngestStorageFault();
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
  const response = await f.post([badEvent('bad'), event('unsent'), { description: 'missing action' }], 0, { 'Logbird-Retry': 'subset' });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: {
      code: 'ingest_pending',
      details: {
        accepted: 0,
        ids: [],
        indices: [0, 1],
        eventIds: ['bad', 'unsent'],
        rejected: expect.arrayContaining([{ index: 2, code: 'invalid_event', reason: expect.stringMatching(/^invalid_event:/) }]),
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
const badEvent = (id: string) => ({ ...event(id), metadata: { fixture: 'qa91', qa91StorageParseFault: true } });
// Real ClickHouse parser errors (version-dependent wording), never a mocked error classification.
const parseCode = expect.stringMatching(/^(25|27|53|72)$/);

it('rejects lone-surrogate attribute keys before INSERT, with no parse-isolation statements (#153)', async () => {
  const writes = vi.spyOn(clickhouse, 'exec');
  const bad = [
    { ...event('bad-top'), '\ud800': 1 },
    { ...event('bad-nested'), metadata: { nested: { '\udfff': 1 } } },
    { ...event('bad-target'), targets: [{ type: 'record', id: 'x', nested: { '\ud800': 1 } }] },
  ];
  const response = await f.post(bad);
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({
    accepted: 0,
    ids: [],
    rejected: bad.map((_, index) => ({ index, code: 'invalid_event', reason: 'invalid_event: Attribute keys must be valid Unicode' })),
  });
  expect(writes).not.toHaveBeenCalled();
  expect(await f.count()).toBe(0);
  const healthy = await f.post({ ...event('valid-pair'), metadata: { nested: { '\ud83d\ude00': 1 } } });
  expect(healthy.status).toBe(202);
  expect(await healthy.json()).toMatchObject({ accepted: 1, rejected: [] });
  expect(writes).toHaveBeenCalledTimes(1);
});

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
  const bad = badEvent('bad');
  const capped = { ...event('healthy-b'), description: `${'a'.repeat(4095)}😀` };
  const batch = [event('healthy-a'), bad, capped, bad, { ...bad, action: 'qa91.conflict' }];
  // The integration-only adapter corrupts a typed field; REAL ClickHouse must reject before any destination writes.
  await expect(
    insertEvents(
      clickhouse,
      batch.slice(0, 3).map((e) => f.row(e)),
    ),
  ).rejects.toMatchObject({ code: parseCode, message: expect.stringContaining('WaitForAsyncInsert') });
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
  const batch = [event('healthy'), badEvent('bad'), event('pending'), { ...event('pending'), action: 'qa91.conflict' }];
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
  const response = await f.post([event('healthy'), badEvent('bad')]);
  expect(response.status).toBe(500);
  expect(await read(clickhouse, 'SELECT event_id FROM events WHERE project_id={p:String}', { p: f.project })).toEqual([{ event_id: 'healthy' }]);
  expect(await prisma.ingestReceipt.findMany({ where: { projectId: f.project } })).toEqual([
    expect.objectContaining({ eventId: 'healthy', confirmedAt: null, claimedAt: expect.any(Date) }),
  ]);
  vi.restoreAllMocks();
  // The real ClickHouse acknowledgement above proves this fixture's write completed; no insert remains in flight.
  await prisma.ingestReceipt.deleteMany({ where: { projectId: f.project, confirmedAt: null } });
});

it.each([3, 20, 80])('isolates a real 1000-row body with %i injected storage faults without rejecting a healthy row', async (badCount) => {
  const badIndices = new Set(Array.from({ length: badCount }, (_, index) => Math.floor(((index + 1) * 1000) / (badCount + 1))));
  const batch = Array.from({ length: 1000 }, (_, i) => (badIndices.has(i) ? badEvent(`bad-${i}`) : event(`healthy-${i}`)));
  const healthyIds = batch.filter((_, index) => !badIndices.has(index)).map((e) => e.id);
  const writes = vi.spyOn(clickhouse, 'exec');
  const warnings = vi.spyOn(console, 'warn');
  const response = await f.post(batch, 0, { 'Logbird-Retry': 'subset' });
  const wire = await response.json();
  const details = response.status === 202 ? wire : wire.error.details;
  expect(details.rejected.every((r: { index: number }) => badIndices.has(r.index))).toBe(true);
  expect(details.ids.length).toBeGreaterThan(0); // Prefix writes survive a later isolation limit.
  if (badCount === 3) {
    expect(response.status).toBe(202);
    expect(details.rejected).toHaveLength(badCount);
    expect(writes).toHaveBeenCalledTimes(3 * badCount + 1); // Every named row has a singleton canary.
    await assertHealthy(healthyIds);
    expect((await f.post(batch)).status).toBe(202);
    await assertHealthy(healthyIds);
  } else {
    expect(response.status).toBe(503);
    expect(wire.error.code).toBe('ingest_pending');
    expect(details.indices.length).toBeGreaterThan(0);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(
      warnings.mock.calls.some(([line]) => {
        const warning = JSON.parse(String(line));
        return warning.event === 'ingest.parse_isolation_limited' && warning.projectId === f.project && warning.reason === 'bytes';
      }),
    ).toBe(true);
    expect(await prisma.ingestReceipt.count({ where: { projectId: f.project, confirmedAt: { not: null } } })).toBe(details.ids.length);
    await assertHealthy(details.ids);
    // Respect settled per-index results when resubmitting the unfinished work.
    let remaining: ReturnType<typeof event>[] = details.indices.map((i: number) => batch[i]);
    let rejectedCount = details.rejected.length;
    // The byte budget may require several attempts. Only resubmit the unresolved indices from each response.
    for (let attempt = 0; ; attempt++) {
      expect(attempt).toBeLessThan(badCount);
      const retry = await f.post(remaining, 0, { 'Logbird-Retry': 'subset' });
      const retryBody = await retry.json();
      const retryDetails = retry.status === 202 ? retryBody : retryBody.error.details;
      expect(retryDetails.rejected.every((r: { index: number }) => remaining[r.index]!.id.startsWith('bad-'))).toBe(true);
      rejectedCount += retryDetails.rejected.length;
      if (retry.status === 202) break;
      expect(retry.status).toBe(503);
      expect(retryBody.error.code).toBe('ingest_pending');
      expect(retryBody.error.details.rejected.length).toBeGreaterThan(0);
      const next = retryBody.error.details.indices.map((i: number) => remaining[i]);
      expect(next.length).toBeLessThan(remaining.length);
      remaining = next;
    }
    expect(rejectedCount).toBe(badCount);
    await assertHealthy(healthyIds);
    expect((await f.post(batch, 0, { 'Logbird-Retry': 'subset' })).status).toBe(503);
    await assertHealthy(healthyIds);
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
  ).rejects.toMatchObject({ code: parseCode, message: expect.stringMatching(/\(at row 2\).*WaitForAsyncInsert/s) });
  expect((await destinationCounts()).events).toBe(0);
});
it('reports a statement-relative row number when two concurrent bodies share one async flush', async () => {
  const healthy = Array.from({ length: 500 }, (_, i) => event(`qa91-shared-healthy-${i}`));
  const poison = [event('qa91-shared-a'), event('qa91-shared-b'), badEvent('qa91-shared-bad'), event('qa91-shared-c')];
  const healthyQuery = `${f.project}-healthy`,
    poisonQuery = `${f.project}-poison`;
  const settings: ClickHouseSettings = {
    ...INGEST_INSERT_SETTINGS,
    async_insert: 1,
    wait_for_async_insert: 1,
    max_execution_time: 30,
    wait_for_async_insert_timeout: 40,
    async_insert_use_adaptive_busy_timeout: 0,
    async_insert_busy_timeout_ms: 5000,
    async_insert_busy_timeout_max_ms: 5000,
  };
  const native = async (batch: ReturnType<typeof event>[], queryId: string) => {
    const body = storageFaultBody(batch.map((input) => `${JSON.stringify(f.row(input))}\n`).join(''));
    const result = await clickhouse.exec({
      query: 'INSERT INTO events FORMAT JSONEachRow',
      query_id: queryId,
      values: Readable.from([body]),
      clickhouse_settings: settings,
    });
    for await (const _chunk of result.stream) {
      /* consume acknowledgement */
    }
  };
  const first = native(healthy, healthyQuery);
  const pending = [first];
  // Attach handlers immediately, including if queue inspection fails; cleanup must wait for every INSERT.
  void first.catch(() => {
    /* The result is asserted below and awaited again before fixture cleanup. */
  });
  try {
    await vi.waitFor(
      async () => {
        expect(
          await read(clickhouse, 'SELECT count() n FROM system.asynchronous_inserts WHERE has(entries.query_id, {q:String})', { q: healthyQuery }),
        ).toEqual([{ n: 1 }]);
      },
      { timeout: 3000, interval: 50 },
    );
    const second = native(poison, poisonQuery);
    pending.push(second);
    const [good, bad] = await Promise.allSettled([first, second]);
    expect(good!.status).toBe('fulfilled');
    expect(bad!.status).toBe('rejected');
    if (bad!.status !== 'rejected') throw new Error('Expected the qa91 poison statement to fail');
    expect(bad.reason).toMatchObject({ code: parseCode, message: expect.stringMatching(/\(at row 3\).*WaitForAsyncInsert/s) });
    for (const table of ['events', 'event_ids']) {
      expect(
        await read(clickhouse, `SELECT event_id id,count() n FROM ${table} WHERE project_id={p:String} GROUP BY event_id ORDER BY event_id`, {
          p: f.project,
        }),
      ).toEqual(healthy.map((input) => ({ id: input.id, n: 1 })).sort((a, b) => a.id.localeCompare(b.id)));
    }
    expect(await read(clickhouse, 'SELECT sum(events) n FROM events_by_minute WHERE project_id={p:String}', { p: f.project })).toEqual([{ n: 500 }]);
    // See https://clickhouse.com/docs/operations/system-tables/asynchronous_insert_log.
    // Require the same flush ID: merely overlapping request lifetimes would not prove shared parsing.
    // The test environment must enable asynchronous_insert_log; wait for its normal log flush, without SYSTEM commands.
    await vi.waitFor(
      async () => {
        const entries = await read<{ query_id: string; flush_query_id: string }>(
          clickhouse,
          'SELECT query_id,flush_query_id FROM system.asynchronous_insert_log WHERE query_id IN {ids:Array(String)} ORDER BY query_id',
          { ids: [healthyQuery, poisonQuery] },
        );
        expect(entries.map((entry) => entry.query_id).sort()).toEqual([healthyQuery, poisonQuery].sort());
        expect(entries[0]!.flush_query_id).not.toBe('');
        expect(entries[1]!.flush_query_id).toBe(entries[0]!.flush_query_id);
      },
      { timeout: 20_000, interval: 250 },
    );
  } finally {
    await Promise.allSettled(pending);
  }
}, 60_000);
it('reproduces sync partial writes under client-side pin overrides and prevents writes with pinned blocks', async () => {
  const rows = Array.from({ length: 3000 }, (_, i) => f.row(i === 2499 ? badEvent(`sync-${i}`) : event(`sync-${i}`)));
  const body = storageFaultBody(`${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
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
  await expect(native(low)).rejects.toMatchObject({ code: parseCode, message: expect.stringMatching(/\(at row 2500\)/) });
  const partial = await destinationCounts();
  expect(partial.events).toBeGreaterThan(0);
  expect(partial.event_ids).toBeGreaterThan(0);
  await f.cleanup();
  expect(await destinationCounts()).toEqual({ events: 0, event_ids: 0, events_by_minute: 0, entities: 0, attribute_keys: 0 });
  // Override pins on the client, without changing a server profile. A real server constraint rejects with code 452.
  vi.spyOn(clickhouse, 'exec').mockImplementation((params) => exec({ ...params, clickhouse_settings: { ...params.clickhouse_settings, ...low } }));
  await expect(insertEvents(clickhouse, rows, undefined, body)).rejects.toBeInstanceOf(AmbiguousInsertError);
  expect((await destinationCounts()).events).toBeGreaterThan(0);
  vi.restoreAllMocks();
  await f.cleanup();
  // A client-side lowered async pin still falls back to sync; query-level block pins keep it unwritten.
  vi.spyOn(clickhouse, 'exec').mockImplementation((params) =>
    exec({ ...params, clickhouse_settings: { ...low, ...params.clickhouse_settings, async_insert_max_data_size: '1000' } }),
  );
  await expect(insertEvents(clickhouse, rows, undefined, body)).rejects.toBeInstanceOf(AmbiguousInsertError);
  expect(await destinationCounts()).toEqual({ events: 0, event_ids: 0, events_by_minute: 0, entities: 0, attribute_keys: 0 });
  vi.restoreAllMocks();
  // Per-client lowered defaults emulate a session profile; all real query pins win over them.
  vi.spyOn(clickhouse, 'exec').mockImplementation((params) => exec({ ...params, clickhouse_settings: { ...low, ...params.clickhouse_settings } }));
  await expect(insertEvents(clickhouse, rows, undefined, body)).rejects.toMatchObject({
    code: parseCode,
    message: expect.stringContaining('WaitForAsyncInsert'),
  });
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
