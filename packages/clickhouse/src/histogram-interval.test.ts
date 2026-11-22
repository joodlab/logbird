import { pickHistogramInterval } from '@logbird/contracts';
import { expect, it } from 'vitest';

// Pure: runs in the service-free unit suite (moved out of contracts.integration.test.ts).
it('histogram intervals come from the round ladder (≤ ~120 buckets)', () => {
  const H = 3_600_000;
  expect(pickHistogramInterval(15 * 60_000)).toBe(60);
  expect(pickHistogramInterval(H)).toBe(60);
  expect(pickHistogramInterval(6 * H)).toBe(300);
  expect(pickHistogramInterval(24 * H)).toBe(900);
  expect(pickHistogramInterval(7 * 24 * H)).toBe(10_800);
  expect(pickHistogramInterval(30 * 24 * H)).toBe(21_600);
  expect(pickHistogramInterval(30 * 24 * H + 50)).toBe(21_600);
  expect(pickHistogramInterval(90 * 24 * H)).toBe(86_400);
  expect(pickHistogramInterval(365 * 24 * H)).toBe(4 * 86_400);
});
