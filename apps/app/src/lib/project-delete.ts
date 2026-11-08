import { ApiRequestError } from './api/errors';

/** Fallback waits when the server sends no Retry-After: the ingest claim window (lease + flush bound), maintenance stop. */
const DEFAULT_WAIT_SECONDS = { ingest: 70, maintenance: 10 } as const;

export type DeleteBlockReason = keyof typeof DEFAULT_WAIT_SECONDS;
export interface DeleteBlock {
  reason: DeleteBlockReason;
  /** When retrying is worth it (epoch ms). */
  retryAt: number;
  /** Whole seconds to wait, as announced once when the delete was refused. */
  seconds: number;
}

/**
 * A project delete the server refused while writes to the project were still settling — events being written (503
 * `ingest_pending`) or a maintenance job still stopping (503 `maintenance_pending`). Nothing was deleted, and the same
 * request succeeds once they have settled. Null for any other failure.
 */
export function deleteBlock(error: unknown, now = Date.now()): DeleteBlock | null {
  if (!(error instanceof ApiRequestError) || error.status !== 503) return null;
  const reason: DeleteBlockReason | null = error.code === 'ingest_pending' ? 'ingest' : error.code === 'maintenance_pending' ? 'maintenance' : null;
  if (!reason) return null;
  const seconds = Math.ceil(error.retryAfter && error.retryAfter > 0 ? error.retryAfter : DEFAULT_WAIT_SECONDS[reason]);
  return { reason, seconds, retryAt: now + seconds * 1000 };
}

/** Whole seconds left until `retryAt` (never negative). */
export function secondsUntil(retryAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}

/**
 * What the dialog announces (a polite live region): said once when the delete is refused, and once more when the
 * wait is over — never a per-second countdown (the ticking number lives in the button label).
 */
export function deleteBlockedMessage(block: DeleteBlock, waiting: boolean): string {
  if (!waiting) return 'The writes have settled. Nothing was deleted yet — try again now.';
  return block.reason === 'ingest'
    ? `Events are still being written to this project; try again in about ${block.seconds} s. Nothing was deleted.`
    : `A maintenance job on this project is still stopping; try again in about ${block.seconds} s. Nothing was deleted.`;
}
