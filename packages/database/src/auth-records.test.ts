import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { execute, transaction } = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn() }));
vi.mock('./index', async () => ({
  Prisma: (await import('./generated/client')).Prisma,
  prisma: { $transaction: transaction },
}));

import {
  AUTH_RECORD_GRACE_MS,
  AUTH_RECORD_SWEEP_BATCH_SIZE,
  AUTH_RECORD_SWEEP_BUDGET_MS,
  AUTH_RECORD_SWEEP_GUARD,
  authRecordBatchSql,
  sweepExpiredAuthRecords,
} from './auth-records';

beforeEach(() => {
  vi.resetAllMocks();
  transaction.mockImplementation((run) => run({ $executeRaw: execute }));
});
afterEach(() => vi.useRealTimers());

it('batch statements target only expired rows of one table, oldest first, bounded and lock-skipping', () => {
  const cutoff = new Date('2026-11-01T00:00:00Z');
  for (const kind of ['session', 'verification', 'invitation'] as const) {
    const statement = authRecordBatchSql(kind, cutoff);
    const sql = statement.text.replace(/\s+/g, ' ');
    expect(sql).toContain(`FROM "${kind}" WHERE "expiresAt" < $1`);
    expect(sql).toContain('ORDER BY "expiresAt" LIMIT $2 FOR UPDATE SKIP LOCKED');
    expect(sql).toContain(`DELETE FROM "${kind}" AS t USING expired`);
    expect(statement.values).toEqual([cutoff, AUTH_RECORD_SWEEP_BATCH_SIZE]);
  }
});

it('drains each kind in guarded batches with its own grace period, and reports what it removed', async () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  // session: one full batch then a partial one; verification: partial; invitation: nothing.
  const counts = [AUTH_RECORD_SWEEP_BATCH_SIZE, 7, 3, 0];
  execute.mockImplementation((statement) => Promise.resolve(statement === AUTH_RECORD_SWEEP_GUARD ? 0 : (counts.shift() ?? 0)));
  const result = await sweepExpiredAuthRecords(now);
  expect(result).toEqual({ removed: { session: AUTH_RECORD_SWEEP_BATCH_SIZE + 7, verification: 3, invitation: 0 }, batches: 4, limited: false });
  // Every batch runs right after the guard, inside its own transaction.
  const calls = execute.mock.calls.map(([statement]) => statement);
  expect(calls.filter((_, index) => index % 2 === 0).every((statement) => statement === AUTH_RECORD_SWEEP_GUARD)).toBe(true);
  expect(transaction).toHaveBeenCalledTimes(4);
  const cutoffs = calls.filter((_, index) => index % 2 === 1).map((statement) => statement.values[0]);
  expect(cutoffs).toEqual([
    new Date(now - AUTH_RECORD_GRACE_MS.session),
    new Date(now - AUTH_RECORD_GRACE_MS.session),
    new Date(now - AUTH_RECORD_GRACE_MS.verification),
    new Date(now - AUTH_RECORD_GRACE_MS.invitation),
  ]);
});

it('stops at the time budget and says so; the next run continues', async () => {
  let clock = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  execute.mockImplementation((statement) => {
    if (statement !== AUTH_RECORD_SWEEP_GUARD) clock += AUTH_RECORD_SWEEP_BUDGET_MS / 2;
    return Promise.resolve(statement === AUTH_RECORD_SWEEP_GUARD ? 0 : AUTH_RECORD_SWEEP_BATCH_SIZE);
  });
  const result = await sweepExpiredAuthRecords(0);
  expect(result.limited).toBe(true);
  expect(result.batches).toBe(2);
  expect(result.removed.session).toBe(2 * AUTH_RECORD_SWEEP_BATCH_SIZE);
});

it('a failed batch rejects the run instead of reporting a partial success', async () => {
  execute.mockImplementation((statement) =>
    statement === AUTH_RECORD_SWEEP_GUARD ? Promise.resolve(0) : Promise.reject(new Error('canceling statement due to statement timeout')),
  );
  await expect(sweepExpiredAuthRecords()).rejects.toThrow(/statement timeout/);
});
