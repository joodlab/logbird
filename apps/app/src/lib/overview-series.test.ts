import { expect, it } from 'vitest';
import { perMinuteSeries, rateChange } from './overview-series';

const at = (iso: string) => Date.parse(iso);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

it('fills the minutes without events, so one event still draws a line', () => {
  const series = perMinuteSeries([{ ts: '2026-11-24T10:28:00Z', count: 1 }], at('2026-11-24T10:30:20Z'));
  expect(series).toHaveLength(61);
  expect(sum(series)).toBe(1);
  expect(series.at(-3)).toBe(1);
});

it('keeps every bucket the server counted: a browser clock behind, the inclusive lower bound, a time stamped ahead', () => {
  // The server's newest bucket is a minute ahead of this browser.
  expect(sum(perMinuteSeries([{ ts: '2026-11-24T10:30:00Z', count: 1 }], at('2026-11-24T10:29:58Z')))).toBe(1);
  // At exactly 10:30:00 the server's window (now - 60 min, inclusive) can return 09:30.
  expect(sum(perMinuteSeries([{ ts: '2026-11-24T09:30:00Z', count: 2 }], at('2026-11-24T10:30:00Z')))).toBe(2);
  // The browser clock ahead: at server 10:30:20 a 09:31 bucket counts toward "Last hour"; the browser reads 10:32.
  expect(sum(perMinuteSeries([{ ts: '2026-11-24T09:31:00Z', count: 1 }], at('2026-11-24T10:32:00Z')))).toBe(1);
  // A clock hours off is ignored: the window ends at the newest bucket.
  const far = perMinuteSeries([{ ts: '2026-11-24T10:30:00Z', count: 4 }], at('2026-11-25T10:30:00Z'));
  expect(sum(far)).toBe(4);
  expect(far).toHaveLength(61);
  // Unreadable times are left out.
  expect(sum(perMinuteSeries([{ ts: 'x', count: 2 }], at('2026-11-24T10:30:00Z')))).toBe(0);
});

it('says nothing about a rate when the current period is empty, and "new" only against an empty previous one', () => {
  expect(rateChange(0.143, 7, 0, 0)).toBeNull();
  expect(rateChange(0.143, 7, 0.1, 10)).toBeCloseTo(0.043);
  expect(rateChange(0, 0, 0.5, 10)).toBeUndefined();
  expect(rateChange(0, 0, 0, 0)).toBeUndefined();
});
