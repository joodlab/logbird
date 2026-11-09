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

type Lookups = { hasAccount: (email: string) => Promise<boolean>; hasPendingInvitation: (email: string, now: Date) => Promise<boolean> };

const databaseLookups: Lookups = {
  hasAccount: async (email) => (await prisma.user.count({ where: { email: { equals: email, mode: 'insensitive' } } })) > 0,
  hasPendingInvitation: async (email, now) =>
    (await prisma.invitation.count({ where: { email: { equals: email, mode: 'insensitive' }, status: 'pending', expiresAt: { gt: now } } })) > 0,
};

/**
 * Whether `email` may sign in, creating an account if needed. Existing accounts always may.
 * Under `restricted`, a new account needs an approved domain or a pending, unexpired email invitation.
 */
export async function mayCreateAccount(
  email: string,
  policy: SignupPolicy = signupPolicy,
  lookups: Lookups = databaseLookups,
  now = new Date(),
): Promise<boolean> {
  if (policy.mode === 'open') return true;
  const normalized = email.trim().toLowerCase();
  if (policy.domains.has(emailDomain(normalized))) return true;
  return (await lookups.hasAccount(normalized)) || (await lookups.hasPendingInvitation(normalized, now));
}

export const SIGNUP_RESTRICTED_MESSAGE =
  'This Logbird instance only accepts new accounts from approved email domains or by invitation. Ask a workspace owner to invite you.';
