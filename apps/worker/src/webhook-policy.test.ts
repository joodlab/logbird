import { expect, it } from 'vitest';
import { webhookRetryDelay, webhookWatermark } from './webhook-policy';

it('uses an exponential-style schedule with bounded jitter and a two-to-four-hour tail', () => {
  expect([1, 2, 3, 4, 5, 6, 7].map((attempt) => webhookRetryDelay(attempt, 0.5))).toEqual([
    5000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000,
  ]);
  expect(webhookRetryDelay(1, 0)).toBe(4000);
  expect(webhookRetryDelay(1, 1)).toBe(6000);
  expect(webhookRetryDelay(10, 0)).toBe(7_200_000);
  expect(webhookRetryDelay(10, 1)).toBe(14_400_000);
});

it('leaves both the async flush window and the earliest unconfirmed millisecond unscanned', () => {
  const now = new Date('2026-11-22T12:00:00Z');
  expect(webhookWatermark(now, null).toISOString()).toBe('2026-11-22T11:59:45.000Z');
  expect(webhookWatermark(now, new Date('2026-11-22T11:58:03.785Z')).toISOString()).toBe('2026-11-22T11:58:03.784Z');
  expect(webhookWatermark(now, new Date('2026-11-22T11:59:55Z')).toISOString()).toBe('2026-11-22T11:59:45.000Z');
});
