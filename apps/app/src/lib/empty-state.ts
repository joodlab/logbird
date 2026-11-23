import type { QueryLang } from '@logbird/contracts';
import { formatNumber } from './format';

/**
 * Whether the explorer's empty state may check other dates by itself. That check counts matches over all stored
 * events; in SQL mode it runs the reader's expression over every partition, so it runs only when asked (#239). With no
 * expression there is nothing to run and it is as cheap as in query mode.
 */
export const allTimeCheckNeedsAsking = (lang: QueryLang, q: string) => lang === 'sql' && Boolean(q.trim());

/**
 * The empty state's line about other dates, after "Nothing in this range matches …". No advice while the check is
 * still running: it may yet say that the range is the reason (#239).
 */
export function otherDatesLine(check: { failed: boolean; checking: boolean; olderMatches: number | undefined; needsAsking: boolean }): string {
  if (check.failed) return 'Could not check other dates.';
  if (check.checking) return 'Checking other dates…';
  if (check.olderMatches)
    return `${formatNumber(check.olderMatches)} ${check.olderMatches === 1 ? 'event matches' : 'events match'} outside this range.`;
  if (check.needsAsking && check.olderMatches === undefined)
    return 'Other dates are checked only when you ask, since that runs the expression over all stored events.';
  return 'Remove a filter or change the query.';
}

/**
 * Where the empty state's check of other dates stands. It failed only once the last attempt settled as an error: a retry
 * in flight is checking again, not failed. It is checking while an id lookup has not settled (a cached answer being
 * refreshed included) and while the all-time count has no answer for this search or is refreshing one (#239).
 */
export function otherDatesCheck(s: {
  showsEmpty: boolean;
  complete: boolean;
  idMatch: boolean;
  idSettled: boolean;
  checkRuns: boolean;
  olderMatches: number | undefined;
  isError: boolean;
  isFetching: boolean;
}): { failed: boolean; checking: boolean } {
  const failed = s.checkRuns && s.isError && !s.isFetching;
  const checking =
    s.showsEmpty && !s.complete && !s.idMatch && (!s.idSettled || (s.checkRuns && !failed && (s.olderMatches === undefined || s.isFetching)));
  return { failed, checking };
}
