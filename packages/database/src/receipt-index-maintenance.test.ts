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
vi.mock('./keys', () => ({
  keys: () => ({ DATABASE_URL: 'postgresql://fixture.invalid/qa?options=-c%20statement_timeout%3D0&application_name=qa-url' }),
}));

import { compactIngestReceiptIndex, INGEST_RECEIPT_PKEY, neededIndexPages, RECEIPT_INDEX_COMPACTION } from './receipt-index-maintenance';

type Row = Record<string, unknown>;
function fakeDb(state: {
  locked?: boolean;
  pages: readonly number[];
  live: number;
  keyBytes: number | null;
  invalid?: string[];
  reindexFails?: boolean;
  missingTable?: boolean;
  missingIndex?: boolean;
  oldTransactions?: number;
}) {
  const pages = [...state.pages];
  const calls: string[] = [];
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    calls.push(sql);
    let rows: Row[] = [];
    if (sql.includes('n.nspname AS schema')) rows = state.missingTable ? [] : [{ schema: 'qa_current' }];
    else if (sql.includes('pg_try_advisory_lock')) rows = [{ locked: state.locked ?? true }];
    else if (sql.includes('pg_relation_size')) rows = [{ pages: state.missingIndex ? null : String(pages.length > 1 ? pages.shift() : pages[0]) }];
    else if (sql.includes('NOT i.indisvalid')) rows = (state.invalid ?? []).map((name) => ({ name }));
    else if (sql.includes('reltuples')) rows = [{ live: state.live, key_bytes: state.keyBytes }];
    else if (sql.includes('pg_stat_activity')) rows = [{ n: state.oldTransactions ?? 0 }];
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

it.each(['missingTable', 'missingIndex'] as const)('reports %s distinctly instead of a compact index', async (missing) => {
  const { db, calls, query } = fakeDb({ pages: [0], live: 0, keyBytes: null, [missing]: true });
  expect(await compactIngestReceiptIndex({ db })).toEqual({ action: 'skipped_missing', indexPages: 0, droppedInvalid: 0 });
  expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE c.oid=to_regclass($1)'), ['"IngestReceipt"']);
  expect(calls.some((sql) => sql.includes('current_schema()') || sql.startsWith('REINDEX'))).toBe(false);
});

it('sets session bounds and identification after connecting and before any REINDEX despite URL overrides', async () => {
  connection.connect.mockResolvedValue(undefined);
  const { query, calls } = fakeDb({ pages: [RECEIPT_INDEX_COMPACTION.minPages * 10, 1000], live: 1000, keyBytes: 60 });
  connection.query.mockImplementation(query);
  await compactIngestReceiptIndex();
  expect(connection.connect.mock.invocationCallOrder[0]).toBeLessThan(connection.query.mock.invocationCallOrder[0] as number);
  expect(calls.slice(0, 3)).toEqual([
    'SET statement_timeout = 900000',
    'SET lock_timeout = 60000',
    "SET application_name = 'logbird-receipt-index-maintenance'",
  ]);
  expect(calls.findIndex((sql) => sql.startsWith('REINDEX'))).toBeGreaterThan(2);
});

it('closes the session if applying a timeout fails', async () => {
  connection.connect.mockResolvedValue(undefined);
  connection.query.mockRejectedValueOnce(new Error('SET failed'));
  await expect(compactIngestReceiptIndex()).rejects.toThrow('SET failed');
  expect(connection.end).toHaveBeenCalledTimes(1);
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

it('skips a rebuild that an older open transaction would fail after building, and still releases the lock', async () => {
  const big = fakeDb({ pages: [RECEIPT_INDEX_COMPACTION.minPages * 10], live: 100_000, keyBytes: 60, oldTransactions: 1 });
  const result = await compactIngestReceiptIndex({ db: big.db });
  expect(result).toMatchObject({ action: 'skipped_old_transactions', indexPages: RECEIPT_INDEX_COMPACTION.minPages * 10 });
  expect(big.calls.some((sql) => sql.startsWith('REINDEX'))).toBe(false);
  const check = big.query.mock.calls.find(([sql]) => String(sql).includes('pg_stat_activity'));
  expect(check?.[0]).toContain('pid <> pg_backend_pid()');
  expect(check?.[0]).toContain('AND (backend_xmin IS NOT NULL OR pid IN (SELECT pid FROM pg_locks WHERE relation = to_regclass($2)))');
  expect(check?.[1]).toEqual([RECEIPT_INDEX_COMPACTION.lockTimeoutMs, '"qa_current"."IngestReceipt"']);
  expect(big.calls.at(-1)).toContain('pg_advisory_unlock');
});

it('closes the managed connection on shutdown instead of waiting for an active rebuild', async () => {
  const abort = new AbortController();
  connection.connect.mockResolvedValue(undefined);
  const { query } = fakeDb({ pages: [RECEIPT_INDEX_COMPACTION.minPages * 10], live: 1000, keyBytes: 60 });
  let started: (() => void) | undefined;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  let failQuery: ((error: Error) => void) | undefined;
  connection.query.mockImplementation((sql: string, params?: unknown[]) => {
    if (!sql.startsWith('REINDEX')) return query(sql, params);
    started?.();
    return new Promise((_resolve, reject) => {
      failQuery = reject;
    });
  });
  connection.end.mockImplementation(async () => {
    failQuery?.(new Error('Connection terminated'));
  });
  const rebuilding = compactIngestReceiptIndex({ signal: abort.signal });
  await active;
  expect(connection.end).not.toHaveBeenCalled();
  abort.abort();
  await expect(rebuilding).rejects.toThrow('Connection terminated');
  expect(connection.end).toHaveBeenCalled();
});

it('does not issue maintenance statements if shutdown happened while connecting', async () => {
  const abort = new AbortController();
  connection.connect.mockImplementationOnce(async () => {
    abort.abort();
  });
  await expect(compactIngestReceiptIndex({ signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(connection.query.mock.calls.some(([sql]) => String(sql).includes('pg_try_advisory_lock'))).toBe(false);
  expect(connection.end).toHaveBeenCalledTimes(1);
});
