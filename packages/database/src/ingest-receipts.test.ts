import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { execute, query, transaction } = vi.hoisted(() => ({ execute: vi.fn(), query: vi.fn(), transaction: vi.fn() }));
vi.mock('./index', async () => ({
  Prisma: (await import('./generated/client')).Prisma,
  prisma: { $executeRaw: execute, $queryRaw: query, $transaction: transaction },
}));

import {
  confirmIngestReceipts,
  expireIngestReceipts,
  findIngestReceipts,
  INGEST_RECEIPT_SWEEP_BUDGET_MS,
  pruneIngestReceipts,
  sweepIngestReceipts,
} from './ingest-receipts';

beforeEach(() => {
  vi.resetAllMocks();
  // Interactive transactions get a client; batch transactions run their already-issued statements in order.
  transaction.mockImplementation((run) => (typeof run === 'function' ? run({ $executeRaw: execute }) : Promise.all(run)));
});
afterEach(() => vi.restoreAllMocks());

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

it('every per-id probe runs right after its transaction-local plan guard', async () => {
  query.mockResolvedValue([]);
  execute.mockResolvedValue(0);
  await findIngestReceipts('project', ['a']);
  await confirmIngestReceipts('project', [{ eventId: 'a', fingerprint: 'v1:x', receivedAt: new Date(), eventAt: new Date() }]);
  await expireIngestReceipts('project', ['a'], new Date());
  expect(transaction).toHaveBeenCalledTimes(3);
  for (const [batch] of transaction.mock.calls) expect(batch).toHaveLength(2);
  // Guard (execute), then probe (query), in each batch.
  const guards = execute.mock.calls;
  expect(guards).toHaveLength(3);
  expect(query).toHaveBeenCalledTimes(3);
  for (const [n, order] of execute.mock.invocationCallOrder.entries()) expect(order).toBeLessThan(query.mock.invocationCallOrder[n] as number);
  for (const [sql] of guards)
    for (const setting of ['enable_seqscan', 'enable_bitmapscan', 'enable_sort', 'enable_incremental_sort', 'jit'])
      expect(sql.sql).toContain(`set_config('${setting}','off',true)`);
});

it('a full targeted request batch never loops', async () => {
  execute.mockResolvedValueOnce(5000).mockResolvedValueOnce(5000).mockResolvedValue(0);
  const ids = Array.from({ length: 5000 }, (_, n) => `receipt-${n}`);
  await expireIngestReceipts(randomUUID(), ids, new Date());
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledTimes(1); // The plan guard.
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]?.[0].values).toContainEqual(ids);
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

it('the hourly backstop drains 5000-row batches using one fixed cutoff', async () => {
  execute.mockResolvedValueOnce(5000).mockResolvedValueOnce(5000).mockResolvedValueOnce(3);
  await pruneIngestReceipts();
  expect(execute).toHaveBeenCalledTimes(3);
  const cutoffs = execute.mock.calls.map(([sql]) => sql.values[0]);
  expect(new Set(cutoffs).size).toBe(1);
  expect(execute.mock.calls.every(([sql]) => sql.values.includes(5000))).toBe(true);
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
  const guard = execute.mock.calls[0]?.[0].sql;
  for (const setting of [
    "'statement_timeout','5s'",
    "'enable_seqscan','off'",
    "'enable_bitmapscan','off'",
    "'enable_sort','off'",
    "'enable_incremental_sort','off'",
    "'jit','off'",
  ])
    expect(guard).toContain(`set_config(${setting},true)`);
});

it('the minute sweep stops on a partial batch and propagates storage failure', async () => {
  execute.mockResolvedValueOnce(0).mockResolvedValueOnce(12);
  expect(await sweepIngestReceipts()).toEqual({ removed: 12, batches: 1, limited: false });
  transaction.mockRejectedValueOnce(new Error('fixture database unavailable'));
  await expect(sweepIngestReceipts()).rejects.toThrow('fixture database unavailable');
});
