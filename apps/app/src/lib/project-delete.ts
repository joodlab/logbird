import { ApiRequestError } from './api/errors';

/** Used when the server refuses with `ingest_pending` but sends no Retry-After (its window is lease + flush bound). */
const DEFAULT_WAIT_SECONDS = 70;

/**
 * A project delete the server refused because events were still being written (503 `ingest_pending`): nothing was
 * deleted, and the same request succeeds once the writes have settled. Returns when it is worth retrying (epoch ms),
 * or null for any other failure.
 */
export function deleteRetryAt(error: unknown, now = Date.now()): number | null {
  if (!(error instanceof ApiRequestError) || error.status !== 503 || error.code !== 'ingest_pending') return null;
  const seconds = error.retryAfter && error.retryAfter > 0 ? error.retryAfter : DEFAULT_WAIT_SECONDS;
  return now + Math.ceil(seconds) * 1000;
}

/** Whole seconds left until `retryAt` (never negative). */
export function secondsUntil(retryAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}

/** What the delete dialog says while it waits. */
export function deleteBlockedMessage(retryAt: number, now = Date.now()): string {
  const left = secondsUntil(retryAt, now);
  return left > 0
    ? `Events are still being written to this project; try again in ~${left} s. Nothing was deleted.`
    : 'The last writes have settled. Nothing was deleted yet — try again now.';
}
