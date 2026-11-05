import type { InvitationEmailProps } from './templates/invitation';
import type { MemberJoinedEmailProps } from './templates/member-joined';
import type { RoleChangedEmailProps } from './templates/role-changed';
import type { SignInCodeEmailProps } from './templates/sign-in-code';

/** Realistic sample props shared by the Vitest suite and the react-email preview (`pnpm --filter @trailmark/email dev`). */
const appUrl = 'https://audit.acme.test';
const at = new Date('2026-11-05T14:32:00Z');

export const fixtures = {
  signInCode: {
    appUrl,
    email: 'lina@acme.test',
    code: '482913',
    purpose: 'sign-in',
    expiresInMinutes: 10,
    requestedAt: at,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    ip: '203.0.113.24',
  } satisfies SignInCodeEmailProps,
  invitation: {
    appUrl,
    email: 'lina@acme.test',
    workspace: 'Acme',
    inviterName: 'Raed Bahri',
    inviterEmail: 'raed@acme.test',
    role: 'admin',
    url: `${appUrl}/accept-invitation/inv_7Hc2kP9xQm`,
    expiresAt: new Date('2026-11-07T14:32:00Z'),
    sentAt: at,
  } satisfies InvitationEmailProps,
  memberJoined: {
    appUrl,
    workspace: 'Acme',
    memberName: 'Lina Haddad',
    memberEmail: 'lina@acme.test',
    role: 'admin',
    joinedAt: at,
    inviterEmail: 'raed@acme.test',
  } satisfies MemberJoinedEmailProps,
  roleChanged: {
    appUrl,
    email: 'lina@acme.test',
    workspace: 'Acme',
    previousRole: 'member',
    role: 'admin',
    changedByName: 'Raed Bahri',
    changedByEmail: 'raed@acme.test',
    changedAt: at,
  } satisfies RoleChangedEmailProps,
};
