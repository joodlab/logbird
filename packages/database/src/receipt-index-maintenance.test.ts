import { beforeEach, expect, it, vi } from 'vitest';

const connection = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
  query: vi.fn(),
  destroy: vi.fn(),
  options: {} as Record<string, unknown>,
}));
const cancelConnection = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(),
  on: vi.fn(),
  query: vi.fn(),
  destroy: vi.fn(),
  options: {} as Record<string, unknown>,
}));
vi.mock('pg', () => ({
  default: {
    Client: class {
      constructor(options: Record<string, unknown>) {
        const state = options.application_name === 'logbird-receipt-index-cancel' ? cancelConnection : connection;
        state.options = options;
        this.connect = state.connect;
        this.end = state.end;
        this.on = state.on;
        this.query = state.query;
        // pg's internal socket, which the bounded close destroys.
        this.connection = { stream: { destroy: state.destroy } };
      }
      connection = { stream: { destroy: connection.destroy } };
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

import {
  compactIngestReceiptIndex,
  INGEST_RECEIPT_PKEY,
  neededIndexPages,
  RECEIPT_INDEX_CANCEL_TIMEOUT_MS,
  RECEIPT_INDEX_CLOSE_TIMEOUT_MS,
  RECEIPT_INDEX_COMPACTION,
  RECEIPT_INDEX_SETUP_TIMEOUT_MS,
} from './receipt-index-maintenance';

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
    else if (sql === 'SELECT pg_backend_pid() pid') rows = [{ pid: 12_345 }];
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
  connection.query.mockResolvedValue({ rows: [{ pid: 12_345 }] });
  cancelConnection.connect.mockResolvedValue(undefined);
  cancelConnection.end.mockResolvedValue(undefined);
  cancelConnection.query.mockResolvedValue({ rows: [] });
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
  expect(calls.slice(0, 5)).toEqual([
    'SET statement_timeout = 900000',
    'SET lock_timeout = 60000',
    "SET application_name = 'logbird-receipt-index-maintenance'",
    "SET client_connection_check_interval = '1s'",
    'SELECT pg_backend_pid() pid',
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
  expect(check?.[0]).toContain("backend_type NOT IN ('autovacuum worker', 'autovacuum launcher')");
  expect(check?.[0]).toContain('AND (backend_xmin IS NOT NULL OR pid IN (SELECT pid FROM pg_locks WHERE relation = to_regclass($2)))');
  expect(check?.[1]).toEqual([RECEIPT_INDEX_COMPACTION.lockTimeoutMs, '"qa_current"."IngestReceipt"']);
  expect(big.calls.at(-1)).toContain('pg_advisory_unlock');
});

it('cancels only the managed backend on shutdown, waits for 57014 and drops the invalid copy before closing', async () => {
  const abort = new AbortController();
  connection.connect.mockResolvedValue(undefined);
  const invalid: string[] = [];
  const { query } = fakeDb({ pages: [RECEIPT_INDEX_COMPACTION.minPages * 10], live: 1000, keyBytes: 60, invalid });
  let started: (() => void) | undefined;
  const active = new Promise<void>((resolve) => {
    started = resolve;
  });
  let failQuery: ((error: Error) => void) | undefined;
  connection.query.mockImplementation((sql: string, params?: unknown[]) => {
    if (!sql.startsWith('REINDEX')) return query(sql, params);
    invalid.push('IngestReceipt_pkey_ccnew');
    started?.();
    return new Promise((_resolve, reject) => {
      failQuery = reject;
    });
  });
  cancelConnection.query.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_cancel_backend')) {
      expect(connection.end).not.toHaveBeenCalled();
      failQuery?.(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
    }
    return { rows: [] };
  });
  const rebuilding = compactIngestReceiptIndex({ signal: abort.signal });
  await active;
  expect(connection.end).not.toHaveBeenCalled();
  abort.abort();
  await expect(rebuilding).rejects.toMatchObject({ code: '57014' });
  expect(cancelConnection.query).toHaveBeenCalledWith('SET statement_timeout = 5000');
  expect(cancelConnection.query).toHaveBeenCalledWith('SELECT pg_cancel_backend($1)', [12_345]);
  expect(cancelConnection.options).toMatchObject({ connectionTimeoutMillis: 5000, query_timeout: 5000 });
  expect(cancelConnection.end).toHaveBeenCalledTimes(1);
  expect(connection.end).toHaveBeenCalledTimes(1);
  expect(query.mock.calls.filter(([sql]) => sql.includes('NOT i.indisvalid'))).toHaveLength(2);
  expect(query).toHaveBeenCalledWith('DROP INDEX CONCURRENTLY IF EXISTS "qa_current"."IngestReceipt_pkey_ccnew"', undefined);
  expect(query.mock.invocationCallOrder.at(-1)).toBeLessThan(connection.end.mock.invocationCallOrder[0] as number);
});

it('bounds shutdown to ten seconds when REINDEX does not acknowledge cancellation', async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const { query } = fakeDb({ pages: [RECEIPT_INDEX_COMPACTION.minPages * 10], live: 1000, keyBytes: 60 });
  let failQuery: ((error: Error) => void) | undefined;
  connection.query.mockImplementation((sql: string, params?: unknown[]) => {
    if (!sql.startsWith('REINDEX')) return query(sql, params);
    return new Promise((_resolve, reject) => {
      failQuery = reject;
    });
  });
  connection.end.mockImplementation(async () => failQuery?.(new Error('Connection terminated')));
  const rebuilding = compactIngestReceiptIndex({ signal: abort.signal });
  const outcome = expect(rebuilding).rejects.toThrow('Connection terminated');
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(failQuery).toBeTypeOf('function');
    abort.abort();
    await vi.advanceTimersByTimeAsync(9999);
    expect(connection.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(cancelConnection.query).toHaveBeenCalledWith('SELECT pg_cancel_backend($1)', [12_345]);
    expect(cancelConnection.end).toHaveBeenCalled();
    expect(connection.end).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it.each(['42704', '42501'])('ignores only an unsupported connection-check setting (%s)', async (code) => {
  const { query } = fakeDb({ pages: [1], live: 0, keyBytes: null });
  connection.query.mockImplementation((sql: string, params?: unknown[]) => {
    if (sql.includes('client_connection_check_interval')) return Promise.reject(Object.assign(new Error('SET failed'), { code }));
    return query(sql, params);
  });
  if (code === '42704') await expect(compactIngestReceiptIndex()).resolves.toMatchObject({ action: 'skipped_compact' });
  else await expect(compactIngestReceiptIndex()).rejects.toMatchObject({ code });
  expect(connection.end).toHaveBeenCalledTimes(1);
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

it('closes the socket when shutdown arrives while a setup query is stalled', async () => {
  const abort = new AbortController();
  connection.connect.mockResolvedValue(undefined);
  let failSetup: ((error: Error) => void) | undefined;
  connection.query.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        failSetup = reject;
      }),
  );
  // pg's end() destroys the socket under an active query, which rejects it.
  connection.end.mockImplementation(async () => failSetup?.(new Error('Connection terminated')));
  const compacting = compactIngestReceiptIndex({ signal: abort.signal });
  await vi.waitFor(() => expect(failSetup).toBeTypeOf('function'));
  abort.abort();
  await expect(compacting).rejects.toMatchObject({ name: 'AbortError' });
  expect(connection.end).toHaveBeenCalledTimes(1);
  expect(cancelConnection.connect).not.toHaveBeenCalled();
});

it('bounds a stalled setup with its own deadline even without shutdown', async () => {
  vi.useFakeTimers();
  try {
    connection.connect.mockResolvedValue(undefined);
    let failSetup: ((error: Error) => void) | undefined;
    connection.query.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failSetup = reject;
        }),
    );
    connection.end.mockImplementation(async () => failSetup?.(new Error('Connection terminated')));
    const compacting = compactIngestReceiptIndex();
    const outcome = expect(compacting).rejects.toThrow('Connection terminated');
    await vi.advanceTimersByTimeAsync(RECEIPT_INDEX_SETUP_TIMEOUT_MS - 1);
    expect(connection.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(connection.end).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('never cancels the cleanup drop after an independent REINDEX failure', async () => {
  const abort = new AbortController();
  connection.connect.mockResolvedValue(undefined);
  const invalid: string[] = [];
  const { query } = fakeDb({ pages: [RECEIPT_INDEX_COMPACTION.minPages * 10], live: 1000, keyBytes: 60, invalid });
  let dropStarted: (() => void) | undefined;
  const dropping = new Promise<void>((resolve) => {
    dropStarted = resolve;
  });
  let finishDrop: (() => void) | undefined;
  connection.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.startsWith('REINDEX')) {
      invalid.push('IngestReceipt_pkey_ccnew');
      throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    }
    if (sql.startsWith('DROP INDEX')) {
      dropStarted?.();
      await new Promise<void>((resolve) => {
        finishDrop = resolve;
      });
    }
    return query(sql, params);
  });
  const compacting = compactIngestReceiptIndex({ signal: abort.signal });
  await dropping;
  abort.abort();
  finishDrop?.();
  await expect(compacting).rejects.toMatchObject({ code: '57014' });
  // The late shutdown neither opened a cancel connection nor interrupted the drop.
  expect(cancelConnection.connect).not.toHaveBeenCalled();
  expect(query).toHaveBeenCalledWith('DROP INDEX CONCURRENTLY IF EXISTS "qa_current"."IngestReceipt_pkey_ccnew"', undefined);
});

it('does not cancel catalog work when shutdown arrives before REINDEX, and never starts it', async () => {
  const abort = new AbortController();
  connection.connect.mockResolvedValue(undefined);
  const { query } = fakeDb({ pages: [RECEIPT_INDEX_COMPACTION.minPages * 10], live: 1000, keyBytes: 60 });
  connection.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('pg_stat_activity')) abort.abort();
    return query(sql, params);
  });
  await expect(compactIngestReceiptIndex({ signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancelConnection.connect).not.toHaveBeenCalled();
  expect(query.mock.calls.some(([sql]) => sql.startsWith('REINDEX'))).toBe(false);
  expect(query).toHaveBeenCalledWith('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [expect.stringContaining('IngestReceipt_pkey')]);
});

it('keeps the shutdown fallback armed while the advisory unlock stalls', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const abort = new AbortController();
    connection.connect.mockResolvedValue(undefined);
    const { query } = fakeDb({ pages: [1], live: 0, keyBytes: null });
    let unlockStarted = false;
    let failUnlock: ((error: Error) => void) | undefined;
    connection.query.mockImplementation((sql: string, params?: unknown[]) => {
      if (!sql.includes('pg_advisory_unlock')) return query(sql, params);
      unlockStarted = true;
      return new Promise((_resolve, reject) => {
        failUnlock = reject;
      });
    });
    connection.end.mockImplementation(async () => failUnlock?.(new Error('Connection terminated')));
    const compacting = compactIngestReceiptIndex({ signal: abort.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(unlockStarted).toBe(true);
    abort.abort();
    await vi.advanceTimersByTimeAsync(9999);
    expect(connection.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(compacting).resolves.toMatchObject({ action: 'skipped_compact' });
    expect(connection.end).toHaveBeenCalled();
    // No REINDEX was running, so nothing was cancelled server-side; the fallback names the backend anyway.
    expect(cancelConnection.connect).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({ level: 'warn', event: 'ingest.receipt_index_shutdown_fallback', pid: 12_345, reindexRunning: false }),
    );
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('reports an invalid copy this role cannot drop instead of failing every run', async () => {
  const { query } = fakeDb({ pages: [RECEIPT_INDEX_COMPACTION.minPages * 10], live: 1000, keyBytes: 60, invalid: ['IngestReceipt_pkey_ccnew'] });
  connection.connect.mockResolvedValue(undefined);
  connection.query.mockImplementation((sql: string, params?: unknown[]) => {
    if (sql.startsWith('DROP INDEX')) return Promise.reject(Object.assign(new Error('must be owner of index'), { code: '42501' }));
    return query(sql, params);
  });
  await expect(compactIngestReceiptIndex()).resolves.toMatchObject({ action: 'skipped_invalid_copy', droppedInvalid: 0 });
  expect(query.mock.calls.some(([sql]) => sql.startsWith('REINDEX'))).toBe(false);
  expect(query).toHaveBeenCalledWith('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [expect.any(String)]);
});

it('bounds an idle close that waits on an unreachable peer, destroying the socket', async () => {
  vi.useFakeTimers();
  try {
    connection.connect.mockResolvedValue(undefined);
    const { query } = fakeDb({ pages: [1], live: 0, keyBytes: null });
    connection.query.mockImplementation(query);
    // pg 8's graceful end() on an idle session waits for the server's FIN, which never comes.
    connection.end.mockImplementation(() => new Promise(() => undefined));
    const compacting = compactIngestReceiptIndex();
    const outcome = expect(compacting).resolves.toMatchObject({ action: 'skipped_compact' });
    await vi.advanceTimersByTimeAsync(RECEIPT_INDEX_CLOSE_TIMEOUT_MS - 1);
    expect(connection.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('bounds the cancel connection, including a close that never completes, within its shorter budget', async () => {
  vi.useFakeTimers();
  try {
    const abort = new AbortController();
    connection.connect.mockResolvedValue(undefined);
    const { query } = fakeDb({ pages: [RECEIPT_INDEX_COMPACTION.minPages * 10], live: 1000, keyBytes: 60 });
    let failQuery: ((error: Error) => void) | undefined;
    connection.query.mockImplementation((sql: string, params?: unknown[]) => {
      if (!sql.startsWith('REINDEX')) return query(sql, params);
      return new Promise((_resolve, reject) => {
        failQuery = reject;
      });
    });
    // The cancel connection never connects and never finishes closing; like pg, destroying its socket fails connect.
    let failConnect: ((error: Error) => void) | undefined;
    cancelConnection.connect.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failConnect = reject;
        }),
    );
    cancelConnection.destroy.mockImplementation(() => failConnect?.(new Error('Connection terminated')));
    cancelConnection.end.mockImplementation(() => new Promise(() => undefined));
    connection.end.mockImplementation(async () => failQuery?.(new Error('Connection terminated')));
    connection.destroy.mockImplementation(() => failQuery?.(new Error('Connection terminated')));
    const compacting = compactIngestReceiptIndex({ signal: abort.signal });
    const outcome = expect(compacting).rejects.toThrow('Connection terminated');
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await vi.advanceTimersByTimeAsync(RECEIPT_INDEX_CANCEL_TIMEOUT_MS);
    // The cancel budget ends before the original session is closed, so its pid is never released early.
    expect(cancelConnection.destroy).toHaveBeenCalled();
    expect(connection.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000 - RECEIPT_INDEX_CANCEL_TIMEOUT_MS);
    expect(connection.destroy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RECEIPT_INDEX_CLOSE_TIMEOUT_MS);
    await outcome;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
