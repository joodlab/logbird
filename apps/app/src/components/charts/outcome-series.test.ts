import { describe, expect, it } from 'vitest';
import { type SeriesRow, timeTicks } from './outcome-series';

const rows = (startIso: string, stepSeconds: number, count: number): SeriesRow[] =>
  Array.from({ length: count }, (_, i) => ({
    ts: Date.parse(startIso) + i * stepSeconds * 1000,
    total: 1,
    success: 1,
    partial: 0,
    denied: 0,
    failure: 0,
    unknown: 0,
  }));

describe('chart ticks', () => {
  it.each([
    ['24h of 15m buckets', rows('2026-11-03T23:45:00Z', 900, 97), 900],
    ['7d of 3h buckets', rows('2026-10-29T00:00:00Z', 10_800, 57), 10_800],
    ['30d of 6h buckets', rows('2026-10-06T00:00:00Z', 21_600, 121), 21_600],
    ['1h of 1m buckets', rows('2026-11-04T10:07:00Z', 60, 61), 60],
  ])('%s tick only on bucket starts, on round boundaries', (_label, series, interval) => {
    const { ticks } = timeTicks(series, interval);
    expect(ticks?.length).toBeGreaterThanOrEqual(2);
    const starts = new Set(series.map((r) => r.ts));
    for (const t of ticks ?? []) {
      expect(starts.has(t)).toBe(true);
      // Round to at least the bucket size (whole hours for ≥1h buckets) in UTC terms.
      expect(t % (Math.min(interval, 3600) * 1000)).toBe(0);
    }
  });
});
