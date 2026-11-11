import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { execute, query, transaction } = vi.hoisted(() => ({ execute: vi.fn(), query: vi.fn(), transaction: vi.fn() }));
vi.mock('./index', async () => ({
  Prisma: (await import('./generated/client')).Prisma,
  prisma: { $executeRaw: execute, $queryRaw: query, $transaction: transaction },
}));

import {
  claimIngestReceipts,
  confirmIngestReceipts,
  expireIngestReceipts,
  findIngestReceipts,
  INGEST_RECEIPT_BACKSTOP_BUDGET_MS,
  INGEST_RECEIPT_SWEEP_BUDGET_MS,
  IngestReceiptConflictError,
  pruneIngestReceipts,
  RECEIPT_PROBE_TRANSACTION,
  sweepIngestReceipts,
} from './ingest-receipts';

beforeEach(() => {
  vi.resetAllMocks();
  // Interactive transactions get a client; batch transactions run their already-issued statements in order.
  transaction.mockImplementation((run) => (typeof run === 'function' ? run({ $executeRaw: execute }) : Promise.all(run)));
});
afterEach(() => vi.restoreAllMocks());

it.each([{ code: 'P2002' }, { code: '23505' }, { code: 'P2010', meta: { code: '23505' } }])(
  'turns claim uniqueness failures into retryable receipt conflicts (%j)',
  async (error) => {
    query.mockRejectedValueOnce(error);
    await expect(
      claimIngestReceipts('qa-project', 'qa-org', [
        {
          eventId: 'qa-event',
          fingerprint: 'v1:qa',
          receivedAt: new Date(0),
          eventAt: new Date(0),
          confirmedAt: null,
          claimedAt: new Date(0),
        },
      ]),
    ).rejects.toMatchObject({ code: 'LOGBIRD_INGEST_RECEIPT_CONFLICT', operation: 'claim' });
    expect(query).toHaveBeenCalledTimes(1);
  },
);

it('preserves unrelated claim failures', async () => {
  const error = { code: 'P2010', meta: { code: '57014' } };
  query.mockRejectedValueOnce(error);
  await expect(
    claimIngestReceipts('qa-project', 'qa-org', [
      {
        eventId: 'qa-event',
        fingerprint: 'v1:qa',
        receivedAt: new Date(0),
        eventAt: new Date(0),
        confirmedAt: null,
        claimedAt: new Date(0),
      },
    ]),
  ).rejects.toBe(error);
});

it('empty lookups and confirmations do no SQL; receipt reads preserve the returned clocks', async () => {
  expect(await findIngestReceipts('project', [])).toEqual([]);
  await confirmIngestReceipts('project', []);
  expect(query).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  const stored = [{ eventId: 'a', receivedAt: new Date(42) }];
  query.mockResolvedValueOnce(stored);
  expect(await findIngestReceipts('project', ['a'])).toBe(stored);
  expect(query).toHaveBeenCalledTimes(1);
});

const cas = (found: number, skipped: string[] = []) => [{ found, changed: found - skipped.length, skipped }];

it('every per-id probe runs right after its transaction-local plan guard, with explicit bounds', async () => {
  query.mockResolvedValueOnce([]).mockResolvedValueOnce(cas(1)).mockResolvedValueOnce(cas(1));
  await findIngestReceipts('project', ['a']);
  await confirmIngestReceipts('project', [{ eventId: 'a', fingerprint: 'v1:x', receivedAt: new Date(), eventAt: new Date() }]);
  await expireIngestReceipts('project', ['a'], new Date());
  expect(transaction).toHaveBeenCalledTimes(3);
  // Batch positions (identity, not deep equality): Prisma executes batch entries sequentially in one
  // transaction, so the guard (first) is planned before the probe (second). The mock proves positions only;
  // the real-PG plan test covers execution.
  for (const [n, [batch, options]] of transaction.mock.calls.entries()) {
    expect(batch).toHaveLength(2);
    expect(batch[0]).toBe(execute.mock.results[n]?.value);
    expect(batch[1]).toBe(query.mock.results[n]?.value);
    expect(batch[0]).not.toBe(batch[1]);
    expect(options).toBe(RECEIPT_PROBE_TRANSACTION);
  }
  expect(execute).toHaveBeenCalledTimes(3);
  for (const [sql] of execute.mock.calls)
    for (const setting of ['enable_seqscan', 'enable_bitmapscan', 'enable_sort', 'enable_incremental_sort', 'jit'])
      expect(sql.sql).toContain(`set_config('${setting}','off',true)`);
});

it('a full targeted request batch never loops', async () => {
  query.mockResolvedValueOnce(cas(5000)).mockResolvedValue(cas(0));
  const ids = Array.from({ length: 5000 }, (_, n) => `receipt-${n}`);
  await expireIngestReceipts(randomUUID(), ids, new Date());
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]?.[0].values).toContainEqual(ids);
});

it('ids lost to a concurrent row update are re-sought once more, never silently skipped', async () => {
  query.mockResolvedValueOnce(cas(3, ['b'])).mockResolvedValueOnce(cas(1));
  const identities = ['a', 'b', 'c'].map((eventId) => ({ eventId, fingerprint: 'v1:x', receivedAt: new Date(1), eventAt: new Date(2) }));
  await confirmIngestReceipts('project', identities);
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[1]?.[0].values).toContainEqual(['b']);
  // The retry keeps the first attempt's confirmation clock.
  expect(query.mock.calls[1]?.[0].values.at(-1)).toBe(query.mock.calls[0]?.[0].values.at(-1));
  // A renewed receipt drops out of the expiry re-seek (found 0) instead of being deleted.
  query.mockResolvedValueOnce(cas(2, ['b'])).mockResolvedValueOnce(cas(0));
  await expireIngestReceipts('project', ['a', 'b', 'a'], new Date());
  expect(query.mock.calls[2]?.[0].values).toContainEqual(['a', 'b']);
  expect(query.mock.calls[3]?.[0].values).toContainEqual(['b']);
});

it('persistent conflicts and impossible counts fail loudly', async () => {
  query.mockResolvedValue(cas(1, ['a']));
  await expect(expireIngestReceipts('project', ['a'], new Date())).rejects.toBeInstanceOf(IngestReceiptConflictError);
  expect(query).toHaveBeenCalledTimes(3);
  query.mockReset().mockResolvedValueOnce([{ found: 2, changed: 1, skipped: [] }]);
  await expect(expireIngestReceipts('project', ['a', 'b'], new Date())).rejects.toBeInstanceOf(IngestReceiptConflictError);
});

it('fresh ids do no expiry SQL and oversized cleanup is rejected before storage', async () => {
  await expireIngestReceipts(randomUUID(), [], new Date());
  await expect(
    expireIngestReceipts(
      randomUUID(),
      Array.from({ length: 5001 }, (_, n) => String(n)),
      new Date(),
    ),
  ).rejects.toThrow(RangeError);
  expect(execute).not.toHaveBeenCalled();
});

it('targeted expiry propagates storage errors before claiming an expired id', async () => {
  query.mockRejectedValueOnce(new Error('fixture database unavailable'));
  await expect(expireIngestReceipts(randomUUID(), ['expired'], new Date())).rejects.toThrow('fixture database unavailable');
  expect(query).toHaveBeenCalledTimes(1);
});

it('the hourly backstop drains guarded 5000-row batches using one fixed cutoff', async () => {
  // Each batch: the transaction-local guard, then the DELETE.
  execute.mockResolvedValueOnce(0).mockResolvedValueOnce(5000).mockResolvedValueOnce(0).mockResolvedValueOnce(5000);
  execute.mockResolvedValueOnce(0).mockResolvedValueOnce(3);
  expect(await pruneIngestReceipts()).toEqual({ removed: 10_003, batches: 3, limited: false });
  expect(transaction).toHaveBeenCalledTimes(3);
  const guards = execute.mock.calls.filter((_, n) => n % 2 === 0).map(([sql]) => sql.sql);
  for (const guard of guards)
    for (const setting of [
      'statement_timeout',
      'lock_timeout',
      'enable_seqscan',
      'enable_bitmapscan',
      'enable_sort',
      'enable_incremental_sort',
      'jit',
    ])
      expect(guard).toContain(setting);
  const deletes = execute.mock.calls.filter((_, n) => n % 2 === 1);
  expect(new Set(deletes.map(([sql]) => sql.values[0])).size).toBe(1);
  expect(deletes.every(([sql]) => sql.values.includes(5000))).toBe(true);
});

it('the hourly backstop stops at its own work budget', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(2_000_000);
  execute.mockResolvedValue(5000);
  transaction.mockImplementation(async (run) => {
    const result = await run({ $executeRaw: execute });
    clock.mockReturnValue(2_000_000 + INGEST_RECEIPT_BACKSTOP_BUDGET_MS);
    return result;
  });
  expect(await pruneIngestReceipts(randomUUID())).toEqual({ removed: 5000, batches: 1, limited: true });
});

it('the minute sweep caps work between batches and bounds each transaction', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  execute.mockResolvedValue(0);
  transaction.mockImplementationOnce(async (run) => {
    const result = await run({ $executeRaw: execute.mockResolvedValueOnce(0).mockResolvedValueOnce(5000) });
    clock.mockReturnValue(1_000_000 + INGEST_RECEIPT_SWEEP_BUDGET_MS);
    return result;
  });
  expect(await sweepIngestReceipts(randomUUID())).toEqual({ removed: 5000, batches: 1, limited: true });
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(transaction.mock.calls[0]?.[1]).toEqual({ maxWait: 1000, timeout: 6000 });
  expect(execute.mock.calls[0]?.[0].sql).toContain("set_config('statement_timeout','5s',true)");
});

it('the minute sweep stops on a partial batch and propagates storage failure', async () => {
  execute.mockResolvedValueOnce(0).mockResolvedValueOnce(12);
  expect(await sweepIngestReceipts()).toEqual({ removed: 12, batches: 1, limited: false });
  transaction.mockRejectedValueOnce(new Error('fixture database unavailable'));
  await expect(sweepIngestReceipts()).rejects.toThrow('fixture database unavailable');
});
