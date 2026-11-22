import { expect, it } from 'vitest';
import { formatSearchTotal, searchTotal } from './search-total';

it('prefers an exact page, else the largest lower bound', () => {
  expect(searchTotal(undefined)).toEqual({ count: 0, exact: true });
  expect(searchTotal([{ total: 42 }])).toEqual({ count: 42, exact: true });
  expect(
    searchTotal([
      { total: 101, totalExact: false },
      { total: 202, totalExact: false },
    ]),
  ).toEqual({ count: 202, exact: false });
  expect(
    searchTotal([
      { total: 101, totalExact: false },
      { total: 350, totalExact: true },
    ]),
  ).toEqual({ count: 350, exact: true });
});

it('treats a legacy 10,001 total without totalExact as the cap', () => {
  expect(searchTotal([{ total: 10_001 }])).toEqual({ count: 10_001, exact: false });
  expect(formatSearchTotal(searchTotal([{ total: 10_001 }]))).toBe('10,000+');
});

it('formats exact totals, lower bounds and the cap', () => {
  expect(formatSearchTotal({ count: 1234, exact: true })).toBe('1,234');
  expect(formatSearchTotal({ count: 101, exact: false })).toBe('≥ 101');
  expect(formatSearchTotal({ count: 10_001, exact: false })).toBe('10,000+');
});
