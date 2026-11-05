import { expect, it } from 'vitest';
import { inviteLinkState } from './invite-link-state';

it('derives active, exhausted, expired and revoked in precedence order, including expiry boundary', () => {
  const now = new Date();
  const link = { expiresAt: new Date(now.getTime() + 1000), revokedAt: null, maxUses: 1, uses: 0 };
  expect(inviteLinkState(link, now)).toBe('active');
  expect(inviteLinkState({ ...link, maxUses: null, uses: 9999 }, now)).toBe('active');
  expect(inviteLinkState({ ...link, uses: 1 }, now)).toBe('exhausted');
  expect(inviteLinkState({ ...link, uses: 1, expiresAt: now }, now)).toBe('expired');
  expect(inviteLinkState({ ...link, uses: 1, expiresAt: now, revokedAt: now }, now)).toBe('revoked');
});
