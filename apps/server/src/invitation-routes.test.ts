import { describe, expect, it } from 'vitest';
import { invitationState } from './invitation-routes';

const now = new Date('2026-11-05T12:00:00Z');
const later = new Date('2026-11-06T12:00:00Z');
const earlier = new Date('2026-11-04T12:00:00Z');

describe('invitation state', () => {
  it('reports pending invitations that are still valid', () => {
    expect(invitationState('pending', later, now)).toBe('pending');
  });
  it('turns a pending invitation past its expiry into expired', () => {
    expect(invitationState('pending', earlier, now)).toBe('expired');
  });
  it('keeps terminal states even after expiry', () => {
    expect(invitationState('accepted', earlier, now)).toBe('accepted');
    expect(invitationState('rejected', later, now)).toBe('rejected');
    expect(invitationState('canceled', later, now)).toBe('canceled');
  });
  it('treats unknown storage values as withdrawn', () => {
    expect(invitationState('weird', later, now)).toBe('canceled');
  });
});
