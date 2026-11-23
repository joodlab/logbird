import { expect, it } from 'vitest';
import { allTimeCheckNeedsAsking, otherDatesLine } from './empty-state';

it('checks other dates by itself, except an SQL expression, which runs over every partition (#239)', () => {
  expect(allTimeCheckNeedsAsking('query', 'outcome:failure')).toBe(false);
  expect(allTimeCheckNeedsAsking('sql', "outcome = 'failure'")).toBe(true);
  // No expression, no predicate: as cheap as in query mode.
  expect(allTimeCheckNeedsAsking('sql', '  ')).toBe(false);
});

it('gives no advice while the check runs, and says what the check found once it has (#239)', () => {
  const base = { failed: false, checking: false, olderMatches: undefined, needsAsking: false };
  expect(otherDatesLine({ ...base, checking: true })).toBe('Checking other dates…');
  expect(otherDatesLine({ ...base, olderMatches: 1 })).toBe('1 event matches outside this range.');
  expect(otherDatesLine({ ...base, olderMatches: 2400 })).toBe('2,400 events match outside this range.');
  expect(otherDatesLine({ ...base, olderMatches: 0 })).toBe('Remove a filter or change the query.');
  expect(otherDatesLine({ ...base, failed: true, checking: true })).toBe('Could not check other dates.');
  expect(otherDatesLine({ ...base, needsAsking: true })).toBe(
    'Other dates are checked only when you ask, since that runs the expression over all stored events.',
  );
});
