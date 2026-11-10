import { Readable } from 'node:stream';
import { insertEvents } from '@logbird/clickhouse';
import * as receipts from '@logbird/database';
import { prisma } from '@logbird/database';
import { Logbird } from '@logbird/sdk';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clickhouse, maintenanceClickhouse } from './clickhouse';
import { type ImmutableFixture, immutableFixture } from './immutable-fixture';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
let f: ImmutableFixture;
let fileClock = Date.now();
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  fileClock = Math.max(fileClock, Date.now()) + 61_000;
  vi.setSystemTime(fileClock);
  f = await immutableFixture();
});
afterEach(async () => {
  fileClock = Date.now();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await f.cleanup();
});
const input = { id: 'same', action: 'error.original', occurredAt: new Date().toISOString(), context: {}, metadata: {} };
it.each(['6', '25', '27', '38', '41', '53', '69', '72', '60', '62', '81', '164', '497', '516', '241', '159', '252'])(
  'classifies server code %s after consuming the body',
  async (code) => {
    vi.spyOn(clickhouse, 'exec').mockImplementationOnce(async (params) => {
      for await (const _row of ('values' in params ? params.values : []) as AsyncIterable<unknown>) {
        /* body consumed */
      }
      throw Object.assign(new Error('fictional server exception: While executing WaitForAsyncInsert.'), { code });
    });
    const response = await f.post(input);
    const ambiguous = ['241', '159', '252'].includes(code);
    const parseRejection = ['6', '25', '27', '38', '41', '53', '69', '72'].includes(code);
    expect(response.status).toBe(parseRejection ? 202 : 503);
    if (parseRejection)
      expect(await response.json()).toMatchObject({
        accepted: 0,
        rejected: [{ index: 0, code: 'invalid_event', reason: expect.stringMatching(/^invalid_event:/) }],
      });
    expect(await prisma.ingestReceipt.count({ where: { projectId: f.project } })).toBe(ambiguous ? 1 : 0);
    if (ambiguous) {
      expect((await response.json()).error.code).toBe('ingest_pending');
      vi.setSystemTime(Date.now() + 80_000);
    }
    expect((await f.post(input)).status).toBe(202);
    expect(await f.count()).toBe(1);
  },
);
it('releases claims on connection refusal before body transmission', async () => {
  vi.spyOn(clickhouse, 'exec').mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
  const response = await f.post(input);
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe('ingest_unavailable');
  expect(await prisma.ingestReceipt.count({ where: { projectId: f.project } })).toBe(0);
});
it('releases claims after a real UInt16 ClickHouse parse failure', async () => {
  const insert = clickhouse.exec.bind(clickhouse);
  vi.spyOn(clickhouse, 'exec').mockImplementationOnce(async (params) => {
    const rows: unknown[] = [];
    for await (const chunk of ('values' in params ? params.values : []) as AsyncIterable<Buffer>)
      for (const line of chunk.toString().trimEnd().split('\n')) rows.push({ ...JSON.parse(line), job_attempt: 'not-an-integer' });
    return insert({ ...params, values: Readable.from(rows.map((row) => `${JSON.stringify(row)}\n`)) });
  });
  expect((await f.post(input)).status).toBe(202);
  expect(await prisma.ingestReceipt.count({ where: { projectId: f.project } })).toBe(0);
  expect(await f.count()).toBe(0);
});
it('retains only an ambiguity after the body was consumed, then recovers an absent row', async () => {
  vi.spyOn(clickhouse, 'exec').mockImplementationOnce(async (params) => {
    for await (const _row of ('values' in params ? params.values : []) as AsyncIterable<unknown>) {
      /* body handed to HTTP transport */
    }
    throw new Error('connection reset after body sent');
  });
  const response = await f.post(input);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'ingest_pending', details: { indices: [0], eventIds: ['same'] } } });
  expect(await prisma.ingestReceipt.count({ where: { projectId: f.project, confirmedAt: null } })).toBe(1);
  await prisma.ingestReceipt.updateMany({ where: { projectId: f.project }, data: { claimedAt: new Date(Date.now() - 80_000) } });
  expect((await f.post(input)).status).toBe(202);
  expect(await f.count()).toBe(1);
});
it('refuses an insert if its claim lease expires while the process is paused', async () => {
  const claim = receipts.claimIngestReceipts;
  vi.spyOn(receipts, 'claimIngestReceipts').mockImplementation(async (...args) => {
    const rows = await claim(...args);
    for (const receipt of rows) receipt.claimedAt = new Date(Date.now() - 61_000);
    return rows;
  });
  const spy = vi.spyOn(clickhouse, 'exec');
  expect((await f.post(input)).status).toBe(503);
  expect(spy).not.toHaveBeenCalled();
  expect(await prisma.ingestReceipt.count({ where: { projectId: f.project } })).toBe(0);
});
it('pending competing conflicts wait for the actual parse-failure release path', async () => {
  let entered: () => void = () => undefined,
    release: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(clickhouse, 'exec').mockImplementationOnce(async (params) => {
    for await (const _row of ('values' in params ? params.values : []) as AsyncIterable<unknown>) {
      /* request body consumed */
    }
    entered();
    await gate;
    throw Object.assign(new Error('fictional pre-write parse failure: While executing WaitForAsyncInsert.'), { code: '6' });
  });
  const first = f.post(input);
  try {
    await started;
    const response = await f.post({ ...input, action: 'different' });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('ingest_pending');
    release();
    expect((await first).status).toBe(202);
    expect(await prisma.ingestReceipt.count({ where: { projectId: f.project } })).toBe(0);
    expect((await f.post({ ...input, action: 'different' })).status).toBe(202);
  } finally {
    release();
    await first;
  }
});

for (const phase of ['first lookup', 'ownership recheck', 'recovery lookup'] as const)
  it(
    `HTTP and SDK retry a failed ${phase} with Retry-After and identical payload`,
    async () => {
      if (phase === 'recovery lookup') await f.pending(input, { expired: true });
      const armFailure = () => {
        const target = phase === 'recovery lookup' ? maintenanceClickhouse : clickhouse;
        const query = target.query.bind(target);
        let identityReads = 0;
        if (phase === 'ownership recheck') {
          const claim = receipts.claimIngestReceipts;
          vi.spyOn(receipts, 'claimIngestReceipts').mockImplementationOnce(async (...args) => {
            const rows = await claim(...args);
            // Model a >WINDOW/2 pause between absent lookup and ownership acquisition.
            vi.setSystemTime(Date.now() + 301_000);
            return rows;
          });
        }
        return vi.spyOn(target, 'query').mockImplementation((params) => {
          if (
            phase === 'recovery lookup'
              ? params.query.includes('FROM events') && params.query.includes('event_id IN {ids')
              : params.query.includes('FROM event_ids')
          ) {
            identityReads++;
            const failAt = phase === 'ownership recheck' ? 2 : 1;
            if (identityReads === failAt) return Promise.reject(Object.assign(new Error('MEMORY_LIMIT_EXCEEDED'), { code: '241' }));
          }
          return query(params);
        });
      };
      armFailure();
      const response = await f.post(input);
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe(phase === 'recovery lookup' ? '60' : '1');
      expect((await response.json()).error.code).toBe(phase === 'recovery lookup' ? 'ingest_pending' : 'ingest_unavailable');
      expect(await prisma.ingestReceipt.count({ where: { projectId: f.project } })).toBe(phase === 'recovery lookup' ? 1 : 0);
      vi.restoreAllMocks();
      armFailure();
      // Repeat the actual failing boundary via SDK fetch; Retry-After is shortened only in this test transport.
      let calls = 0;
      const bodies: string[] = [];
      vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
        calls++;
        bodies.push(String(init.body));
        const result = await f.post(JSON.parse(String(init.body)));
        if (result.status === 503) {
          expect(result.headers.get('Retry-After')).toBe(phase === 'recovery lookup' ? '60' : '1');
          return new Response(await result.text(), { status: 503, headers: { 'Retry-After': '0' } });
        }
        return result;
      });
      const sdk = new Logbird({ endpoint: 'http://fictional', apiKey: f.key.secret, maxRetries: 2 });
      sdk.track(input);
      await sdk.flush();
      await sdk.shutdown();
      expect(calls).toBe(2);
      expect(bodies[0]).toBe(bodies[1]);
      expect(sdk.dropped).toBe(0);
      expect(await f.count()).toBe(1);
    },
    phase === 'recovery lookup' ? 90_000 : 30_000,
  );
it('rejects corrupt stored evidence per id while storing healthy siblings', async () => {
  const row = f.row(input);
  row.payload = '{invalid';
  await insertEvents(clickhouse, [row]);
  const response = await f.post([input, { id: 'healthy', action: 'healthy.sibling' }]);
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ accepted: 1, ids: ['healthy'], rejected: [{ index: 0, code: 'stored_event_unreadable' }] });
  expect(await f.count()).toBe(2);
});
it('fast fresh batches issue one narrow identity lookup, with no payload scan or recheck', async () => {
  const spy = vi.spyOn(clickhouse, 'query');
  const receipts = vi.spyOn(prisma.ingestReceipt, 'findMany');
  const queries = vi.spyOn(prisma, '$queryRaw');
  expect((await f.post(Array.from({ length: 1000 }, (_, i) => ({ ...input, id: `fresh-${i}` })))).status).toBe(202);
  // One recovery preview and one point-probed prior cache: RETURNING supplies fresh ownership.
  expect(receipts).toHaveBeenCalledTimes(1);
  expect(queries.mock.calls.filter(([sql]) => 'text' in sql && sql.text.includes('SELECT r.* FROM'))).toHaveLength(1);
  expect(await prisma.ingestReceipt.count({ where: { projectId: f.project, confirmedAt: { not: null }, eventAt: new Date(input.occurredAt) } })).toBe(
    1000,
  );
  const statements = spy.mock.calls.map(([params]) => params.query);
  expect(statements.filter((sql) => sql.includes('FROM event_ids'))).toHaveLength(1);
  expect(statements.some((sql) => sql.includes('payload') && sql.includes('FROM events'))).toBe(false);
});

it('releases a recovered claim on a definite server rejection', async () => {
  await f.pending(input, { expired: true });
  vi.spyOn(clickhouse, 'exec').mockImplementationOnce(async (params) => {
    for await (const _row of ('values' in params ? params.values : []) as AsyncIterable<unknown>) {
      // Exercise a server error after the original transport body was consumed.
    }
    throw Object.assign(new Error('ACCESS_DENIED'), { code: '497' });
  });
  const response = await f.post(input);
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe('ingest_unavailable');
  expect(await prisma.ingestReceipt.count({ where: { projectId: f.project } })).toBe(0);
});
it('rechecks retained evidence after a long lookup-to-claim pause without double inserting', async () => {
  const claim = receipts.claimIngestReceipts;
  const insert = vi.spyOn(clickhouse, 'exec');
  vi.spyOn(receipts, 'claimIngestReceipts').mockImplementationOnce(async (...args) => {
    const rows = await claim(...args);
    // A prior owner became visible and its cache expired while this process was paused.
    await insertEvents(clickhouse, [f.row(input)]);
    vi.setSystemTime(Date.now() + 301_000);
    return rows;
  });
  expect((await f.post(input)).status).toBe(202);
  expect(insert).toHaveBeenCalledTimes(1);
  expect(await f.count()).toBe(1);
});

it('a failed async-queue drain keeps expired claims fenced', async () => {
  await f.pending(input, { expired: true });
  vi.spyOn(maintenanceClickhouse, 'command').mockRejectedValueOnce(new Error('queue drain timeout'));
  const response = await f.post(input);
  expect(response.status).toBe(503);
  expect((await response.json()).error).toMatchObject({ code: 'ingest_pending', details: { accepted: 0, indices: [0], eventIds: ['same'] } });
  expect(await prisma.ingestReceipt.count({ where: { projectId: f.project, confirmedAt: null, claimedAt: { not: null } } })).toBe(1);
});
