import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api/errors';
import { deleteBlockedMessage, deleteRetryAt, secondsUntil } from './project-delete';

const pending = (retryAfter: number | null) =>
  new ApiRequestError(503, 'ingest_pending', 'Recent writes to this project are still settling.', undefined, retryAfter);

describe('project delete refused while events are still being written (503 ingest_pending)', () => {
  it('retries after the server Retry-After', () => {
    expect(deleteRetryAt(pending(42), 1_000_000)).toBe(1_042_000);
    expect(deleteRetryAt(pending(0.4), 1_000_000)).toBe(1_001_000);
  });

  it('falls back to the claim window when Retry-After is missing', () => {
    expect(deleteRetryAt(pending(null), 1_000_000)).toBe(1_070_000);
  });

  it('leaves every other failure to the normal error toast', () => {
    expect(deleteRetryAt(new ApiRequestError(503, 'project_busy', 'busy', undefined, 5))).toBeNull();
    expect(deleteRetryAt(new ApiRequestError(422, 'confirmation_required', 'Type the slug'))).toBeNull();
    expect(deleteRetryAt(new Error('network'))).toBeNull();
  });

  it('says what happened, that nothing was deleted, and when to retry', () => {
    const at = deleteRetryAt(pending(42), 1_000_000) as number;
    expect(deleteBlockedMessage(at, 1_000_000)).toBe('Events are still being written to this project; try again in ~42 s. Nothing was deleted.');
    expect(deleteBlockedMessage(at, 1_041_100)).toContain('try again in ~1 s');
    expect(secondsUntil(at, 1_050_000)).toBe(0);
    expect(deleteBlockedMessage(at, 1_050_000)).toBe('The last writes have settled. Nothing was deleted yet — try again now.');
  });
});
