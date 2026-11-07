import { expect, it } from 'vitest';
import { eventIdRepairBuckets } from './index-repair';

it.each([
  [0, 1],
  [1, 1],
  [500_000, 1],
  [500_001, 2],
  [10_000_000, 32],
  [100_000_000, 256],
  [1_000_000_000, 2048],
])('sizes %i rows into %i power-of-two buckets', (rows, expected) => {
  expect(eventIdRepairBuckets(rows)).toBe(expected);
});
it('also sizes for long keys and physical overlap from online backfills', () => {
  expect(eventIdRepairBuckets(10_000_000, 1_000_000_000)).toBe(32);
  expect(eventIdRepairBuckets(10_000_000, 8_000_000_000)).toBe(256);
  expect(eventIdRepairBuckets(20_000_000, 2_000_000_000)).toBe(64);
  expect(eventIdRepairBuckets(1_000_000_000, 100_000_000_000)).toBe(4096);
});
it.each([-1, Number.POSITIVE_INFINITY, Number.NaN, 0.5])('rejects an invalid count %s before reconciliation', (rows) => {
  expect(() => eventIdRepairBuckets(rows)).toThrow('Invalid identity repair size');
});
