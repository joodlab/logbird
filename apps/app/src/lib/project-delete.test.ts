import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api/errors';
import { deleteBlock, deleteBlockedMessage, secondsUntil } from './project-delete';

const refused = (code: string, retryAfter: number | null) => new ApiRequestError(503, code, 'Still settling.', undefined, retryAfter);

describe('project delete refused while writes are still settling', () => {
  it('ingest_pending: retries after the server Retry-After', () => {
    expect(deleteBlock(refused('ingest_pending', 42), 1_000_000)).toEqual({ reason: 'ingest', seconds: 42, retryAt: 1_042_000 });
    expect(deleteBlock(refused('ingest_pending', 0.4), 1_000_000)).toEqual({ reason: 'ingest', seconds: 1, retryAt: 1_001_000 });
  });

  it('falls back to the claim window (ingest) or a short wait (maintenance) without Retry-After', () => {
    expect(deleteBlock(refused('ingest_pending', null), 1_000_000)?.retryAt).toBe(1_070_000);
    expect(deleteBlock(refused('maintenance_pending', null), 1_000_000)).toEqual({ reason: 'maintenance', seconds: 10, retryAt: 1_010_000 });
  });

  it('leaves every other failure to the normal error toast', () => {
    expect(deleteBlock(refused('project_busy', 5))).toBeNull();
    expect(deleteBlock(new ApiRequestError(422, 'confirmation_required', 'Type the slug'))).toBeNull();
    expect(deleteBlock(new Error('network'))).toBeNull();
  });

  it('announces once what happened, that nothing was deleted and when to retry; then once that it can retry', () => {
    const ingest = deleteBlock(refused('ingest_pending', 42), 1_000_000);
    const maintenance = deleteBlock(refused('maintenance_pending', 10), 1_000_000);
    if (!ingest || !maintenance) throw new Error('expected blocks');
    expect(deleteBlockedMessage(ingest, true)).toBe('Events are still being written to this project; try again in about 42 s. Nothing was deleted.');
    expect(deleteBlockedMessage(maintenance, true)).toBe(
      'A maintenance job on this project is still stopping; try again in about 10 s. Nothing was deleted.',
    );
    // The live text does not change while counting down (no per-second announcements)…
    expect(deleteBlockedMessage(ingest, secondsUntil(ingest.retryAt, 1_001_000) > 0)).toBe(deleteBlockedMessage(ingest, true));
    // …and changes once when the wait is over.
    expect(secondsUntil(ingest.retryAt, 1_050_000)).toBe(0);
    expect(deleteBlockedMessage(ingest, false)).toBe('The writes have settled. Nothing was deleted yet — try again now.');
  });
});
