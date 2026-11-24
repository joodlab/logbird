import { expect, it, vi } from 'vitest';

vi.mock('@logbird/database', () => ({ prisma: {}, databaseClock: async () => new Date() }));
vi.mock('@logbird/clickhouse', () => ({ INGEST_CLAIM_LEASE_MS: 20_000, ASYNC_INSERT_FLUSH_BOUND_MS: 5000 }));

import { driftGrew, readVerification, tablesOf } from './retention-verification';

// #296 round-1 finding 7 (owner's ruling (d)): derived-table drift compared with the run's baseline.
const zero = { minute: 0, actor: 0, tenant: 0, executor: 0, target: 0, attributes: 0 };

it('flags a measure that grew beyond baseline plus allowance, and only that one', () => {
  const verification = { baseline: { ...zero, actor: 3 }, allowance: { ...zero, actor: 10, attributes: 4 } };
  // Within the allowance (an insert caught mid-way during the between-fences reading): not growth.
  expect(driftGrew(verification, { ...zero, actor: 13, attributes: 4 })).toEqual([]);
  // A killed entities DELETE leaves the expired rows' contributions: growth beyond the allowance.
  expect(driftGrew(verification, { ...zero, actor: 14 })).toEqual(['actor']);
  expect(driftGrew(verification, { ...zero, actor: -50 })).toEqual(['actor']);
  expect(driftGrew({ baseline: { ...zero, actor: -50 }, allowance: zero }, zero)).toEqual([]);
});

it('treats the minute buckets exactly: any growth fails, since the baseline was read under the lock', () => {
  expect(driftGrew({ baseline: zero, allowance: zero }, { ...zero, minute: 1 })).toEqual(['minute']);
  expect(driftGrew({ baseline: zero, allowance: zero }, { ...zero, minute: -1 })).toEqual(['minute']);
});

it('names each table once', () => {
  expect(tablesOf(['actor', 'target', 'minute', 'attributes'])).toEqual(['entities', 'events_by_minute', 'attribute_keys']);
});

it('reads a missing or foreign verification as not verified, never verified', () => {
  expect(readVerification(null)).toBeNull();
  expect(readVerification({})).toBeNull();
  expect(readVerification({ version: 2, baseline: zero, allowance: zero, baselineOff: [] })).toBeNull();
  const stored = {
    version: 1,
    window: { from: '2026-11-23T00:00:00.000Z', to: '2026-11-23T00:00:01.000Z' },
    baseline: zero,
    allowance: zero,
    baselineOff: [],
  };
  expect(readVerification(stored)).toEqual(stored);
  expect(readVerification({ ...stored, baseline: {} })).toBeNull();
  expect(readVerification({ ...stored, baselineOff: ['missing'] })).toBeNull();
});
