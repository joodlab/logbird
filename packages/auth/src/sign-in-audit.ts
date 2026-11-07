import { auditNamespace, authEmailHash, freezeAuditEvent, prisma, type Session } from '@logbird/database';

type RequestContext = { requestId: string; ip: string; userAgent: string };
type AuditSession = Pick<Session, 'id' | 'userId' | 'createdAt' | 'expiresAt'> & Partial<Pick<Session, 'ipAddress' | 'userAgent'>>;

async function sessionRows(session: AuditSession, context?: RequestContext) {
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) return [];
  const members = await prisma.member.findMany({ where: { userId: user.id }, select: { organizationId: true } });
  return members.map(({ organizationId }) => ({
    ...freezeAuditEvent({
      id: `auth:signin:${session.id}:${organizationId}:${auditNamespace()}`,
      action: 'auth.signed_in',
      actor: { type: 'user', id: user.id, name: user.name || user.email },
      targets: [{ type: 'user', id: user.id, name: user.name || user.email }],
      executor: { type: 'api', id: 'api-server' },
      occurredAt: session.createdAt.toISOString(),
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
  }));
}

export async function recordSessionSignIn(session: AuditSession, secret: string, context?: RequestContext) {
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { email: true } });
  if (user) await prisma.user.update({ where: { id: session.userId }, data: { emailHash: authEmailHash(user.email, secret) } });
  await prisma.auditOutbox.createMany({ data: await sessionRows(session, context), skipDuplicates: true });
}
