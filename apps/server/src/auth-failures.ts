import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { auditNamespace, type Prisma, prisma, storeAuditEvent } from '@logbird/database';

const WINDOW_MS = 300_000;
const HOUR_MS = 3_600_000;
export const AUTH_AUDIT_GLOBAL_LIMIT = 600;
export const AUTH_AUDIT_WORKSPACE_LIMIT = 60;
const key = (secret: string, purpose: string) => createHmac('sha256', secret).update(`logbird/auth-audit/${purpose}/v1`).digest();
export const authEmailHash = (email: string, secret: string) =>
  createHmac('sha256', key(secret, 'hash')).update(email.trim().toLowerCase()).digest('hex');
function seal(email: string, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret, 'lookup'), iv);
  const encrypted = Buffer.concat([cipher.update(email, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
function unseal(identity: string, secret: string) {
  const data = Buffer.from(identity, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(secret, 'lookup'), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}

/** Same short durable path for every identity. No membership lookup or ClickHouse I/O in the request. */
export async function stageFailedSignIn(email: string, reason: string, context: Prisma.InputJsonObject, secret: string, now = new Date()) {
  const normalized = email.trim().toLowerCase();
  const emailHash = authEmailHash(normalized, secret);
  const end = new Date((Math.floor(now.getTime() / WINDOW_MS) + 1) * WINDOW_MS);
  const id = `${emailHash}:${reason}:${end.getTime()}:${auditNamespace()}`;
  const globalId = `${auditNamespace()}:global:${Math.floor(now.getTime() / HOUR_MS)}`;
  await prisma.$transaction(async (tx) => {
    // One brief transaction lock also bounds concurrent fresh-identity admission across replicas.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${globalId}, 2))`;
    const existing = await tx.authAuditWindow.findUnique({ where: { id } });
    if (existing) {
      await tx.authAuditWindow.update({ where: { id }, data: { attempts: { increment: 1 } } });
      return;
    }
    const budget = await tx.authAuditBudget.upsert({
      where: { id: globalId },
      create: { id: globalId, namespace: auditNamespace(), windowEnd: new Date((Math.floor(now.getTime() / HOUR_MS) + 1) * HOUR_MS) },
      update: {},
    });
    if (budget.admitted >= AUTH_AUDIT_GLOBAL_LIMIT) {
      await tx.authAuditBudget.update({ where: { id: globalId }, data: { suppressed: { increment: 1 } } });
      return;
    }
    await tx.authAuditBudget.update({ where: { id: globalId }, data: { admitted: { increment: 1 } } });
    await tx.authAuditWindow.create({
      data: { id, namespace: auditNamespace(), identity: seal(normalized, secret), reason, context, windowEnd: end, nextAttemptAt: now },
    });
  });
}

/** First receipt immediately, then one counted summary when the window closes. Outbox fan-out is atomic. */
export async function flushFailedSignIns(secret: string, now = new Date(), ids?: string[]) {
  const windows = await prisma.authAuditWindow.findMany({
    where: { namespace: auditNamespace(), nextAttemptAt: { lte: now }, ...(ids ? { id: { in: ids } } : {}) },
    take: 100,
    orderBy: { nextAttemptAt: 'asc' },
  });
  for (const window of windows) {
    const user = await prisma.user.findUnique({ where: { email: unseal(window.identity, secret) }, select: { id: true, name: true } });
    if (user && (!user.name || user.name.includes('@'))) user.name = 'Member';
    const members = user ? await prisma.member.findMany({ where: { userId: user.id }, select: { organizationId: true } }) : [];
    await prisma.$transaction(async (tx) => {
      // Concurrent sweepers cannot expand a window twice, nor lose increments racing a summary.
      await tx.$queryRaw`SELECT "id" FROM "AuthAuditWindow" WHERE "id"=${window.id} FOR UPDATE`;
      const current = await tx.authAuditWindow.findUniqueOrThrow({ where: { id: window.id } });
      if (current.nextAttemptAt > now) return;
      const first = current.flushedAttempts === 0;
      const count = first ? 1 : current.attempts - current.flushedAttempts;
      for (const member of members) {
        if (!count || !user) continue;
        const stream = `ws:${member.organizationId}`;
        const budgetId = `${stream}:${Math.floor(now.getTime() / HOUR_MS)}`;
        const budget = await tx.authAuditBudget.upsert({
          where: { id: budgetId },
          create: { id: budgetId, namespace: auditNamespace(), stream, windowEnd: new Date((Math.floor(now.getTime() / HOUR_MS) + 1) * HOUR_MS) },
          update: {},
        });
        const admitted = await tx.authAuditBudget.updateMany({
          where: { id: budgetId, admitted: { lt: AUTH_AUDIT_WORKSPACE_LIMIT } },
          data: { admitted: { increment: 1 } },
        });
        if (!admitted.count) {
          await tx.authAuditBudget.update({ where: { id: budget.id }, data: { suppressed: { increment: count } } });
          continue;
        }
        await storeAuditEvent(
          stream,
          {
            id: `auth-${current.id}-${first ? 'first' : 'summary'}-${member.organizationId}`,
            action: 'auth.sign_in.failed',
            outcome: 'failure',
            severity: 'warning',
            actor: { type: 'anonymous', name: 'Unverified sign-in' },
            targets: [{ type: 'user', id: user.id, name: user.name }],
            description: first
              ? `Failed sign-in to ${user.name || 'a member'}'s account (${current.reason})`
              : `${count} further failed sign-in attempts in the window for ${user.name || 'a member'} (${current.reason})`,
            executor: { type: 'api', id: 'api-server' },
            context: current.context,
            metadata: {
              emailHash: current.id.split(':')[0],
              hashVersion: 1,
              reason: current.reason,
              attempts: count,
              windowEnd: current.windowEnd.toISOString(),
              auditWindowSeconds: 300,
            },
          },
          tx,
        );
      }
      await tx.authAuditWindow.update({
        where: { id: current.id },
        data: {
          flushedAttempts: first ? 1 : current.attempts,
          nextAttemptAt: first ? current.windowEnd : new Date('9999-01-01T00:00:00Z'),
          // Erase the encrypted lookup identity after the final fan-out.
          ...(!first ? { identity: '' } : {}),
        },
      });
    });
  }
  if (!ids) await flushAuthAuditBudgets(now);
}

export async function flushAuthAuditBudgets(now = new Date(), ids?: string[]) {
  const budgets = await prisma.authAuditBudget.findMany({
    where: { namespace: auditNamespace(), reported: false, windowEnd: { lte: now }, ...(ids ? { id: { in: ids } } : {}) },
    take: 100,
  });
  for (const budget of budgets)
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.authAuditBudget.updateManyAndReturn({ where: { id: budget.id, reported: false }, data: { reported: true } });
      const current = claimed[0];
      if (!current?.suppressed) return;
      if (budget.stream)
        await storeAuditEvent(
          budget.stream,
          {
            id: `auth-suppression-${budget.id}`,
            action: 'auth.sign_in.suppressed',
            outcome: 'failure',
            severity: 'warning',
            actor: { type: 'system', id: 'auth-audit-budget' },
            description: `${current.suppressed} further failed sign-in attempts suppressed in the hour`,
            metadata: { attempts: current.suppressed, windowEnd: budget.windowEnd.toISOString() },
          },
          tx,
        );
      else console.warn(JSON.stringify({ event: 'auth.audit.suppressed', attempts: current.suppressed, windowEnd: budget.windowEnd }));
    });
}
