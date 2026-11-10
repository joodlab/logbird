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
    expect(sql).toContain(`FROM "${kind}" WHERE "expiresAt" < $1::timestamp`);
    expect(sql).toContain('ORDER BY "expiresAt" LIMIT $2 FOR UPDATE SKIP LOCKED');
    expect(sql).toContain(`DELETE FROM "${kind}" AS t USING expired`);
    expect(statement.values).toEqual([cutoff.toISOString(), AUTH_RECORD_SWEEP_BATCH_SIZE]);
  }
});

/** The table a batch statement deletes from. */
const kindOf = (statement: { text: string }) => /DELETE FROM "(\w+)"/.exec(statement.text)?.[1];
/** Answers each kind's batches from its own queue of row counts (empty queue: nothing left). */
const answer = (counts: Record<string, number[]>, onBatch: () => void = () => undefined) =>
  execute.mockImplementation((statement) => {
    if (statement === AUTH_RECORD_SWEEP_GUARD) return Promise.resolve(0);
    onBatch();
    return Promise.resolve(counts[kindOf(statement) ?? '']?.shift() ?? 0);
  });

it('drains each kind in guarded batches with its own grace period, taking turns, and reports what it removed', async () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  // session: one full batch then a partial one; verification: partial; invitation: nothing.
  answer({ session: [AUTH_RECORD_SWEEP_BATCH_SIZE, 7], verification: [3], invitation: [0] });
  const result = await sweepExpiredAuthRecords(now);
  expect(result).toEqual({ removed: { session: AUTH_RECORD_SWEEP_BATCH_SIZE + 7, verification: 3, invitation: 0 }, batches: 4, limited: false });
  // Every batch runs right after the guard, inside its own transaction.
  const calls = execute.mock.calls.map(([statement]) => statement);
  expect(calls.filter((_, index) => index % 2 === 0).every((statement) => statement === AUTH_RECORD_SWEEP_GUARD)).toBe(true);
  expect(transaction).toHaveBeenCalledTimes(4);
  // Each transaction is bounded: at most 1 s to start, 6 s in total.
  for (const [, options] of transaction.mock.calls) expect(options).toEqual({ maxWait: 1000, timeout: 6000 });
  // The guard caps each statement at 5 s and pins the plan to the expiresAt index, for this transaction only.
  const guard = AUTH_RECORD_SWEEP_GUARD.text.replace(/\s+/g, ' ');
  for (const setting of [
    "'statement_timeout','5s',true",
    "'enable_seqscan','off',true",
    "'enable_bitmapscan','off',true",
    "'enable_sort','off',true",
  ])
    expect(guard).toContain(`set_config(${setting})`);
  const batches = calls.filter((_, index) => index % 2 === 1);
  // One batch per kind per turn; drained kinds drop out.
  expect(batches.map(kindOf)).toEqual(['session', 'verification', 'invitation', 'session']);
  expect(batches.map((statement) => statement.values[0])).toEqual([
    new Date(now - AUTH_RECORD_GRACE_MS.session).toISOString(),
    new Date(now - AUTH_RECORD_GRACE_MS.verification).toISOString(),
    new Date(now - AUTH_RECORD_GRACE_MS.invitation).toISOString(),
    new Date(now - AUTH_RECORD_GRACE_MS.session).toISOString(),
  ]);
});

it('stops at the time budget and says so; the next run continues', async () => {
  let clock = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const full = () => Array(10).fill(AUTH_RECORD_SWEEP_BATCH_SIZE);
  answer({ session: full(), verification: full(), invitation: full() }, () => {
    clock += AUTH_RECORD_SWEEP_BUDGET_MS / 2;
  });
  const result = await sweepExpiredAuthRecords(0);
  expect(result).toEqual({
    removed: { session: AUTH_RECORD_SWEEP_BATCH_SIZE, verification: AUTH_RECORD_SWEEP_BATCH_SIZE, invitation: 0 },
    batches: 2,
    limited: true,
  });
});

it('a backlog of one kind cannot starve the others: every kind progresses within one budget', async () => {
  let clock = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  // Sessions never run out; each batch costs a quarter of the budget, so the run fits four batches.
  answer({ session: Array(100).fill(AUTH_RECORD_SWEEP_BATCH_SIZE), verification: [4], invitation: [2] }, () => {
    clock += AUTH_RECORD_SWEEP_BUDGET_MS / 4;
  });
  const result = await sweepExpiredAuthRecords(0);
  expect(result).toEqual({ removed: { session: 2 * AUTH_RECORD_SWEEP_BATCH_SIZE, verification: 4, invitation: 2 }, batches: 4, limited: true });
});

it('a failed batch rejects the run instead of reporting a partial success', async () => {
  execute.mockImplementation((statement) =>
    statement === AUTH_RECORD_SWEEP_GUARD ? Promise.resolve(0) : Promise.reject(new Error('canceling statement due to statement timeout')),
  );
  await expect(sweepExpiredAuthRecords()).rejects.toThrow(/statement timeout/);
});
