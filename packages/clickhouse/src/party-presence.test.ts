import { expect, it } from 'vitest';
import { normalizeEvent } from './normalize';
import { toEvent } from './queries';

function read(input: Record<string, unknown>) {
  const r = normalizeEvent({ action: 'invoice.sent', ...input }, { projectId: 'p', receivedAt: new Date() });
  if (!r.ok) throw new Error(r.reason);
  return toEvent(r.row);
}

it('reads a party recorded by a name or an email alone as recorded, not as missing', () => {
  const event = read({ actor: { email: 'lina@example.test' }, executor: { name: 'Billing worker' } });
  expect(event.actor).toEqual({ id: '', type: '', name: '', email: 'lina@example.test' });
  expect(event.executor).toMatchObject({ id: '', type: '', name: 'Billing worker' });
  expect(read({ actor: { name: 'Lina Haddad' } }).actor).toMatchObject({ id: '', name: 'Lina Haddad' });
});

it('still reads a party with nothing recorded as absent', () => {
  const event = read({});
  expect(event.actor).toBeNull();
  expect(event.executor).toBeNull();
  // A job id or attempt alone does not say who performed it.
  expect(read({ executor: { jobId: 'job_1', attempt: 2 } }).executor).toBeNull();
});
