import { auditNamespace, authEmailHash, freezeAuditEvent, prisma, type Session } from '@logbird/database';

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
        session: { createdAt: session.createdAt.toISOString(), ipAddress: session.ipAddress ?? null, userAgent: session.userAgent ?? null },
      },
    }),
    stream: `ws:${organizationId}`,
    namespace: auditNamespace(),
    sourceSessionId: session.id,
  }));
}

/** A failing before-hook prevents deletion. A crash after deletion leaves a recoverable intent. */
export async function stageSessionEnd(session: AuditSession, context?: RequestContext) {
  if (session.expiresAt <= new Date() || !context?.path || !explicitEnds.includes(context.path)) return;
  const rows = await sessionRows(session, context.path === explicitEnds[0] ? 'auth.signed_out' : 'auth.session.revoked', context);
  await prisma.auditOutbox.createMany({ data: rows.map((row) => ({ ...row, confirmedAt: null })), skipDuplicates: true });
}
export async function confirmSessionEnd(session: Pick<Session, 'id'>) {
  await prisma.auditOutbox.updateMany({
    where: { namespace: auditNamespace(), sourceSessionId: session.id, confirmedAt: null, quarantinedAt: null },
    data: { confirmedAt: new Date() },
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
    await prisma.auditOutbox.updateMany({
      where: { id: row.id, confirmedAt: null, quarantinedAt: null },
      data: exists ? { quarantinedAt: now, lastError: 'not_committed' } : { confirmedAt: now },
    });
  }
}
