import { eventFingerprint, exportEvents, getEvent, insertEvents, read, searchEvents } from '@logbird/clickhouse';
import {
  claimIngestReceipts,
  confirmIngestReceipts,
  expireIngestReceipts,
  findIngestReceipts,
  prisma,
  pruneIngestReceipts,
  purgeIngestReceipts,
  withProjectLock,
} from '@logbird/database';
import { recoverProjectIngest } from '@logbird/worker/ingest-recovery';
import { enforceProjectRetention } from '@logbird/worker/retention';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { legacyFingerprint3a1541f, normalizeEvent3a1541f } from '../../../packages/clickhouse/src/fixtures/identity-3a1541f';
import { clickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
let f: ImmutableFixture;
let clock = Date.now();
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = Math.max(clock, Date.now()) + 61_000;
  vi.setSystemTime(clock);
  f = await immutableFixture();
});
afterEach(async () => {
  clock = Date.now();
  vi.useRealTimers();
  await f.cleanup();
});
const original = { id: 'original', action: 'evidence.original', actor: { id: 'actor' }, metadata: { status: 'pending' } };

it('missing receipt keys neither match nor lock their successors, including another project', async () => {
  const neighbor = `${f.project}-next`;
  await prisma.project.create({ data: { id: neighbor, organizationId: f.org, name: 'QA Receipt neighbor', slug: neighbor } });
  await prisma.ingestReceipt.createMany({
    data: [
      { projectId: f.project, eventId: 'z' },
      { projectId: neighbor, eventId: 'a' },
    ].map((r) => ({
      ...r,
      organizationId: f.org,
      fingerprint: 'v1:fixture',
      receivedAt: new Date(0),
      eventAt: new Date(0),
      confirmedAt: new Date(0),
    })),
  });
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "eventId" FROM "IngestReceipt" WHERE "projectId" IN (${f.project},${neighbor}) FOR UPDATE`;
    entered();
    await held;
  });
  void holder.catch(() => entered()); // The finally block propagates a lock-setup failure.
  let work: Promise<unknown[]> | undefined;
  try {
    await locked;
    work = Promise.all([
      findIngestReceipts(f.project, ['y', 'zz']),
      expireIngestReceipts(f.project, ['y', 'zz'], new Date()),
      confirmIngestReceipts(
        f.project,
        ['y', 'zz'].map((eventId) => ({ eventId, fingerprint: 'must-not-write', receivedAt: new Date(), eventAt: new Date() })),
      ),
    ]);
    expect(await Promise.race([work.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 1000))])).toBe(true);
    expect((await work)[0]).toEqual([]);
  } finally {
    release();
    await holder;
    await work;
  }
  expect(await prisma.ingestReceipt.count({ where: { organizationId: f.org, fingerprint: 'v1:fixture', confirmedAt: new Date(0) } })).toBe(2);
});

it('targeted expiry preserves a concurrently renewed receipt after waiting for its row lock', async () => {
  expect((await f.post(original)).status).toBe(202);
  await prisma.ingestReceipt.updateMany({ where: { projectId: f.project }, data: { confirmedAt: new Date(0) } });
  const [prior] = await findIngestReceipts(f.project, [original.id]);
  expect(prior?.confirmedAt).toEqual(new Date(0));
  let expiry: Promise<void> | undefined;
  await prisma.$transaction(async (tx) => {
    await tx.ingestReceipt.updateMany({ where: { projectId: f.project }, data: { confirmedAt: new Date() } });
    const [renewer] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() pid`;
    expiry = expireIngestReceipts(f.project, [original.id], new Date(Date.now() - 600_000));
    void expiry.catch(() => undefined); // Awaited after the renewal commits.
    // Barrier: commit the renewal only once expiry is actually waiting on this row lock.
    for (let attempt = 0; ; attempt++) {
      const [row] = await prisma.$queryRaw<
        { n: number }[]
      >`SELECT count(*)::int n FROM pg_stat_activity WHERE ${renewer?.pid}=ANY(pg_blocking_pids(pid))`;
      if (row?.n) break;
      if (attempt >= 500) throw new Error('Expiry never waited on the renewed row lock');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  await expiry;
  const [renewed] = await findIngestReceipts(f.project, [original.id]);
  expect(renewed?.confirmedAt).toEqual(new Date());
  expect(renewed?.fingerprint).toBe(prior?.fingerprint);
  expect((await f.post(original)).status).toBe(202);
  expect(await f.count()).toBe(1);
});

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
it('arbitrates two HTTP app instances while the first INSERT is paused before acknowledgement', async () => {
  const input = { ...original, occurredAt: new Date().toISOString() };
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const insertionStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const insert = clickhouse.exec.bind(clickhouse);
  const spy = vi.spyOn(clickhouse, 'exec').mockImplementationOnce(async (params) => {
    entered();
    await paused;
    return insert(params);
  });
  const first = f.post({ ...input, action: 'winner.original' });
  try {
    await insertionStarted;
    const competitors = await Promise.all(Array.from({ length: 11 }, (_, i) => f.post({ ...input, action: `competitor.${i}` }, i % 2)));
    for (const response of competitors) {
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe('ingest_pending');
    }
    expect(await f.count()).toBe(0);
    release();
    expect((await first).status).toBe(202);
    expect(await f.count()).toBe(1);
    expect((await getEvent(clickhouse, f.project, input.id))?.event.action).toBe('winner.original');
  } finally {
    release();
    await first;
    spy.mockRestore();
  }
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
  expect(response.headers.get('Retry-After')).toBe('70');
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
  const row = await f.pending(original, { expired: true });
  await insertEvents(clickhouse, [row]);
  expect((await f.post(original)).status).toBe(202);
  expect(await f.count()).toBe(1);
});
it('recovers old unversioned pending receipts and upgrades their stored-row fingerprints', async () => {
  const old = normalizeEvent3a1541f(original, { projectId: f.project, receivedAt: new Date() });
  if (!old.ok) throw new Error(old.reason);
  const row = old.row;
  await f.pending(original, { legacy: legacyFingerprint3a1541f(row), receivedAt: new Date(row.received_at), expired: true });
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
  vi.setSystemTime(Date.now() + 80_000);
  expect((await f.post(input)).status).toBe(202);
  expect(await f.count()).toBe(1);
  await enforceProjectRetention(f.project);
  expect(await f.count()).toBe(0);
  expect((await read<{ n: number }>(clickhouse, 'SELECT count() n FROM event_ids WHERE project_id={p:String}', { p: f.project }))[0]?.n).toBe(0);
}, 90_000);
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
  // Tie the pagination fixture to its queried clock, independently of the real PG first-acceptance clock.
  for (let i = 0; i < 3; i++)
    expect((await f.post({ ...original, id: `page-${i}`, action: `action.${i}`, occurredAt: new Date().toISOString() })).status).toBe(202);
  const q = { from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString(), limit: 1 };
  for (const order of ['asc', 'desc'] as const) {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
      const page = await searchEvents(clickhouse, f.project, { ...q, order, cursor });
      expect(page.total).toBe(3);
      expect(page.data).toHaveLength(1);
      ids.push(...page.data.map((e) => e.id));
      expect(!!page.nextCursor).toBe(pageIndex < 2);
      cursor = page.nextCursor ?? undefined;
    }
    expect(ids).toEqual(order === 'asc' ? ['page-0', 'page-1', 'page-2'] : ['page-2', 'page-1', 'page-0']);
    expect(new Set(ids).size).toBe(3);
  }
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

it('typed-array claim dates round-trip in a non-UTC Postgres session', async () => {
  const receivedAt = new Date();
  const row = f.row(original, receivedAt);
  await insertEvents(clickhouse, [row]);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Pacific/Auckland'");
    const receipts = await claimIngestReceipts(
      f.project,
      f.org,
      [
        {
          eventId: row.event_id,
          fingerprint: eventFingerprint(row),
          receivedAt,
          eventAt: new Date(row.timestamp),
          confirmedAt: receivedAt,
          claimedAt: receivedAt,
        },
      ],
      tx,
    );
    expect(receipts[0]?.receivedAt.toISOString()).toBe(receivedAt.toISOString());
    expect(receipts[0]?.eventAt.toISOString()).toBe(row.timestamp);
  });
  expect((await f.post(original)).status).toBe(202);
  expect(await f.count()).toBe(1);
});

it('typed-array claims arbitrate 1000 overlapping ids with lossless strings and only return owned rows', async () => {
  const receivedAt = new Date(),
    eventAt = new Date(receivedAt.getTime() - 1000);
  const claims = Array.from({ length: 1000 }, (_, i) => ({
    eventId: `claim-${i}-'\\🚀`,
    fingerprint: `v1:${i}`,
    receivedAt,
    eventAt,
    confirmedAt: null,
    claimedAt: receivedAt,
  }));
  const [a, b] = await Promise.all([claimIngestReceipts(f.project, f.org, claims), claimIngestReceipts(f.project, f.org, [...claims].reverse())]);
  expect(a.length + b.length).toBe(1000);
  expect(new Set([...a, ...b].map((r) => r.eventId)).size).toBe(1000);
  expect(a.some((r) => b.some((other) => other.eventId === r.eventId))).toBe(false);
  for (const receipt of [...a, ...b]) {
    expect(receipt.receivedAt.toISOString()).toBe(receivedAt.toISOString());
    expect(receipt.eventAt.toISOString()).toBe(eventAt.toISOString());
    expect(receipt.claimedAt?.toISOString()).toBe(receivedAt.toISOString());
    expect(receipt.confirmedAt).toBeNull();
  }
  expect(await claimIngestReceipts(f.project, f.org, claims)).toHaveLength(0);
  const confirmed = { eventId: 'already-stored', fingerprint: 'v1:stored', receivedAt, eventAt, claimedAt: receivedAt, confirmedAt: receivedAt };
  expect((await claimIngestReceipts(f.project, f.org, [confirmed]))[0]?.confirmedAt?.toISOString()).toBe(receivedAt.toISOString());
});

it('upgrades a missing legacy receipt on reinsertion and rejects lossy same-batch variants', async () => {
  const input = { id: 'legacy-missing', action: 'legacy.original', actor: { id: 42 } };
  const receivedAt = new Date();
  await f.pending(input, {
    receivedAt,
    expired: true,
    legacy: legacyFingerprint3a1541f(
      (() => {
        const old = normalizeEvent3a1541f(input, { projectId: f.project, receivedAt });
        if (!old.ok) throw new Error(old.reason);
        return old.row;
      })(),
    ),
  });
  const response = await f.post([input, { ...input, actor: { id: 43 } }]);
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ accepted: 1, rejected: [{ index: 1, reason: expect.stringMatching(/^duplicate_id_conflict:/) }] });
  const receipt = await prisma.ingestReceipt.findUniqueOrThrow({ where: { projectId_eventId: { projectId: f.project, eventId: input.id } } });
  expect(receipt.fingerprint).toMatch(/^v1:/);
  expect(await f.count()).toBe(1);
});

it('keeps the exclusive project lock through an expired-claim reinsert', async () => {
  await f.pending(original, { expired: true });
  const insert = clickhouse.exec.bind(clickhouse);
  const spy = vi.spyOn(clickhouse, 'exec').mockImplementationOnce(async (params) => {
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

it('rechecks expired confirmed cache ids without needing a prior bulk sweep', async () => {
  const expire = vi.spyOn(await import('@logbird/database'), 'expireIngestReceipts');
  const input = Array.from({ length: 3 }, (_, n) => ({ ...original, id: `expired-cache-${n}` }));
  try {
    expect((await f.post(input)).status).toBe(202);
    expect(expire).not.toHaveBeenCalled();
    const first = await prisma.ingestReceipt.findMany({ where: { projectId: f.project }, orderBy: { eventId: 'asc' } });
    await prisma.ingestReceipt.updateMany({ where: { projectId: f.project }, data: { confirmedAt: new Date(0) } });
    expect((await (await f.post(input)).json()).accepted).toBe(3);
    expect(expire).toHaveBeenCalledTimes(1);
    expect([...(expire.mock.calls[0]?.[1] ?? [])].sort()).toEqual(input.map((e) => e.id).sort());
    expect(await (await f.post({ ...input[0], action: 'overwrite' })).json()).toMatchObject({
      accepted: 0,
      rejected: [{ code: 'duplicate_id_conflict' }],
    });
    expect(expire).toHaveBeenCalledTimes(1);
    expect(await f.count()).toBe(3);
    const current = await prisma.ingestReceipt.findMany({ where: { projectId: f.project }, orderBy: { eventId: 'asc' } });
    expect(current.map((r) => r.receivedAt)).toEqual(first.map((r) => r.receivedAt));
  } finally {
    expire.mockRestore();
  }
});

it('returns a retryable error when targeted expiry fails before a claim', async () => {
  expect((await f.post(original)).status).toBe(202);
  await prisma.ingestReceipt.updateMany({ where: { projectId: f.project }, data: { confirmedAt: new Date(0) } });
  const expire = vi.spyOn(await import('@logbird/database'), 'expireIngestReceipts').mockRejectedValueOnce(
    new PrismaClientKnownRequestError('fictional unreachable database', {
      code: 'P1001',
      clientVersion: '7.10.0',
      meta: { driverAdapterError: { name: 'DriverAdapterError', cause: { kind: 'DatabaseNotReachable', host: 'qa.invalid', port: 5432 } } },
    }),
  );
  try {
    const response = await f.post(original);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(await response.json()).toMatchObject({ error: { code: 'ingest_unavailable' } });
    expect(await f.count()).toBe(1);
  } finally {
    expire.mockRestore();
  }
  expect((await (await f.post(original)).json()).accepted).toBe(1);
  expect(await f.count()).toBe(1);
});

it('returns HTTP 503 and Retry-After when releaseClaims deleteMany gets a model-query cancellation', async () => {
  const database = await import('@logbird/database');
  const originalClaim = database.claimIngestReceipts;
  const claim = vi.spyOn(database, 'claimIngestReceipts').mockImplementationOnce(async (...args) => {
    const owned = await originalClaim(...args);
    // Reject classification before insert while retaining a real owned claim for releaseClaims.
    return owned.map((receipt) => ({ ...receipt, fingerprint: 'unreadable:qa-release' }));
  });
  const release = vi.spyOn(prisma.ingestReceipt, 'deleteMany').mockRejectedValueOnce(
    new PrismaClientKnownRequestError('fictional model-query cancellation', {
      code: 'P2039',
      clientVersion: '7.10.0',
      meta: {
        modelName: 'IngestReceipt',
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: { kind: 'postgres', originalCode: '57014', code: '57014', severity: 'ERROR', message: 'qa cancellation' },
        },
      },
    }),
  );
  try {
    const response = await f.post(original);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(await response.json()).toMatchObject({ error: { code: 'ingest_unavailable' } });
    expect(release).toHaveBeenCalledWith({ where: { projectId: f.project, eventId: { in: [original.id] }, confirmedAt: null } });
    expect(await f.count()).toBe(0);
  } finally {
    claim.mockRestore();
    release.mockRestore();
  }
});
