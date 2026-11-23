import { expect, it } from 'vitest';
import { formatDuration } from './format';

it('reads durations at a glance, from milliseconds to hours', () => {
  expect(formatDuration(0)).toBe('0 ms');
  expect(formatDuration(412)).toBe('412 ms');
  expect(formatDuration(1500)).toBe('1.50 s');
  expect(formatDuration(61_002)).toBe('1 m 1 s');
  expect(formatDuration(120_000)).toBe('2 m');
  expect(formatDuration(3_600_000)).toBe('1 h 0 m');
});

it('rounds before splitting, so a remainder never reads 60 seconds', () => {
  expect(formatDuration(119_999)).toBe('2 m');
  expect(formatDuration(3_599_999)).toBe('1 h 0 m');
});
