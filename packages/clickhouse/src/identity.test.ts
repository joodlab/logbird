import { expect, it } from 'vitest';
import { eventFingerprint, retryFingerprint } from './identity';
import { normalizeEvent } from './normalize';

const receivedAt = new Date('2026-11-07T12:00:00Z');
it('compares normalized content, ignoring raw key order, receive time and SDK', () => {
  const input = { id: 'same', action: ' evidence.original ', actor: { id: 'actor' }, metadata: { a: 'a', b: 'b' } };
  const a = normalizeEvent(input, { projectId: 'fictional', receivedAt, sdk: 'one' });
  const b = normalizeEvent(
    { ...input, action: 'evidence.original', metadata: { b: 'b', a: 'a' } },
    { projectId: 'fictional', receivedAt, sdk: 'two' },
  );
  if (!a.ok || !b.ok) throw new Error('Invalid test fixture');
  expect(eventFingerprint(a.row)).toBe(eventFingerprint(b.row));
  for (const change of [
    { action: 'different' },
    { actor: { id: 'other' } },
    { changes: [{ field: 'status', after: 'approved' }] },
    { occurredAt: '2026-11-07T11:00:00Z' },
  ])
    expect(retryFingerprint({ ...input, ...change }, 'fictional', receivedAt, 'same')).not.toBe(eventFingerprint(a.row));
});
it.each([undefined, 'invalid', 123])('uses the original receive clock for retries with occurredAt=%s', (occurredAt) => {
  const input = { id: 'same', action: 'evidence.original', occurredAt };
  const first = normalizeEvent(input, { projectId: 'fictional', receivedAt });
  if (!first.ok) throw new Error('Invalid test fixture');
  expect(retryFingerprint(input, 'fictional', receivedAt, 'same')).toBe(eventFingerprint(first.row));
});
