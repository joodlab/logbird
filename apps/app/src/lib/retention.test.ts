import type { RetentionStatus } from '@logbird/contracts';
import { expect, it } from 'vitest';
import { nextPurgeState, retentionRefetchDelay } from './retention';

const now = Date.parse('2026-11-23T12:00:00.000Z');
const at = (msFromNow: number) => new Date(now + msFromNow).toISOString();

it('never treats a past purge time as the next one: past is overdue, from the first second (#318)', () => {
  expect(nextPurgeState(at(30 * 60_000), now)).toBe('scheduled');
  expect(nextPurgeState(at(0), now)).toBe('scheduled');
  expect(nextPurgeState(at(-1), now)).toBe('overdue');
  expect(nextPurgeState(at(-60_000), now)).toBe('overdue');
  // 13 hours late, as in the report.
  expect(nextPurgeState(at(-13 * 3_600_000), now)).toBe('overdue');
});

it('has nothing to say without a schedule', () => {
  expect(nextPurgeState(null, now)).toBe('none');
  expect(nextPurgeState(undefined, now)).toBe('none');
  expect(nextPurgeState('not a date', now)).toBe('none');
});

it('a purge that is running is that one, never overdue', () => {
  expect(nextPurgeState(at(-13 * 3_600_000), now, true)).toBe('running');
  expect(nextPurgeState(at(-60_000), now, true)).toBe('running');
  // A future time is still the next one, running or not.
  expect(nextPurgeState(at(30 * 60_000), now, true)).toBe('scheduled');
});

const status = (nextPurgeAt: string | null, run?: string): RetentionStatus => ({
  retentionDays: 90,
  oldestEventAt: null,
  nextPurgeAt,
  previewDeletedEvents: null,
  lastRun: run ? { startedAt: at(-60_000), finishedAt: null, deletedEvents: null, status: run, cutoff: at(-90 * 86_400_000), error: null } : null,
});

it('an open page fetches the status again right after the deadline, and keeps checking while late or running', () => {
  // Due in 1 minute: fetched again 2 s after the deadline, when a healthy worker has moved the schedule on.
  expect(retentionRefetchDelay(status(at(60_000)), now)).toBe(62_000);
  // Far away: at most every 15 minutes.
  expect(retentionRefetchDelay(status(at(50 * 60_000)), now)).toBe(15 * 60_000);
  // Late: every 30 s, so the page moves on as soon as the worker catches up.
  expect(retentionRefetchDelay(status(at(-6 * 60_000)), now)).toBe(30_000);
  // Running: every 15 s until it ends.
  expect(retentionRefetchDelay(status(at(-6 * 60_000), 'running'), now)).toBe(15_000);
  // Nothing scheduled, or no answer yet: no polling.
  expect(retentionRefetchDelay(status(null), now)).toBe(false);
  expect(retentionRefetchDelay(undefined, now)).toBe(false);
});
