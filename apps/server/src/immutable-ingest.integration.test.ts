import { eventFingerprint, exportEvents, getEvent, insertEvents, legacyEventFingerprint, read, searchEvents } from '@logbird/clickhouse';
import { prisma, pruneIngestReceipts, purgeIngestReceipts, withProjectLock } from '@logbird/database';
import { recoverProjectIngest } from '@logbird/worker/ingest-recovery';
import { enforceProjectRetention } from '@logbird/worker/retention';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
let f: ImmutableFixture;
beforeEach(async () => {
  f = await immutableFixture();
});
afterEach(async () => {
  await f.cleanup();
});
const original = { id: 'original', action: 'evidence.original', actor: { id: 'actor' }, metadata: { status: 'pending' } };

it('exact retries preserve the first clock and every rollup contribution', async () => {
  expect((await f.post(original)).status).toBe(202);
  expect((await f.post(original)).status).toBe(202);
  const counts = await read(
    clickhouse,
    `SELECT
    (SELECT count() FROM events WHERE project_id={p:String}) raw,
    (SELECT sum(events) FROM events_by_minute WHERE project_id={p:String}) minutes,
    (SELECT sum(events) FROM entities WHERE project_id={p:String} AND kind='actor') actors,
    (SELECT sum(count) FROM attribute_keys WHERE project_id={p:String}) attributes`,
    { p: f.project },
  );
  expect(counts[0]).toEqual({ raw: 1, minutes: 1, actors: 1, attributes: 1 });
});
it('rejects confirmed different content and timestamps with actionable reasons', async () => {
  expect((await f.post(original)).status).toBe(202);
  for (const change of [{ action: 'different' }, { occurredAt: new Date(Date.now() - 1000).toISOString() }, { actor: { id: 42 } }]) {
    const response = await f.post({ ...original, ...change });
    expect(await response.json()).toMatchObject({ accepted: 0, rejected: [{ index: 0, reason: expect.stringMatching(/^duplicate_id_conflict:/) }] });
  }
  expect(await f.count()).toBe(1);
});
it('arbitrates two in-process HTTP app instances against shared DBs', async () => {
  const input = { ...original, occurredAt: new Date().toISOString() };
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => f.post({ ...input, action: `winner.${i}` }, i % 2)));
  expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
  for (const response of responses.filter((r) => r.status === 503)) expect((await response.json()).error.code).toBe('ingest_pending');
  expect(await f.count()).toBe(1);
  expect((await getEvent(clickhouse, f.project, input.id))?.event.action).toMatch(/^winner\./);
});
it('deduplicates identical batch indices and rejects the different sibling', async () => {
  const response = await f.post([original, original, { ...original, action: 'conflict' }, { action: 'generated.id' }]);
  expect(await response.json()).toMatchObject({ accepted: 3, rejected: [{ index: 2, reason: expect.stringMatching(/^duplicate_id_conflict:/) }] });
  expect(await f.count()).toBe(2);
});
it('stores healthy siblings before reporting one unresolved id with indices and ids', async () => {
  await f.pending(original);
  const response = await f.post([original, { id: 'healthy', action: 'healthy' }]);
  expect(response.status).toBe(503);
  expect(response.headers.get('Retry-After')).toBe('1');
  expect(await response.json()).toMatchObject({ error: { code: 'ingest_pending', details: { indices: [0], eventIds: ['original'] } } });
  expect((await getEvent(clickhouse, f.project, 'healthy'))?.event.action).toBe('healthy');
  expect((await f.post([original, { id: 'healthy', action: 'healthy' }])).status).toBe(503);
  expect(await f.count()).toBe(1);
});
it('automatically recovers an ambiguous write whose row never arrives, preserving received_at', async () => {
  const receivedAt = new Date(Date.now() - 120_000);
  await f.pending(original, { expired: true, receivedAt });
  expect((await f.post(original)).status).toBe(202);
  const event = await getEvent(clickhouse, f.project, original.id);
  expect(event?.event.receivedAt).toBe(receivedAt.toISOString());
  expect(event?.event.timestamp).toBe(receivedAt.toISOString());
  expect(await f.count()).toBe(1);
});
it('hourly reconciliation readies an absent claim without losing its identity or receipt clock', async () => {
  const row = await f.pending(original, { expired: true });
  await recoverProjectIngest(clickhouse, f.project);
  const receipt = await prisma.ingestReceipt.findUniqueOrThrow({ where: { projectId_eventId: { projectId: f.project, eventId: original.id } } });
  expect(receipt).toMatchObject({ claimedAt: null, confirmedAt: null, fingerprint: eventFingerprint(row), receivedAt: new Date(row.received_at) });
  // A conflicting request cannot take over a missing claim.
  const conflict = await f.post({ ...original, action: 'conflict' });
  expect(conflict.status).toBe(503);
  expect((await f.post(original)).status).toBe(202);
});
it('confirms a visible delayed original without reinserting it', async () => {
  const row = await f.pending(original);
  await insertEvents(clickhouse, [row]);
  expect((await f.post(original)).status).toBe(202);
  expect(await f.count()).toBe(1);
});
it('recovers old unversioned pending receipts and upgrades their stored-row fingerprints', async () => {
  const row = f.row(original);
  await f.pending(original, { legacy: legacyEventFingerprint(row), receivedAt: new Date(row.received_at), expired: true });
  await insertEvents(clickhouse, [row]);
  expect((await f.post(original)).status).toBe(202);
  expect(
    (await prisma.ingestReceipt.findUniqueOrThrow({ where: { projectId_eventId: { projectId: f.project, eventId: original.id } } })).fingerprint,
  ).toMatch(/^v1:/);
});
it('looks up retained rows after receipt expiry, including cross-partition conflicts', async () => {
  expect((await f.post(original)).status).toBe(202);
  await prisma.ingestReceipt.updateMany({ where: { projectId: f.project }, data: { confirmedAt: new Date(0) } });
  await pruneIngestReceipts(f.project);
  expect((await f.post(original)).status).toBe(202);
  expect(await (await f.post({ ...original, occurredAt: new Date(Date.now() - 31 * 86_400_000).toISOString() })).json()).toMatchObject({
    accepted: 0,
    rejected: [{ reason: expect.stringMatching(/^duplicate_id_conflict:/) }],
  });
  expect(await f.count()).toBe(1);
});
it('retention cutoff cleanup preserves an unresolved delayed original while a conflicting retry arrives', async () => {
  const input = { ...original, occurredAt: new Date(Date.now() - 100 * 86_400_000).toISOString() };
  const delayed = await f.pending(input);
  // Force the actual retention purge path with another expired, acknowledged row.
  expect((await f.post({ ...input, id: 'expired-confirmed' })).status).toBe(202);
  await enforceProjectRetention(f.project);
  await withProjectLock(f.project, () => purgeIngestReceipts(f.project, new Date()));
  expect(await prisma.ingestReceipt.count({ where: { projectId: f.project, eventId: original.id, confirmedAt: null } })).toBe(1);
  expect((await f.post({ ...input, action: 'conflict' })).status).toBe(503);
  await insertEvents(clickhouse, [delayed]);
  expect((await f.post(input)).status).toBe(202);
  expect(await f.count()).toBe(1);
  await enforceProjectRetention(f.project);
  expect(await f.count()).toBe(0);
  expect((await read<{ n: number }>(clickhouse, 'SELECT count() n FROM event_ids WHERE project_id={p:String}', { p: f.project }))[0]?.n).toBe(0);
});
it('rejects NUL and split Unicode ids individually, storing healthy siblings', async () => {
  const response = await f.post([
    { id: 'a\0b', action: 'unsafe' },
    { id: `${'x'.repeat(255)}\u{1f600}`, action: 'split' },
    { id: `${'x'.repeat(254)}\u{1f600}`, action: 'safe' },
  ]);
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({
    accepted: 1,
    rejected: [
      { index: 0, reason: expect.stringMatching(/^invalid_event_id:/) },
      { index: 1, reason: expect.stringMatching(/^invalid_event_id:/) },
    ],
  });
  expect(await f.count()).toBe(1);
  expect(await prisma.ingestReceipt.count({ where: { projectId: f.project } })).toBe(1);
});
it('search, detail, export and cursor pages agree for newly immutable writes', async () => {
  for (let i = 0; i < 3; i++) expect((await f.post({ ...original, id: `page-${i}`, action: `action.${i}` })).status).toBe(202);
  const q = { from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString(), limit: 1, order: 'asc' as const };
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await searchEvents(clickhouse, f.project, { ...q, cursor });
    expect(page.total).toBe(3);
    ids.push(...page.data.map((e) => e.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(new Set(ids).size).toBe(3);
  const lines: string[] = [];
  for await (const line of exportEvents(clickhouse, f.project, { ...q, q: 'action:action.1', format: 'jsonl' })) lines.push(JSON.parse(line).action);
  expect(lines).toEqual(['action.1']);
  expect((await getEvent(clickhouse, f.project, 'page-1'))?.event.action).toBe('action.1');
});

it('HTTP identity preserves lossy input differences and recursively reordered keys', async () => {
  const pairs = [
    [{ actor: { id: 42 } }, { actor: { id: 43 } }, false],
    [{ description: `${'x'.repeat(4096)}a` }, { description: `${'x'.repeat(4096)}b` }, false],
    [{ changes: [{ field: 'config', after: { a: 1, b: 2 } }] }, { changes: [{ field: 'config', after: { b: 2, a: 1 } }] }, true],
    [{ metadata: { items: [{ a: 1, b: 2 }] } }, { metadata: { items: [{ b: 2, a: 1 }] } }, true],
  ] as const;
  for (const [i, [a, b, equal]] of pairs.entries()) {
    const event = { id: `lossy-${i}`, action: 'lossy.original' };
    expect((await f.post({ ...event, ...a })).status).toBe(202);
    const response = await f.post({ ...event, ...b });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject(
      equal ? { accepted: 1, rejected: [] } : { accepted: 0, rejected: [{ reason: expect.stringMatching(/^duplicate_id_conflict:/) }] },
    );
  }
  expect(await f.count()).toBe(4);
});

it('Prisma claim dates round-trip in a non-UTC Postgres session', async () => {
  const receivedAt = new Date();
  const row = f.row(original, receivedAt);
  await insertEvents(clickhouse, [row]);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Pacific/Auckland'");
    const receipts = await tx.ingestReceipt.createManyAndReturn({
      data: [
        {
          projectId: f.project,
          eventId: row.event_id,
          organizationId: f.org,
          fingerprint: eventFingerprint(row),
          receivedAt,
          eventAt: new Date(row.timestamp),
          confirmedAt: receivedAt,
          claimedAt: receivedAt,
        },
      ],
      skipDuplicates: true,
    });
    expect(receipts[0]?.receivedAt.toISOString()).toBe(receivedAt.toISOString());
    expect(receipts[0]?.eventAt.toISOString()).toBe(row.timestamp);
  });
  expect((await f.post(original)).status).toBe(202);
  expect(await f.count()).toBe(1);
});

it('upgrades a missing legacy receipt on reinsertion and rejects lossy same-batch variants', async () => {
  const input = { id: 'legacy-missing', action: 'legacy.original', actor: { id: 42 } };
  const receivedAt = new Date();
  await f.pending(input, { receivedAt, expired: true, legacy: legacyEventFingerprint(f.row(input, receivedAt)) });
  const response = await f.post([input, { ...input, actor: { id: 43 } }]);
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ accepted: 1, rejected: [{ index: 1, reason: expect.stringMatching(/^duplicate_id_conflict:/) }] });
  const receipt = await prisma.ingestReceipt.findUniqueOrThrow({ where: { projectId_eventId: { projectId: f.project, eventId: input.id } } });
  expect(receipt.fingerprint).toMatch(/^v1:/);
  expect(await f.count()).toBe(1);
});

it('keeps the exclusive project lock through an expired-claim reinsert', async () => {
  await f.pending(original, { expired: true });
  const insert = clickhouse.insert.bind(clickhouse);
  const spy = vi.spyOn(clickhouse, 'insert').mockImplementationOnce(async (params) => {
    await expect(withProjectLock(f.project, async () => undefined, { mode: 'shared', waitMs: 0 })).rejects.toMatchObject({
      name: 'ProjectBusyError',
    });
    return insert(params);
  });
  try {
    expect((await f.post(original)).status).toBe(202);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await f.count()).toBe(1);
  } finally {
    spy.mockRestore();
  }
});
