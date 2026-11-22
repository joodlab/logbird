import { expect, it } from 'vitest';
import { explorerTotal, formatSearchTotal, searchTotal } from './search-total';

it('uses the newest page, else a lower bound', () => {
  expect(searchTotal(undefined)).toEqual({ count: 0, exact: true });
  expect(searchTotal([{ total: 42 }])).toEqual({ count: 42, exact: true });
  expect(
    searchTotal([
      { total: 101, totalExact: false },
      { total: 202, totalExact: false },
    ]),
  ).toEqual({ count: 202, exact: false });
  // An older, larger total is stale once a newer page counts exactly.
  expect(
    searchTotal(
      [
        { total: 350, totalExact: true },
        { total: 300, totalExact: true },
      ],
      200,
      true,
    ),
  ).toEqual({ count: 300, exact: true });
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

it('never shows a total below the rows on screen', () => {
  // Page one said 101 exactly; later pages brought 200 distinct rows and say 200 exactly.
  expect(
    searchTotal(
      [
        { total: 101, totalExact: true },
        { total: 200, totalExact: true },
      ],
      200,
      false,
    ),
  ).toEqual({ count: 200, exact: true });
  // Every count timed out; two full pages and a next page prove at least 201.
  expect(
    searchTotal(
      [
        { total: 101, totalExact: false },
        { total: 101, totalExact: false },
      ],
      200,
      true,
    ),
  ).toEqual({ count: 201, exact: false });
  // An exact total below what is loaded is disproved.
  expect(searchTotal([{ total: 50, totalExact: true }], 80, false)).toEqual({ count: 80, exact: false });
});

it('lets a newer lower bound disprove an older exact total', () => {
  expect(
    searchTotal(
      [
        { total: 350, totalExact: true },
        { total: 10_001, totalExact: false },
      ],
      200,
      true,
    ),
  ).toEqual({ count: 10_001, exact: false });
});

it('never lets the histogram undercut what the page proves', () => {
  const base = { search: { count: 101, exact: false }, pagedCount: 100, hasNextPage: true, visibleRows: 100 };
  // The cursor proves at least 101; a histogram of 100 is disproved.
  expect(explorerTotal({ ...base, histogramTotal: 100 })).toEqual({ count: 101, exact: false });
  expect(explorerTotal({ ...base, histogramTotal: 150 })).toEqual({ count: 150, exact: true });
  expect(explorerTotal({ ...base, histogramTotal: undefined })).toEqual({ count: 101, exact: false });
  // A live row the pages do not show: at least the aggregate, as a lower bound.
  expect(explorerTotal({ ...base, histogramTotal: 150, visibleRows: 101 })).toEqual({ count: 150, exact: false });
  expect(explorerTotal({ histogramTotal: 3, search: { count: 3, exact: true }, pagedCount: 3, hasNextPage: false, visibleRows: 3 })).toEqual({
    count: 3,
    exact: true,
  });
});
