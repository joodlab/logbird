import { AsyncLocalStorage } from 'node:async_hooks';
import { createEnv } from '@t3-oss/env-core';
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
  target: { type: string; id: string };
  changes?: unknown[];
  context?: { requestId: string; ip: string; userAgent: string };
};
export const authAuditContext = new AsyncLocalStorage<{ actor?: AuditUser; requestId: string; ip: string; userAgent: string }>();
let auditHandler: ((event: AuthAudit) => Promise<unknown>) | undefined;
export const setAuthAuditHandler = (handler: NonNullable<typeof auditHandler>) => {
  auditHandler = handler;
};
function record(organizationId: string, action: string, fallback: AuditUser, target: { type: string; id: string }, changes?: unknown[]) {
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
const env = createEnv({ server: { APP_URL: z.url(), BETTER_AUTH_SECRET: z.string().min(32) }, runtimeEnv: process.env });
export const auth = betterAuth({
  baseURL: env.APP_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.APP_URL],
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  advanced: { useSecureCookies: new URL(env.APP_URL).protocol === 'https:', defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' } },
  databaseHooks: {
    session: {
      create: {
        after: async (session) => {
          const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
          for (const member of await prisma.member.findMany({ where: { userId: user.id } }))
            await record(member.organizationId, 'auth.signed_in', user, { type: 'user', id: user.id });
        },
      },
    },
  },
  plugins: [
    emailOTP({
      otpLength: 6,
      storeOTP: 'hashed',
      expiresIn: 600,
      disableSignUp: false,
      async sendVerificationOTP({ email, otp }) {
        await sendSignInCode(email, otp);
      },
    }),
    organization({
      organizationHooks: {
        afterCreateOrganization: async ({ organization, user }) => {
          await record(organization.id, 'organization.created', user, { type: 'organization', id: organization.id });
        },
        afterCreateInvitation: async ({ organization, inviter, invitation }) => {
          await record(organization.id, 'member.invited', inviter, { type: 'invitation', id: invitation.id });
        },
        afterUpdateMemberRole: async ({ organization, user, member, previousRole }) => {
          await record(organization.id, 'member.role.changed', user, { type: 'user', id: member.userId }, [
            { field: 'role', before: previousRole, after: member.role },
          ]);
        },
        afterRemoveMember: async ({ organization, user, member }) => {
          await record(organization.id, 'member.removed', user, { type: 'user', id: member.userId });
        },
      },
      async sendInvitationEmail(data) {
        await sendOrganizationInvitation(data.email, data.organization.name, `${env.APP_URL}/accept-invitation/${data.id}`);
      },
    }),
  ],
});
export type AuthSession = typeof auth.$Infer.Session;
