import { auditNamespace, authEmailHash, freezeAuditEvent, prisma, type Session } from '@logbird/database';
import { APIError } from 'better-auth/api';

type RequestContext = { actor?: { id: string; name: string; email: string }; path?: string; requestId: string; ip: string; userAgent: string };
type AuditSession = Pick<Session, 'id' | 'userId' | 'createdAt' | 'expiresAt'> & Partial<Pick<Session, 'ipAddress' | 'userAgent'>>;
const explicitEnds = ['/api/auth/sign-out', '/api/auth/revoke-session', '/api/auth/revoke-sessions', '/api/auth/revoke-other-sessions'];

async function sessionRows(session: AuditSession, action: string, context?: RequestContext) {
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) return [];
  const members = await prisma.member.findMany({ where: { userId: user.id }, select: { organizationId: true } });
  const actor = action === 'auth.signed_in' ? user : (context?.actor ?? user);
  return members.map(({ organizationId }) => ({
    ...freezeAuditEvent({
      id: `auth:${action === 'auth.signed_in' ? 'signin' : 'end'}:${session.id}:${organizationId}:${auditNamespace()}`,
      action,
      actor: { type: 'user', id: actor.id, name: actor.name || actor.email },
      targets: [action === 'auth.signed_in' ? { type: 'user', id: user.id, name: user.name || user.email } : { type: 'session', id: session.id }],
      executor: { type: 'api', id: 'api-server' },
      occurredAt: action === 'auth.signed_in' ? session.createdAt.toISOString() : new Date().toISOString(),
      context: context ? { requestId: context.requestId, ip: context.ip, userAgent: context.userAgent } : undefined,
      metadata: {
        session: {
          createdAt: session.createdAt.toISOString(),
          expiresAt: session.expiresAt.toISOString(),
          ipAddress: session.ipAddress ?? null,
          userAgent: session.userAgent ?? null,
        },
      },
    }),
    stream: `ws:${organizationId}`,
    namespace: auditNamespace(),
    sourceSessionId: session.id,
  }));
}

/** A failing before-hook prevents deletion. A crash after deletion leaves a recoverable intent. */
export async function stageSessionEnd(session: AuditSession, context?: RequestContext): Promise<void> {
  if (session.expiresAt <= new Date() || !context?.path || !explicitEnds.includes(context.path)) return;
  const rows = await sessionRows(session, context.path === explicitEnds[0] ? 'auth.signed_out' : 'auth.session.revoked', context);
  if (!rows.length) return;
  return prisma.$transaction(async (tx) => {
    // Serialize before-hooks briefly on the source row, without holding a lock through better-auth's deletion.
    const source = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM session WHERE id=${session.id} FOR UPDATE`;
    if (!source.length) return;
    for (const row of rows) {
      const existing = await tx.auditOutbox.findUnique({ where: { id: row.id } });
      if (!existing) await tx.auditOutbox.create({ data: { ...row, confirmedAt: null } });
      else if (!existing.confirmedAt && existing.attempts === 0 && existing.lastError === 'not_committed') {
        // A new explicit action may reuse a proved-aborted intent. It has never been eligible for delivery.
        await tx.auditOutbox.update({
          where: { id: row.id },
          data: {
            payload: row.payload,
            createdAt: new Date(),
            nextAttemptAt: new Date(),
            quarantinedAt: null,
            lastError: null,
          },
        });
      } else throw new APIError('SERVICE_UNAVAILABLE', { message: 'This session is already being ended. Retry shortly.' });
    }
  });
}
export async function confirmSessionEnd(session: Pick<Session, 'id'>, context?: RequestContext) {
  if (!context?.path || !explicitEnds.includes(context.path)) return;
  await prisma.auditOutbox.updateMany({
    where: {
      namespace: auditNamespace(),
      sourceSessionId: session.id,
      confirmedAt: null,
      OR: [{ quarantinedAt: null }, { lastError: 'not_committed' }],
      payload: { path: ['context', 'requestId'], equals: context.requestId },
    },
    data: { confirmedAt: new Date(), quarantinedAt: null, lastError: null },
  });
}
export async function recordSessionSignIn(session: AuditSession, secret: string, context?: RequestContext) {
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { email: true } });
  if (user) await prisma.user.update({ where: { id: session.userId }, data: { emailHash: authEmailHash(user.email, secret) } });
  await prisma.auditOutbox.createMany({ data: await sessionRows(session, 'auth.signed_in', context), skipDuplicates: true });
}

/** Short, bounded reconciliation. Session ids are never reused; payloads are never reconstructed for end intents. */
export async function reconcileSessionAudit(now = new Date()) {
  const intents = await prisma.auditOutbox.findMany({
    where: {
      namespace: auditNamespace(),
      confirmedAt: null,
      quarantinedAt: null,
      sourceSessionId: { not: null },
      createdAt: { lt: new Date(+now - 60_000) },
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  for (const row of intents) {
    if (!row.sourceSessionId) continue;
    const exists = await prisma.session.findUnique({ where: { id: row.sourceSessionId }, select: { id: true } });
    const expiry = (row.payload as { metadata?: { session?: { expiresAt?: string } } }).metadata?.session?.expiresAt;
    // Missing after expiry could be implicit getSession cleanup, not the earlier explicit request.
    const ambiguous = !exists && (!expiry || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= +now);
    await prisma.auditOutbox.updateMany({
      where: { id: row.id, createdAt: row.createdAt, confirmedAt: null, quarantinedAt: null },
      data: exists || ambiguous ? { quarantinedAt: now, lastError: exists ? 'not_committed' : 'expired_session_intent' } : { confirmedAt: now },
    });
  }
}
