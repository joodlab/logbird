/** How long past its time a purge may still be starting before it counts as overdue (the job runs hourly). */
export const PURGE_GRACE_MS = 5 * 60_000;

/**
 * Where the next retention purge stands. A time already past is never "next": within the grace it is due now (the
 * worker picks it up), beyond it the purge is overdue, which usually means the worker is down or behind.
 */
export function nextPurgeState(nextPurgeAt: string | null | undefined, now = Date.now()): 'none' | 'scheduled' | 'due' | 'overdue' {
  if (!nextPurgeAt) return 'none';
  const at = Date.parse(nextPurgeAt);
  if (Number.isNaN(at)) return 'none';
  if (at >= now) return 'scheduled';
  return now - at <= PURGE_GRACE_MS ? 'due' : 'overdue';
}
