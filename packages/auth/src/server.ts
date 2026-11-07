import { AsyncLocalStorage } from 'node:async_hooks';
import { SIGN_IN_CODE_TTL_SECONDS } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { clientIp, primaryRole } from '@logbird/email';
import { sendMemberJoined, sendOrganizationInvitation, sendRoleChanged, sendSignInCode } from '@logbird/email/send';
import { createEnv } from '@t3-oss/env-core';
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
export const authAuditContext = new AsyncLocalStorage<{
  actor?: AuditUser;
  requestId: string;
  ip: string;
  userAgent: string;
  path?: string;
  organizationBefore?: { id: string; name: string; slug: string };
}>();
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
const displayName = (user: { name?: string | null; email: string }) => user.name?.trim() || user.email;
/** Courtesy notifications must never fail the action that triggered them. */
async function notify(kind: string, send: () => Promise<unknown>) {
  try {
    await send();
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'email.failed', kind, message: error instanceof Error ? error.message : String(error) }));
  }
}
export const auth = betterAuth({
  baseURL: env.APP_URL,
  // The API boundary enforces shared Redis limits across replicas.
  rateLimit: { enabled: false },
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.APP_URL, ...env.TRUSTED_ORIGINS.split(',').filter(Boolean)],
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  advanced: {
    cookiePrefix: 'logbird',
    useSecureCookies: new URL(env.APP_URL).protocol === 'https:',
    defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
  },
  databaseHooks: {
    session: {
      create: {
        after: async (session) => {
          const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
          for (const member of await prisma.member.findMany({ where: { userId: user.id } }))
            await record(member.organizationId, 'auth.signed_in', user, { type: 'user', id: user.id, name: user.email });
        },
      },
      delete: {
        after: async (session) => {
          const user = await prisma.user.findUnique({ where: { id: session.userId } });
          if (!user) return;
          const action = authAuditContext.getStore()?.path === '/api/auth/sign-out' ? 'auth.signed_out' : 'auth.session.revoked';
          for (const member of await prisma.member.findMany({ where: { userId: user.id } }))
            await record(member.organizationId, action, user, { type: 'session', id: session.id });
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
      async sendVerificationOTP({ email, otp, type }, ctx) {
        // Device / IP hints help the recipient spot a request that was not theirs.
        const request = authAuditContext.getStore();
        await sendSignInCode({
          email,
          code: otp,
          purpose: type,
          expiresInMinutes: SIGN_IN_CODE_TTL_SECONDS / 60,
          requestedAt: new Date(),
          userAgent: request?.userAgent || ctx?.headers?.get('user-agent') || undefined,
          // Already resolved by the server from the trusted proxy hop or the socket peer; never a raw header.
          ip: clientIp(request?.ip),
        });
      },
    }),
    organization({
      organizationHooks: {
        afterCreateOrganization: async ({ organization, user }) => {
          await record(organization.id, 'organization.created', user, { type: 'organization', id: organization.id, name: organization.name });
        },
        beforeUpdateOrganization: async ({ member }) => {
          const context = authAuditContext.getStore();
          if (context)
            context.organizationBefore = await prisma.organization.findUniqueOrThrow({
              where: { id: member.organizationId },
              select: { id: true, name: true, slug: true },
            });
        },
        afterUpdateOrganization: async ({ organization, user }) => {
          const before = authAuditContext.getStore()?.organizationBefore;
          if (!organization || before?.id !== organization.id) return;
          const changes = (['name', 'slug'] as const)
            .filter((field) => before[field] !== organization[field])
            .map((field) => ({ field, before: before[field], after: organization[field] }));
          if (changes.length)
            await record(
              organization.id,
              'organization.updated',
              user,
              { type: 'organization', id: organization.id, name: organization.name },
              changes,
            );
        },
        afterCreateInvitation: async ({ organization, inviter, invitation }) => {
          await record(organization.id, 'member.invited', inviter, { type: 'invitation', id: invitation.id, name: invitation.email });
        },
        afterUpdateMemberRole: async ({ organization, user, member, previousRole }) => {
          await record(organization.id, 'member.role.changed', user, { type: 'user', id: member.userId, name: user.email }, [
            { field: 'role', before: previousRole, after: member.role },
          ]);
          // `user` is the member whose role changed; the person who changed it is the session user.
          const changedBy = authAuditContext.getStore()?.actor;
          if (!changedBy || changedBy.id === member.userId || previousRole === member.role) return;
          await notify('role-changed', () =>
            sendRoleChanged({
              email: user.email,
              workspace: organization.name,
              previousRole: primaryRole(previousRole),
              role: primaryRole(member.role),
              changedByName: displayName(changedBy),
              changedByEmail: changedBy.email,
              changedAt: new Date(),
            }),
          );
        },
        afterRejectInvitation: async ({ organization, invitation, user }) => {
          await record(organization.id, 'member.invitation.rejected', user, { type: 'invitation', id: invitation.id, name: invitation.email });
        },
        afterCancelInvitation: async ({ organization, invitation, cancelledBy }) => {
          await record(organization.id, 'member.invitation.canceled', cancelledBy, { type: 'invitation', id: invitation.id, name: invitation.email });
        },
        afterAcceptInvitation: async ({ organization, invitation, member, user }) => {
          await record(organization.id, 'member.invitation.accepted', user, { type: 'invitation', id: invitation.id, name: invitation.email });
          if (!invitation.inviterId || invitation.inviterId === user.id) return;
          await notify('member-joined', async () => {
            const inviter = await prisma.user.findUnique({ where: { id: invitation.inviterId }, select: { email: true } });
            if (!inviter) return;
            await sendMemberJoined({
              inviterEmail: inviter.email,
              workspace: organization.name,
              memberName: displayName(user),
              memberEmail: user.email,
              role: primaryRole(member.role),
              joinedAt: new Date(),
            });
          });
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
          inviterName: displayName(inviter),
          inviterEmail: inviter.email,
          role: primaryRole(data.role),
          url: `${env.APP_URL}/accept-invitation/${data.id}`,
          expiresAt: new Date(data.invitation.expiresAt),
          sentAt: new Date(),
        });
      },
    }),
  ],
});
export type AuthSession = typeof auth.$Infer.Session;
