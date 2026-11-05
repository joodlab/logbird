import { AsyncLocalStorage } from 'node:async_hooks';
import { createEnv } from '@t3-oss/env-core';
import { SIGN_IN_CODE_TTL_SECONDS } from '@trailmark/contracts';
import { prisma } from '@trailmark/database';
import { sendOrganizationInvitation, sendSignInCode } from '@trailmark/email';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { emailOTP, organization } from 'better-auth/plugins';
import { z } from 'zod';

type AuditUser = { id: string; name: string; email: string };
type AuthAudit = {
  organizationId: string;
  action: string;
  actor: AuditUser;
  target: { type: string; id: string; name?: string };
  changes?: unknown[];
  context?: { requestId: string; ip: string; userAgent: string };
};
export const authAuditContext = new AsyncLocalStorage<{ actor?: AuditUser; requestId: string; ip: string; userAgent: string }>();
let auditHandler: ((event: AuthAudit) => Promise<unknown>) | undefined;
export const setAuthAuditHandler = (handler: NonNullable<typeof auditHandler>) => {
  auditHandler = handler;
};
function record(
  organizationId: string,
  action: string,
  fallback: AuditUser,
  target: { type: string; id: string; name?: string },
  changes?: unknown[],
) {
  const context = authAuditContext.getStore();
  return auditHandler?.({
    organizationId,
    action,
    actor: action === 'auth.signed_in' ? fallback : (context?.actor ?? fallback),
    target,
    changes,
    context,
  });
}
const env = createEnv({
  server: { APP_URL: z.url(), TRUSTED_ORIGINS: z.string().default(''), BETTER_AUTH_SECRET: z.string().min(32) },
  runtimeEnv: process.env,
});
if (
  process.env.NODE_ENV === 'production' &&
  new URL(env.APP_URL).protocol !== 'https:' &&
  !['localhost', '127.0.0.1'].includes(new URL(env.APP_URL).hostname)
)
  throw new Error('APP_URL must use HTTPS in production');
export const auth = betterAuth({
  baseURL: env.APP_URL,
  // The API boundary enforces shared Redis limits across replicas.
  rateLimit: { enabled: false },
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.APP_URL, ...env.TRUSTED_ORIGINS.split(',').filter(Boolean)],
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  advanced: { useSecureCookies: new URL(env.APP_URL).protocol === 'https:', defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' } },
  databaseHooks: {
    session: {
      create: {
        after: async (session) => {
          const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
          for (const member of await prisma.member.findMany({ where: { userId: user.id } }))
            await record(member.organizationId, 'auth.signed_in', user, { type: 'user', id: user.id, name: user.email });
        },
      },
    },
  },
  plugins: [
    emailOTP({
      otpLength: 6,
      storeOTP: 'hashed',
      expiresIn: SIGN_IN_CODE_TTL_SECONDS,
      disableSignUp: false,
      async sendVerificationOTP({ email, otp }) {
        await sendSignInCode(email, otp);
      },
    }),
    organization({
      organizationHooks: {
        afterCreateOrganization: async ({ organization, user }) => {
          await record(organization.id, 'organization.created', user, { type: 'organization', id: organization.id, name: organization.name });
        },
        afterCreateInvitation: async ({ organization, inviter, invitation }) => {
          await record(organization.id, 'member.invited', inviter, { type: 'invitation', id: invitation.id, name: invitation.email });
        },
        afterUpdateMemberRole: async ({ organization, user, member, previousRole }) => {
          await record(organization.id, 'member.role.changed', user, { type: 'user', id: member.userId, name: user.email }, [
            { field: 'role', before: previousRole, after: member.role },
          ]);
        },
        afterRemoveMember: async ({ organization, user, member }) => {
          await record(organization.id, 'member.removed', user, { type: 'user', id: member.userId, name: user.email });
        },
      },
      async sendInvitationEmail(data) {
        const inviter = data.inviter.user;
        await sendOrganizationInvitation({
          email: data.email,
          workspace: data.organization.name,
          inviterName: inviter.name?.trim() || inviter.email,
          inviterEmail: inviter.email,
          role: data.role || 'member',
          url: `${env.APP_URL}/accept-invitation/${data.id}`,
          expiresAt: new Date(data.invitation.expiresAt),
        });
      },
    }),
  ],
});
export type AuthSession = typeof auth.$Infer.Session;
