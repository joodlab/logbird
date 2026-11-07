import { clearSessionCookies, trustedSessionMutation } from '@logbird/auth';
import { revokeSessionSchema, sessionActionResponseSchema } from '@logbird/contracts';
import { Prisma, prisma, type Session } from '@logbird/database';
import { type Context, Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { validator } from 'hono-openapi';
import { ApiError } from './errors';
import { audit } from './ingest';
import { doc } from './openapi';
import type { AppEnv } from './types';

type EndMode = 'sign-out' | 'revoke' | 'revoke-all' | 'revoke-others';
// Run before requireSession: even the library's implicit session refresh must follow origin validation.
export const sessionMutationOrigin = createMiddleware<AppEnv>(async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !(await trustedSessionMutation(c.req.raw)))
    throw new ApiError(403, 'forbidden', 'Use a trusted Logbird Origin or Referer.');
  await next();
});

async function endSessions(c: Context<AppEnv>, mode: EndMode, sessionId?: string) {
  const actor = c.get('user');
  const currentId = c.get('session').id;
  const clearsCookie = mode === 'sign-out' || mode === 'revoke-all' || (mode === 'revoke' && sessionId === currentId);
  // Prepare native better-auth expiry headers before the commit; no client is closed or state changed here.
  const cookies = clearsCookie ? await clearSessionCookies(c.req.raw.headers) : [];
  const revoked = await prisma.$transaction(async (tx) => {
    const selection =
      mode === 'sign-out'
        ? Prisma.sql`AND id=${currentId}`
        : mode === 'revoke'
          ? Prisma.sql`AND id=${sessionId}`
          : mode === 'revoke-others'
            ? Prisma.sql`AND id<>${currentId}`
            : Prisma.empty;
    const sessions = await tx.$queryRaw<Pick<Session, 'id' | 'createdAt' | 'expiresAt' | 'ipAddress' | 'userAgent'>[]>(Prisma.sql`
      SELECT id, "createdAt", "expiresAt", "ipAddress", "userAgent" FROM session WHERE "userId"=${actor.id} AND "expiresAt">${new Date()}
      ${selection} ORDER BY id FOR UPDATE`);
    if (mode === 'revoke' && !sessions.length) throw new ApiError(404, 'not_found', 'Session not found.');
    // An overlapping sign-in is intentionally outside this snapshot. Never widen deletion to userId.
    const ids = sessions.map((session) => session.id);
    if (!ids.length) return 0;
    await tx.session.deleteMany({ where: { id: { in: ids }, userId: actor.id } });
    const members = await tx.member.findMany({ where: { userId: actor.id }, select: { organizationId: true } });
    for (const session of sessions)
      for (const member of members)
        await audit(
          c,
          mode === 'sign-out' ? 'auth.signed_out' : 'auth.session.revoked',
          { type: 'session', id: session.id },
          undefined,
          {
            organizationId: member.organizationId,
            description: `${mode === 'sign-out' ? 'Signed out on' : 'Revoked'} the session from ${session.ipAddress || 'an unknown address'} (${session.userAgent || 'unknown device'}), signed in ${session.createdAt.toISOString()}`,
            metadata: {
              session: {
                createdAt: session.createdAt.toISOString(),
                expiresAt: session.expiresAt.toISOString(),
                ipAddress: session.ipAddress,
                userAgent: session.userAgent,
              },
            },
          },
          tx,
        );
    return sessions.length;
  });
  for (const cookie of cookies) c.header('Set-Cookie', cookie, { append: true });
  return c.json({ success: true as const, revoked });
}

// The global mutation middleware requires a session, but no active workspace or membership role.
export const sessionRoutes = new Hono<AppEnv>()
  .post('/session/sign-out', doc('Sign out the current session', sessionActionResponseSchema), (c) => endSessions(c, 'sign-out'))
  .post('/sessions/revoke', doc('Revoke one of your sessions', sessionActionResponseSchema), validator('json', revokeSessionSchema), (c) =>
    endSessions(c, 'revoke', c.req.valid('json').sessionId),
  )
  .post('/sessions/revoke-all', doc('Revoke all your selected sessions', sessionActionResponseSchema), (c) => endSessions(c, 'revoke-all'))
  .post('/sessions/revoke-others', doc('Revoke your other selected sessions', sessionActionResponseSchema), (c) => endSessions(c, 'revoke-others'));
