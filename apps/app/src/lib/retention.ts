import type { RetentionStatus } from '@logbird/contracts';

/**
 * Where the next retention purge stands. A time already past is never "next": while a purge is running it is that one
 * (running now); otherwise the purge is overdue, which means the retention worker is delayed or stopped (#318). A
 * healthy worker advances the schedule when it starts the hourly job, and the status is fetched again right after the
 * deadline (see `retentionRefetchDelay`), so a page left open moves on with it.
 */
export function nextPurgeState(
  nextPurgeAt: string | null | undefined,
  now = Date.now(),
  running = false,
): 'none' | 'scheduled' | 'running' | 'overdue' {
  if (!nextPurgeAt) return 'none';
  const at = Date.parse(nextPurgeAt);
  if (Number.isNaN(at)) return 'none';
  if (at >= now) return 'scheduled';
  return running ? 'running' : 'overdue';
}

/** How soon to fetch the retention status again so an open page never keeps a stale schedule (ms, or false: never). */
export function retentionRefetchDelay(status: RetentionStatus | undefined, now = Date.now()): number | false {
  if (!status) return false;
  // A purge in progress: follow it until it ends.
  if (status.lastRun?.status === 'running') return 15_000;
  const at = status.nextPurgeAt ? Date.parse(status.nextPurgeAt) : Number.NaN;
  if (Number.isNaN(at)) return false;
  // Late: check every 30 s whether the worker has caught up.
  if (at < now) return 30_000;
  // Upcoming: right after the deadline (by then a healthy worker has moved the schedule on), at most 15 min away.
  return Math.min(Math.max(at - now + 2000, 2000), 15 * 60_000);
}
