import { prisma } from '@logbird/database';
import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

const env = createEnv({
  server: {
    // `open` keeps the self-hosting default: the sign-in step also creates accounts.
    AUTH_SIGNUP: z.enum(['open', 'restricted']).default('open'),
    // Comma-separated email domains that may create accounts when AUTH_SIGNUP=restricted.
    AUTH_SIGNUP_DOMAINS: z.string().default(''),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});

export type SignupPolicy = { mode: 'open' | 'restricted'; domains: ReadonlySet<string> };

export function parseSignupDomains(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(',')
      .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean),
  );
}

export const signupPolicy: SignupPolicy = { mode: env.AUTH_SIGNUP, domains: parseSignupDomains(env.AUTH_SIGNUP_DOMAINS) };

export const emailDomain = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

type Lookups = {
  hasAccount: (email: string) => Promise<boolean>;
  hasPendingInvitation: (email: string, now: Date) => Promise<boolean>;
  hasActiveDomainInviteLink: (domain: string, now: Date) => Promise<boolean>;
};

const databaseLookups: Lookups = {
  // better-auth stores and looks up lowercased addresses, so match exactly on the normalized form.
  hasAccount: async (email) => (await prisma.user.count({ where: { email } })) > 0,
  hasPendingInvitation: async (email, now) =>
    (await prisma.invitation.count({ where: { email: { equals: email, mode: 'insensitive' }, status: 'pending', expiresAt: { gt: now } } })) > 0,
  // An owner who shares a link limited to a domain has approved that domain for joining.
  hasActiveDomainInviteLink: async (domain, now) =>
    (
      await prisma.inviteLink.findMany({
        where: { allowedDomain: { equals: domain, mode: 'insensitive' }, revokedAt: null, expiresAt: { gt: now } },
        select: { maxUses: true, uses: true },
      })
    ).some((link) => link.maxUses === null || link.uses < link.maxUses),
};

/**
 * Whether `email` may sign in, creating an account if needed. Existing accounts always may.
 * Under `restricted`, a new account needs an approved domain, a pending unexpired email invitation, or an
 * active invite link limited to the address's domain.
 */
export async function mayCreateAccount(
  email: string,
  policy: SignupPolicy = signupPolicy,
  lookups: Lookups = databaseLookups,
  now = new Date(),
): Promise<boolean> {
  if (policy.mode === 'open') return true;
  const normalized = email.trim().toLowerCase();
  const domain = emailDomain(normalized);
  if (policy.domains.has(domain)) return true;
  return (
    (await lookups.hasAccount(normalized)) ||
    (await lookups.hasPendingInvitation(normalized, now)) ||
    (await lookups.hasActiveDomainInviteLink(domain, now))
  );
}

/** Under `restricted`, only approved domains may create workspaces (and so invite new people). */
export function mayCreateWorkspace(email: string, policy: SignupPolicy = signupPolicy) {
  return policy.mode === 'open' || policy.domains.has(emailDomain(email.trim()));
}
