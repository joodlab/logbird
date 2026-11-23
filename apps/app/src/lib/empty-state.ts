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
 * still running: it may yet say that the range is the reason (#239). While an id lookup runs, the line names it (in any
 * range), since the text may yet be an id; an incomplete lookup says so instead of advising a change (#334).
 */
export function otherDatesLine(check: {
  failed: boolean;
  checking: boolean;
  lookingUp?: boolean;
  /** The id lookup ended without a full answer (it failed, or some entity kinds could not be searched). */
  lookupIncomplete?: boolean;
  olderMatches: number | undefined;
  needsAsking: boolean;
}): string {
  if (check.failed) return 'Could not check other dates.';
  // Only the id lookup is running (the other-dates check waits for it): name that, not a check that has not started.
  if (check.lookingUp) return 'Looking up whether this is an id…';
  if (check.checking) return 'Checking other dates…';
  if (check.olderMatches)
    return `${formatNumber(check.olderMatches)} ${check.olderMatches === 1 ? 'event matches' : 'events match'} outside this range.`;
  if (check.needsAsking && check.olderMatches === undefined)
    return 'Other dates are checked only when you ask, since that runs the expression over all stored events.';
  // An incomplete lookup is not a confirmed miss: the text may still be an id (#334).
  if (check.lookupIncomplete) return 'Could not finish checking whether this is an id. Try the lookup again.';
  return 'Remove a filter or change the query.';
}

/**
 * Where the empty state's check of other dates stands. It failed only once the last attempt settled as an error: a retry
 * in flight is checking again, not failed. It is checking while an id lookup has not settled (a cached answer being
 * refreshed included) and while the all-time count has no answer for this search or is refreshing one (#239).
 * `lookingUp`: an id lookup has not settled, whatever the range (all time included), so no advice is given yet.
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
}): { failed: boolean; checking: boolean; lookingUp: boolean } {
  const failed = s.checkRuns && s.isError && !s.isFetching;
  const checking =
    s.showsEmpty && !s.complete && !s.idMatch && (!s.idSettled || (s.checkRuns && !failed && (s.olderMatches === undefined || s.isFetching)));
  const lookingUp = s.showsEmpty && !s.idMatch && !s.idSettled;
  return { failed, checking, lookingUp };
}

/**
 * The empty state's one action about other dates. A failed check offers its retry first: a count cached from an earlier
 * answer does not hold against "Could not check other dates" (#334). Then widening when older events match, then the
 * SQL check the reader has to ask for.
 */
export function otherDatesAction(s: {
  failed: boolean;
  checking: boolean;
  olderMatches: number | undefined;
  needsAsking: boolean;
}): 'retry' | 'search-all-time' | 'ask' | null {
  if (s.failed) return 'retry';
  if (s.olderMatches && s.olderMatches > 0 && !s.checking) return 'search-all-time';
  if (s.needsAsking) return 'ask';
  return null;
}
