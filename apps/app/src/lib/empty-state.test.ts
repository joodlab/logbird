import { expect, it } from 'vitest';
import { allTimeCheckNeedsAsking, otherDatesAction, otherDatesCheck, otherDatesLine } from './empty-state';

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

it('says a check is running while a retry or a refresh is in flight, and failed only once it settles as one (#239)', () => {
  const base = {
    showsEmpty: true,
    complete: false,
    idMatch: false,
    idSettled: true,
    checkRuns: true,
    olderMatches: undefined,
    isError: false,
    isFetching: false,
  };
  expect(otherDatesCheck({ ...base, isFetching: true })).toEqual({ failed: false, checking: true, lookingUp: false });
  expect(otherDatesCheck({ ...base, olderMatches: 4 })).toEqual({ failed: false, checking: false, lookingUp: false });
  // A cached count being refreshed gives no advice yet.
  expect(otherDatesCheck({ ...base, olderMatches: 4, isFetching: true })).toEqual({ failed: false, checking: true, lookingUp: false });
  // A failed refetch keeps its cached count; retrying it is checking again, not "could not check".
  expect(otherDatesCheck({ ...base, olderMatches: 4, isError: true, isFetching: true })).toEqual({ failed: false, checking: true, lookingUp: false });
  expect(otherDatesCheck({ ...base, olderMatches: 4, isError: true })).toEqual({ failed: true, checking: false, lookingUp: false });
  // An id lookup that has not settled (a refreshed cached answer included) holds the advice too.
  expect(otherDatesCheck({ ...base, idSettled: false, checkRuns: false })).toEqual({ failed: false, checking: true, lookingUp: true });
  // In a range that holds every event there is nothing to check, but a refreshing id lookup still holds the advice.
  expect(otherDatesCheck({ ...base, complete: true, idSettled: false, checkRuns: false })).toEqual({
    failed: false,
    checking: false,
    lookingUp: true,
  });
  // While only the id lookup runs, the line names that (never "Checking other dates…", which has not started) (#334).
  expect(otherDatesLine({ failed: false, checking: false, lookingUp: true, olderMatches: undefined, needsAsking: false })).toBe(
    'Looking up whether this is an id…',
  );
  expect(otherDatesLine({ failed: false, checking: true, lookingUp: true, olderMatches: undefined, needsAsking: false })).toBe(
    'Looking up whether this is an id…',
  );
  // Nothing to check: an id match, a complete answer, or results on screen.
  expect(otherDatesCheck({ ...base, idMatch: true })).toEqual({ failed: false, checking: false, lookingUp: false });
  expect(otherDatesCheck({ ...base, complete: true })).toEqual({ failed: false, checking: false, lookingUp: false });
  expect(otherDatesCheck({ ...base, showsEmpty: false })).toEqual({ failed: false, checking: false, lookingUp: false });
});

it('never gives confirmed-miss advice after an id lookup that could not finish (#334)', () => {
  const settled = { failed: false, checking: false, lookingUp: false, olderMatches: 0, needsAsking: false };
  expect(otherDatesLine({ ...settled, lookupIncomplete: true })).toBe('Could not finish checking whether this is an id. Try the lookup again.');
  expect(otherDatesLine({ ...settled, olderMatches: undefined, lookupIncomplete: true })).toBe(
    'Could not finish checking whether this is an id. Try the lookup again.',
  );
  // Older matches still say so: the range is a reason whatever the lookup said.
  expect(otherDatesLine({ ...settled, olderMatches: 3, lookupIncomplete: true })).toBe('3 events match outside this range.');
  expect(otherDatesLine({ ...settled })).toBe('Remove a filter or change the query.');
});

it(`offers "Retry the check" after a failed refresh, never a cached count's "Search all time" (#334)`, () => {
  expect(otherDatesAction({ failed: true, checking: false, olderMatches: 4, needsAsking: false })).toBe('retry');
  expect(otherDatesAction({ failed: false, checking: false, olderMatches: 4, needsAsking: false })).toBe('search-all-time');
  expect(otherDatesAction({ failed: false, checking: true, olderMatches: 4, needsAsking: false })).toBeNull();
  expect(otherDatesAction({ failed: false, checking: false, olderMatches: undefined, needsAsking: true })).toBe('ask');
  expect(otherDatesAction({ failed: false, checking: false, olderMatches: 0, needsAsking: false })).toBeNull();
});
