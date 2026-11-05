import type { InvitationEmailProps } from './templates/invitation';
import type { MemberJoinedEmailProps } from './templates/member-joined';
import type { RoleChangedEmailProps } from './templates/role-changed';
import type { SignInCodeEmailProps } from './templates/sign-in-code';

/**
 * Realistic sample props for every email: the Vitest suite, the preview app (`apps/email`) and its `send` command
 * all render from these. `appUrl` and `now` are overridable so a test send links to the real install.
 */
export function createFixtures({ appUrl = 'https://audit.acme.test', now = new Date('2026-11-05T14:32:00Z') } = {}) {
  const inDays = (days: number) => new Date(now.getTime() + days * 86_400_000);
  return {
    signInCode: {
      appUrl,
      email: 'lina@acme.test',
      code: '482913',
      purpose: 'sign-in',
      expiresInMinutes: 10,
      requestedAt: now,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      ip: '203.0.113.24',
    } satisfies SignInCodeEmailProps,
    invitation: {
      appUrl,
      email: 'lina@acme.test',
      workspace: 'Acme',
      inviterName: 'Sami Nasser',
      inviterEmail: 'sami@acme.test',
      role: 'admin',
      url: `${appUrl}/accept-invitation/inv_7Hc2kP9xQm`,
      expiresAt: inDays(2),
      sentAt: now,
    } satisfies InvitationEmailProps,
    memberJoined: {
      appUrl,
      workspace: 'Acme',
      memberName: 'Lina Haddad',
      memberEmail: 'lina@acme.test',
      role: 'admin',
      joinedAt: now,
      inviterEmail: 'sami@acme.test',
    } satisfies MemberJoinedEmailProps,
    roleChanged: {
      appUrl,
      email: 'lina@acme.test',
      workspace: 'Acme',
      previousRole: 'member',
      role: 'admin',
      changedByName: 'Sami Nasser',
      changedByEmail: 'sami@acme.test',
      changedAt: now,
    } satisfies RoleChangedEmailProps,
  };
}

export type EmailFixtures = ReturnType<typeof createFixtures>;

/** Default fixtures (fixed clock, so snapshots and previews are stable). */
export const fixtures: EmailFixtures = createFixtures();
