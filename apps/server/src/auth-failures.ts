import { type AuthAuditWindow, auditNamespace, authEmailHash, type Prisma, prisma, storeAuditEvent } from '@logbird/database';

export { authEmailHash } from '@logbird/database';

const WINDOW_MS = 300_000,
  HOUR_MS = 3_600_000;
export const AUTH_AUDIT_GLOBAL_LIMIT = 600;
export const AUTH_AUDIT_WORKSPACE_LIMIT = 60;
const reasons: Record<string, string> = {
  invalid_otp: 'wrong code',
  expired_otp: 'expired code',
  locked_out: 'locked after too many wrong codes',
  global_overflow: 'global audit admission limit',
};
const hourEnd = (now: Date) => new Date((Math.floor(+now / HOUR_MS) + 1) * HOUR_MS);
const budgetId = (stream: string, end: Date) => `${auditNamespace()}:${stream}:${+end - HOUR_MS}`;

async function insertWindow(
  tx: Prisma.TransactionClient,
  emailHash: string,
  reason: string,
  context: Prisma.InputJsonObject,
  initialEnd: Date,
  initialTime: Date,
  overflow = false,
) {
  let end = initialEnd,
    now = initialTime;
  const ip = typeof context.ip === 'string' ? context.ip : '';
  const duration = overflow ? HOUR_MS : WINDOW_MS;
  for (;;) {
    if (+end <= Date.now()) {
      now = new Date();
      end = new Date((Math.floor(+now / duration) + 1) * duration);
    }
    const id = `${emailHash}:${overflow ? 'overflow' : reason}:${+end}:${auditNamespace()}`;
    const rows = await tx.$queryRaw<{ id: string }[]>`INSERT INTO "AuthAuditWindow"
    (id, namespace, identity, "emailHash", reason, context, "lastContext", "windowEnd", "nextAttemptAt", "firstAttemptAt", "lastAttemptAt", "distinctIps", overflow)
    VALUES (${id}, ${auditNamespace()}, '', ${emailHash}, ${reason}, ${JSON.stringify(context)}::jsonb, ${JSON.stringify(context)}::jsonb,
      ${end}, ${now}, ${now}, ${now}, array_remove(ARRAY[${ip}]::text[], ''), ${overflow}) ON CONFLICT (id) DO NOTHING RETURNING id`;
    if (rows.length) return { fresh: true, id, at: now };
    const locked = await tx.$queryRaw<{ closedAt: Date | null }[]>`SELECT "closedAt" FROM "AuthAuditWindow" WHERE id=${id} FOR UPDATE`;
    if (!locked.length) continue; // Retention removed an old generation before we obtained its lock.
    if (locked[0]?.closedAt) {
      now = new Date();
      end = new Date(Math.max(+end + duration, (Math.floor(+now / duration) + 1) * duration));
      continue;
    }
    await tx.$executeRaw`UPDATE "AuthAuditWindow" SET attempts=attempts+1,
    context=CASE WHEN ${now}<"firstAttemptAt" THEN ${JSON.stringify(context)}::jsonb ELSE context END,
    "lastContext"=CASE WHEN ${now}>="lastAttemptAt" THEN ${JSON.stringify(context)}::jsonb ELSE "lastContext" END,
    "firstAttemptAt"=LEAST("firstAttemptAt",${now}), "lastAttemptAt"=GREATEST("lastAttemptAt",${now}),
    "ipsTruncated"="ipsTruncated" OR (${ip}<>'' AND NOT (${ip}=ANY("distinctIps")) AND cardinality("distinctIps")>=10),
    "distinctIps"=CASE WHEN ${ip}<>'' AND NOT (${ip}=ANY("distinctIps")) AND cardinality("distinctIps")<10 THEN array_append("distinctIps", ${ip}) ELSE "distinctIps" END
    WHERE id=${id}`;
    return { fresh: false, id, at: now };
  }
}

/** Same hash-only durable path for every identity; no membership lookup, AES or advisory lock in the request. */
export async function stageFailedSignIn(email: string, reason: string, context: Prisma.InputJsonObject, secret: string, now = new Date()) {
  const hash = authEmailHash(email, secret),
    end = new Date((Math.floor(+now / WINDOW_MS) + 1) * WINDOW_MS);
  await prisma.$transaction(async (tx) => {
    const window = await insertWindow(tx, hash, reason, context, end, now);
    if (!window.fresh) return;
    const admittedAt = window.at;
    const globalId = `${auditNamespace()}:global:${Math.floor(+admittedAt / HOUR_MS)}`;
    await tx.authAuditBudget.upsert({
      where: { id: globalId },
      create: { id: globalId, namespace: auditNamespace(), windowEnd: hourEnd(admittedAt) },
      update: {},
    });
    const admitted = await tx.authAuditBudget.updateMany({
      where: { id: globalId, admitted: { lt: AUTH_AUDIT_GLOBAL_LIMIT } },
      data: { admitted: { increment: 1 } },
    });
    if (admitted.count) return;
    const budget = await tx.authAuditBudget.update({ where: { id: globalId }, data: { suppressed: { increment: 1 } } });
    if (budget.suppressed === 1)
      console.warn(JSON.stringify({ event: 'global_suppression_started', namespace: auditNamespace(), windowEnd: budget.windowEnd }));
    // Fresh sprays cannot consume the member evidence budget: preserve a hash-only counter per identity/hour.
    await insertWindow(tx, hash, 'global_overflow', context, hourEnd(admittedAt), admittedAt, true);
    await tx.authAuditWindow.delete({ where: { id: window.id } });
  });
}

/** Nullable indexed hashes are backfilled in small batches; successful sign-ins also refresh their own hash. */
export async function backfillAuthEmailHashes(secret: string) {
  const users = await prisma.user.findMany({ where: { emailHash: null }, take: 100, select: { id: true, email: true } });
  for (const user of users)
    await prisma.user.updateMany({ where: { id: user.id, emailHash: null }, data: { emailHash: authEmailHash(user.email, secret) } });
}
function windowMetadata(current: AuthAuditWindow) {
  // A multi-request summary has no single IP, user-agent, trace or request id.
  return {
    distinctIps: current.distinctIps,
    ipsTruncated: current.ipsTruncated,
    firstAttemptAt: current.firstAttemptAt.toISOString(),
    lastAttemptAt: current.lastAttemptAt.toISOString(),
  };
}
async function expandWindow(window: AuthAuditWindow, now: Date) {
  if (!window.emailHash) throw Object.assign(new Error('Legacy identity requires operator recovery'), { code: 'legacy_identity_unresolved' });
  const user = await prisma.user.findFirst({ where: { emailHash: window.emailHash }, select: { id: true, name: true, email: true } });
  // Avoid silently closing a window while the initial existing-user hash backfill is incomplete.
  if (!user && (await prisma.user.findFirst({ where: { emailHash: null }, select: { id: true } })))
    throw Object.assign(new Error('Hash backfill pending'), { code: 'hash_backfill_pending' });
  const members = user ? await prisma.member.findMany({ where: { userId: user.id }, select: { organizationId: true } }) : [];
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "AuthAuditWindow" WHERE id=${window.id} FOR UPDATE`;
    const current = await tx.authAuditWindow.findUniqueOrThrow({ where: { id: window.id } });
    if (current.nextAttemptAt > now || current.quarantinedAt || current.closedAt) return;
    const first = current.flushedAttempts === 0;
    const count = first ? 1 : current.attempts - current.flushedAttempts;
    const occurrence = first ? current.firstAttemptAt : current.lastAttemptAt;
    for (const member of members) {
      if (!count || !user) continue;
      const stream = `ws:${member.organizationId}`,
        id = budgetId(stream, hourEnd(occurrence));
      await tx.authAuditBudget.upsert({
        where: { id },
        create: { id, namespace: auditNamespace(), stream, windowEnd: hourEnd(occurrence) },
        update: {},
      });
      // This atomic update locks only the destination's budget, never a global request-path lock.
      const admitted = await tx.authAuditBudget.updateMany({
        where: { id, admitted: { lt: AUTH_AUDIT_WORKSPACE_LIMIT } },
        data: { admitted: { increment: 1 } },
      });
      if (!admitted.count) {
        const budget = await tx.authAuditBudget.update({ where: { id }, data: { suppressed: { increment: count }, reported: false } });
        const targets = budget.targets as Record<string, number>;
        targets[user.id] = (targets[user.id] ?? 0) + count;
        await tx.authAuditBudget.update({ where: { id }, data: { targets } });
        continue;
      }
      const name = user.name || user.email;
      const times = `${current.firstAttemptAt.toISOString().slice(11, 16)} and ${current.lastAttemptAt.toISOString().slice(11, 16)} UTC`;
      await storeAuditEvent(
        stream,
        {
          id: `auth-${current.id}-${first ? 'first' : 'summary'}-${member.organizationId}`,
          action: 'auth.sign_in.failed',
          outcome: 'failure',
          severity: 'warning',
          occurredAt: occurrence.toISOString(),
          actor: { type: 'anonymous', name: 'Unverified sign-in' },
          targets: [{ type: 'user', id: user.id, name }],
          executor: { type: 'api', id: 'api-server' },
          description: first
            ? `Failed sign-in to ${name}'s account (${reasons[current.reason] ?? 'sign-in rejected'})`
            : `${count} more failed sign-ins to ${name}'s account between ${times}`,
          context: first ? current.context : undefined,
          metadata: {
            emailHash: current.emailHash,
            hashVersion: 1,
            reason: current.reason,
            attempts: count,
            windowEnd: current.windowEnd.toISOString(),
            ...windowMetadata(current),
          },
        },
        tx,
      );
    }
    await tx.authAuditWindow.update({
      where: { id: current.id },
      data: {
        flushedAttempts: first ? 1 : current.attempts,
        prepareAttempts: 0,
        lastError: null,
        nextAttemptAt: first ? current.windowEnd : now,
        closedAt: !first ? now : null,
      },
    });
  });
}

/** Round-2 parked completed windows have no identity left and no counts awaiting expansion. */
export async function closeLegacyAuthWindows(now = new Date()) {
  return prisma.$executeRaw`UPDATE "AuthAuditWindow" SET "closedAt"=${now} WHERE id IN (
    SELECT id FROM "AuthAuditWindow" WHERE namespace=${auditNamespace()} AND "emailHash" IS NULL
    AND identity='' AND "closedAt" IS NULL AND "quarantinedAt" IS NULL AND attempts>0 AND "flushedAttempts"=attempts
    AND "nextAttemptAt">=TIMESTAMP '9999-01-01' ORDER BY "nextAttemptAt", id LIMIT 100 FOR UPDATE SKIP LOCKED)`;
}

export async function flushFailedSignIns(now = new Date(), ids?: string[]) {
  if (!ids) await closeLegacyAuthWindows(now);
  const windows = await prisma.authAuditWindow.findMany({
    where: { namespace: auditNamespace(), quarantinedAt: null, closedAt: null, nextAttemptAt: { lte: now }, ...(ids ? { id: { in: ids } } : {}) },
    take: 100,
    orderBy: { nextAttemptAt: 'asc' },
  });
  for (const window of windows) {
    try {
      await expandWindow(window, now);
    } catch (error) {
      const legacy = error && typeof error === 'object' && 'code' in error && error.code === 'legacy_identity_unresolved';
      const backfill = error && typeof error === 'object' && 'code' in error && error.code === 'hash_backfill_pending';
      const attempts = backfill ? window.prepareAttempts : window.prepareAttempts + 1;
      const code = legacy ? 'legacy_identity_unresolved' : backfill ? 'hash_backfill_pending' : 'audit_preparation_unavailable';
      await prisma.authAuditWindow.updateMany({
        where: {
          id: window.id,
          prepareAttempts: window.prepareAttempts,
          flushedAttempts: window.flushedAttempts,
          nextAttemptAt: { lte: now },
          closedAt: null,
        },
        data: {
          prepareAttempts: attempts,
          lastError: code,
          nextAttemptAt: new Date(+now + Math.min(HOUR_MS, 1000 * 2 ** Math.min(attempts, 12))),
          quarantinedAt: legacy || attempts >= 5 ? now : null,
        },
      });
      console.warn(JSON.stringify({ event: 'audit.preparation_failed', id: window.id, lastError: code, attempts }));
    }
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
      await tx.$queryRaw`SELECT id FROM "AuthAuditBudget" WHERE id=${budget.id} FOR UPDATE`;
      const current = await tx.authAuditBudget.findUniqueOrThrow({ where: { id: budget.id } });
      if (current.reported) return;
      // Windows from this hour must finish expansion before the immutable suppression summary is frozen.
      if (
        await tx.authAuditWindow.findFirst({
          where: {
            namespace: auditNamespace(),
            closedAt: null,
            windowEnd: { gt: new Date(+current.windowEnd - HOUR_MS), lte: current.windowEnd },
          },
          select: { id: true },
        })
      )
        return;
      if (current.suppressed && current.stream)
        await storeAuditEvent(
          current.stream,
          {
            id: `auth-suppression-${current.id}`,
            action: 'auth.sign_in.suppressed',
            outcome: 'failure',
            severity: 'warning',
            occurredAt: current.windowEnd.toISOString(),
            actor: { type: 'system', id: 'auth-audit-budget' },
            description: `${current.suppressed} more failed sign-ins suppressed between ${new Date(+current.windowEnd - HOUR_MS).toISOString().slice(11, 16)} and ${current.windowEnd.toISOString().slice(11, 16)} UTC`,
            metadata: {
              attempts: current.suppressed,
              windowEnd: current.windowEnd.toISOString(),
              targets: Object.entries(current.targets as Record<string, number>)
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .slice(0, 20)
                .map(([userId, attempts]) => ({ userId, attempts })),
              targetsTruncated: Object.keys(current.targets as Record<string, number>).length > 20,
            },
          },
          tx,
        );
      await tx.authAuditBudget.update({ where: { id: current.id }, data: { reported: true } });
    });
}
