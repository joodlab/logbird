import { expect, it } from 'vitest';
import { nextPurgeState, PURGE_GRACE_MS } from './retention';

const now = Date.parse('2026-11-23T12:00:00.000Z');
const at = (msFromNow: number) => new Date(now + msFromNow).toISOString();

it('never treats a past purge time as the next one (#318)', () => {
  expect(nextPurgeState(at(30 * 60_000), now)).toBe('scheduled');
  expect(nextPurgeState(at(0), now)).toBe('scheduled');
  // Just past its time: the worker is picking it up.
  expect(nextPurgeState(at(-60_000), now)).toBe('due');
  expect(nextPurgeState(at(-PURGE_GRACE_MS), now)).toBe('due');
  // Beyond the grace, and 13 hours late as in the report: overdue.
  expect(nextPurgeState(at(-PURGE_GRACE_MS - 1), now)).toBe('overdue');
  expect(nextPurgeState(at(-13 * 3_600_000), now)).toBe('overdue');
});

it('has nothing to say without a schedule', () => {
  expect(nextPurgeState(null, now)).toBe('none');
  expect(nextPurgeState(undefined, now)).toBe('none');
  expect(nextPurgeState('not a date', now)).toBe('none');
});
