import { expect, it } from 'vitest';
import { perMinuteSeries, rateChange } from './overview-series';

it('fills the minutes without events, so one event still draws a line', () => {
  const now = Date.parse('2026-11-24T10:30:20Z');
  const series = perMinuteSeries([{ ts: '2026-11-24T10:28:00Z', count: 1 }], now);
  expect(series).toHaveLength(60);
  expect(series.reduce((a, b) => a + b, 0)).toBe(1);
  expect(series[57]).toBe(1);
  // Out of the window or unreadable times are left out.
  expect(
    perMinuteSeries(
      [
        { ts: '2026-11-24T09:00:00Z', count: 5 },
        { ts: 'x', count: 2 },
      ],
      now,
    ).every((v) => v === 0),
  ).toBe(true);
  expect(perMinuteSeries([{ ts: '2026-11-24T10:30:59Z', count: 3 }], now)[59]).toBe(3);
});

it('reports no failure-rate change against a period without events', () => {
  expect(rateChange(14.3, 0, 0)).toBeNull();
  expect(rateChange(14.3, 10, 7)).toBeCloseTo(4.3);
});
