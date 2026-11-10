import { Readable } from 'node:stream';
import { insertEvents, read } from '@logbird/clickhouse';
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
  console.log('qa91 cleanup verified', f.project, counts, 'receipts/projects/organizations=0');
});

it('settles unresolved rows as per-index rejections (202) when the lease budget expires after a proved parser rejection', async () => {
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
  const response = await f.post([{ ...event('bad'), description: '\ud800' }, event('unsent'), { description: 'missing action' }]);
  expect(response.status).toBe(202);
  const unresolved = expect.stringMatching(/^invalid_event: Storage could not parse this batch and isolation stopped/);
  expect(await response.json()).toMatchObject({
    accepted: 0,
    ids: [],
    rejected: expect.arrayContaining([
      { index: 0, code: 'invalid_event', reason: unresolved },
      { index: 1, code: 'invalid_event', reason: unresolved },
      { index: 2, code: 'invalid_event', reason: expect.stringMatching(/^invalid_event:/) },
    ]),
  });
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
  console.log('qa91 invariants verified', f.project, {
    ids,
    rawAndIndex: 'exactly once',
    minuteEvents: ids.length,
    actors: ids.length,
    attributeCount: ids.length,
    confirmedReceipts: confirmed.length,
  });
}

it('isolates a real normalized JSONEachRow rejection, confirms healthy siblings and exactly retries the same per-index result', async () => {
  const bad = { ...event('bad'), description: '\ud800' };
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
  const batch = [event('healthy'), { ...event('bad'), description: '\ud800' }, event('pending'), { ...event('pending'), action: 'qa91.conflict' }];
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
    return exec({ ...params, values: Readable.from([body]) });
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
  const response = await f.post([event('healthy'), { ...event('bad'), description: '\ud800' }]);
  expect(response.status).toBe(500);
  expect(await read(clickhouse, 'SELECT event_id FROM events WHERE project_id={p:String}', { p: f.project })).toEqual([{ event_id: 'healthy' }]);
  expect(await prisma.ingestReceipt.findMany({ where: { projectId: f.project } })).toEqual([
    expect.objectContaining({ eventId: 'healthy', confirmedAt: null, claimedAt: expect.any(Date) }),
  ]);
  vi.restoreAllMocks();
  // The real ClickHouse acknowledgement above proves this fixture's write completed; no insert remains in flight.
  await prisma.ingestReceipt.deleteMany({ where: { projectId: f.project, confirmedAt: null } });
});
