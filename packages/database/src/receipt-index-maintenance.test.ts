import { beforeEach, expect, it, vi } from 'vitest';

const connection = vi.hoisted(() => ({ connect: vi.fn(), end: vi.fn(), on: vi.fn(), query: vi.fn(), options: {} as Record<string, unknown> }));
vi.mock('pg', () => ({
  default: {
    Client: class {
      constructor(options: Record<string, unknown>) {
        connection.options = options;
      }
      connect = connection.connect;
      end = connection.end;
      on = connection.on;
      query = connection.query;
    },
  },
}));
vi.mock('./keys', () => ({ keys: () => ({ DATABASE_URL: 'postgresql://fixture.invalid/qa' }) }));

import { compactIngestReceiptIndex, INGEST_RECEIPT_PKEY, neededIndexPages, RECEIPT_INDEX_COMPACTION } from './receipt-index-maintenance';

type Row = Record<string, unknown>;
function fakeDb(state: {
  locked?: boolean;
  pages: readonly number[];
  live: number;
  keyBytes: number | null;
  invalid?: string[];
  reindexFails?: boolean;
}) {
  const pages = [...state.pages];
  const calls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    let rows: Row[] = [];
    if (sql.includes('current_schema()')) rows = [{ schema: 'qa_current' }];
    else if (sql.includes('pg_try_advisory_lock')) rows = [{ locked: state.locked ?? true }];
    else if (sql.includes('pg_relation_size')) rows = [{ pages: String(pages.length > 1 ? pages.shift() : pages[0]) }];
    else if (sql.includes('NOT i.indisvalid')) rows = (state.invalid ?? []).map((name) => ({ name }));
    else if (sql.includes('reltuples')) rows = [{ live: state.live, key_bytes: state.keyBytes }];
    else if (sql.startsWith('REINDEX') && state.reindexFails)
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    return { rows };
  });
  return { db: { query } as never, calls, query };
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  connection.end.mockResolvedValue(undefined);
});

it('estimates the pages a freshly built B-tree needs from analyzed key widths', () => {
  // 64 key bytes -> 72-byte aligned tuple + 4-byte line pointer; 90% of 8192 per leaf.
  expect(neededIndexPages(1_000_000, 64)).toBe(Math.ceil((1_000_000 * 76) / (8192 * 0.9)));
  expect(neededIndexPages(0, 64)).toBe(1);
});

it('rebuilds only a large index far beyond what its live entries need, then releases the lock', async () => {
  const big = fakeDb({ pages: [RECEIPT_INDEX_COMPACTION.minPages * 10, 1000], live: 100_000, keyBytes: 60 });
  const result = await compactIngestReceiptIndex({ db: big.db });
  expect(result).toMatchObject({ action: 'reindexed', indexPages: RECEIPT_INDEX_COMPACTION.minPages * 10, pagesAfter: 1000, droppedInvalid: 0 });
  expect(big.calls.some((sql) => sql === `REINDEX INDEX CONCURRENTLY "qa_current"."${INGEST_RECEIPT_PKEY.index}"`)).toBe(true);
  expect(big.calls.at(-1)).toContain('pg_advisory_unlock');
});

it('skips compact, small, busy and unanalyzed indexes without rebuilding', async () => {
  const live = 1_000_000;
  const needed = neededIndexPages(live, 60);
  for (const [state, action] of [
    [{ pages: [needed * 2], live, keyBytes: 60 }, 'skipped_compact'],
    [{ pages: [RECEIPT_INDEX_COMPACTION.minPages - 1], live: 10, keyBytes: 60 }, 'skipped_compact'],
    [{ pages: [needed * 10], live, keyBytes: 60, locked: false }, 'skipped_busy'],
    [{ pages: [needed * 10], live, keyBytes: null }, 'skipped_no_statistics'],
  ] as const) {
    const { db, calls } = fakeDb(state);
    expect((await compactIngestReceiptIndex({ db })).action).toBe(action);
    expect(calls.some((sql) => sql.startsWith('REINDEX'))).toBe(false);
    // A busy worker never unlocks a lock it does not hold.
    expect(calls.some((sql) => sql.includes('pg_advisory_unlock'))).toBe(action !== 'skipped_busy');
  }
});

it('drops leftover invalid copies first and again when the rebuild times out', async () => {
  const { db, calls } = fakeDb({
    pages: [RECEIPT_INDEX_COMPACTION.minPages * 10],
    live: 1000,
    keyBytes: 60,
    invalid: ['IngestReceipt_pkey_ccnew'],
    reindexFails: true,
  });
  await expect(compactIngestReceiptIndex({ db })).rejects.toMatchObject({ code: '57014' });
  const drops = calls.filter((sql) => sql.startsWith('DROP INDEX CONCURRENTLY'));
  expect(drops).toEqual([
    'DROP INDEX CONCURRENTLY IF EXISTS "qa_current"."IngestReceipt_pkey_ccnew"',
    'DROP INDEX CONCURRENTLY IF EXISTS "qa_current"."IngestReceipt_pkey_ccnew"',
  ]);
  expect(calls.at(-1)).toContain('pg_advisory_unlock');
});

it('skips statistics on a small never-analyzed index', async () => {
  const { db, calls } = fakeDb({ pages: [1], live: 0, keyBytes: null });
  expect((await compactIngestReceiptIndex({ db })).action).toBe('skipped_compact');
  expect(calls.some((sql) => sql.includes('pg_stats'))).toBe(false);
});

it('scopes the maintenance lock to its target so private fixtures never lock the shared index', async () => {
  const { db, query } = fakeDb({ pages: [1], live: 0, keyBytes: null });
  await compactIngestReceiptIndex({ db, target: { ...INGEST_RECEIPT_PKEY, schema: 'qa_compaction_fixture' } });
  const key = 'logbird:ingest-receipt-index-compaction:"qa_compaction_fixture"."IngestReceipt_pkey"';
  expect(query).toHaveBeenCalledWith(expect.stringContaining('pg_try_advisory_lock'), [key]);
  expect(query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_unlock'), [key]);
});

it('bounds connection attempts and closes a failed attempt', async () => {
  connection.connect.mockRejectedValue(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }));
  await expect(compactIngestReceiptIndex()).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  expect(connection.options.connectionTimeoutMillis).toBe(5000);
  expect(connection.end).toHaveBeenCalledTimes(1);
});

it('handles and logs idle connection errors before closing the session', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  connection.connect.mockResolvedValue(undefined);
  const { query } = fakeDb({ pages: [1], live: 0, keyBytes: null });
  connection.query.mockImplementation(query);
  await compactIngestReceiptIndex();
  const listener = connection.on.mock.calls.find(([event]) => event === 'error')?.[1];
  expect(listener).toBeTypeOf('function');
  listener(Object.assign(new Error('idle FATAL'), { code: '57P01' }));
  expect(log).toHaveBeenCalledWith(JSON.stringify({ level: 'error', event: 'ingest.receipt_index_connection_failed', code: '57P01' }));
  expect(connection.end).toHaveBeenCalledTimes(1);
});
