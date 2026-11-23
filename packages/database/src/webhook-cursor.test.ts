import { expect, it } from 'vitest';
import { webhookCursorNeedsReview } from './webhook-cursor';

const createdAt = new Date('2026-11-23T10:00:00.000Z');
const clock = { rollout: new Date(+createdAt - 120_000), now: new Date(+createdAt + 1000) };

it.each([
  { offset: -11, review: false },
  { offset: -59_000, review: false },
  { offset: -61_000, review: true },
  { offset: 1001, review: true },
])('returns review=$review for a new cursor $offset ms from creation', ({ offset, review }) => {
  const endpoint = {
    createdAt,
    cursorReceivedAt: new Date(+createdAt + offset),
    cursorEventId: null,
    cursorVerifiedFloor: null,
    lastScannedAt: null,
  };
  expect(webhookCursorNeedsReview(endpoint, clock)).toBe(review);
});

it.each([
  { lastScannedAt: null, cursorEventId: 'qa-event' },
  { lastScannedAt: clock.now, cursorEventId: null },
  { lastScannedAt: clock.now, cursorEventId: 'qa-event' },
])('requires evidence of progress for an early cursor with scan state %j', (scanState) => {
  expect(webhookCursorNeedsReview({ createdAt, cursorReceivedAt: new Date(+createdAt - 11), cursorVerifiedFloor: null, ...scanState }, clock)).toBe(
    true,
  );
});
