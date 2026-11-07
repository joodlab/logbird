import { AsyncLocalStorage } from 'node:async_hooks';
import { SIGN_IN_CODE_TTL_SECONDS } from '@logbird/contracts';
import { prisma } from '@logbird/database';
import { clientIp, primaryRole } from '@logbird/email';
import { sendMemberJoined, sendOrganizationInvitation, sendRoleChanged, sendSignInCode } from '@logbird/email/send';
import { createEnv } from '@t3-oss/env-core';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError, createAuthEndpoint, originCheckMiddleware } from 'better-auth/api';
import { deleteSessionCookie } from 'better-auth/cookies';
import { emailOTP, organization } from 'better-auth/plugins';
import { z } from 'zod';
import { recordSessionSignIn } from './sign-in-audit';

type AuditUser = { id: string; name: string; email: string };
type AuthAudit = {
  organizationId: string;
  action: string;
  actor: AuditUser;
  target: { type: string; id: string; name?: string };
  changes?: unknown[];
  description?: string;
  context?: { requestId: string; ip: string; userAgent: string };
};
export const authAuditContext = new AsyncLocalStorage<{
  actor?: AuditUser;
  requestId: string;
  ip: string;
  userAgent: string;
  path?: string;
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
  description?: string,
) {
  const context = authAuditContext.getStore();
  return auditHandler?.({
    organizationId,
    action,
    actor: action === 'auth.signed_in' ? fallback : (context?.actor ?? fallback),
    target,
    changes,
    description,
    context,
  }).catch(() => console.error(JSON.stringify({ event: 'auth.audit_storage_unavailable', action })));
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
  // Session ends belong to Logbird's atomic deletion/outbox routes. Keep the library router closed too.
  disabledPaths: ['/sign-out', '/revoke-session', '/revoke-sessions', '/revoke-other-sessions'],
  // The API boundary enforces shared Redis limits across replicas.
  rateLimit: { enabled: false },
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.APP_URL, ...env.TRUSTED_ORIGINS.split(',').filter(Boolean)],
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  advanced: {
    // Keep cookie request validation enabled in tests as well as production.
    disableOriginCheck: false,
    disableCSRFCheck: false,
    cookiePrefix: 'logbird',
    useSecureCookies: new URL(env.APP_URL).protocol === 'https:',
    defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
  },
  databaseHooks: {
    session: {
      create: {
        after: async (session) => {
          try {
            await recordSessionSignIn(session, env.BETTER_AUTH_SECRET, authAuditContext.getStore());
          } catch {
            console.error(JSON.stringify({ event: 'auth.audit_storage_unavailable', action: 'auth.signed_in' }));
          }
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
        beforeUpdateOrganization: async ({ organization: input }) => {
          if (input.name !== undefined || input.slug !== undefined)
            throw new APIError('FORBIDDEN', { message: 'Use PATCH /api/workspace to change the workspace name or URL slug.' });
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

// Called locally only; this endpoint is not registered on better-auth's HTTP router.
const expireSessionCookies = createAuthEndpoint('/internal-cookie-expiry', { method: 'POST' }, async (ctx) => {
  deleteSessionCookie(ctx);
  return ctx.json({ success: true });
});
export async function clearSessionCookies(headers: Headers) {
  const response = await expireSessionCookies({ headers, context: await auth.$context, asResponse: true });
  return response.headers.getSetCookie();
}

const validateCookieOrigin = createAuthEndpoint('/internal-origin-check', { method: 'POST', use: [originCheckMiddleware] }, async (ctx) =>
  ctx.json({ success: true }),
);
/** The same Origin/Referer matcher and cookie CSRF check as better-auth's HTTP router. */
export async function trustedSessionMutation(request: Request) {
  const source = request.headers.get('origin') || request.headers.get('referer');
  if (!source || source === 'null' || request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const headers = new Headers(request.headers);
  // These routes authenticate only with cookies; force the library's cookie branch even for an anonymous request.
  if (!headers.has('cookie')) headers.set('cookie', '');
  try {
    const response = await validateCookieOrigin({
      request: new Request(request.url, { method: 'POST', headers }),
      headers,
      context: await auth.$context,
      asResponse: true,
    });
    return response.ok;
  } catch (error) {
    if (error instanceof APIError && error.status === 'FORBIDDEN') return false;
    throw error;
  }
}
