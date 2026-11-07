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
  global_overflow: 'reason unavailable in the legacy overflow counter',
};
const hourEnd = (now: Date) => new Date((Math.floor(+now / HOUR_MS) + 1) * HOUR_MS);
const budgetId = (stream: string, end: Date) => `${auditNamespace()}:${stream}:${+end - HOUR_MS}`;

/** Lock budgets before windows everywhere; shared admissions cannot be invisible to finalization. */
async function lockWorkspaceBudgets(tx: Prisma.TransactionClient, organizations: readonly string[], end: Date, mode: 'SHARE' | 'UPDATE') {
  for (const organizationId of [...new Set(organizations)].sort()) {
    const stream = `ws:${organizationId}`,
      id = budgetId(stream, end);
    await tx.$executeRaw`INSERT INTO "AuthAuditBudget" (id, namespace, stream, "windowEnd")
      VALUES (${id},${auditNamespace()},${stream},${end}) ON CONFLICT (id) DO NOTHING`;
    if (mode === 'SHARE') await tx.$queryRaw`SELECT id FROM "AuthAuditBudget" WHERE id=${id} FOR SHARE`;
    else await tx.$queryRaw`SELECT id FROM "AuthAuditBudget" WHERE id=${id} FOR UPDATE`;
  }
}

async function insertWindow(
  tx: Prisma.TransactionClient,
  emailHash: string,
  reason: string,
  context: Prisma.InputJsonObject,
  initialEnd: Date,
  initialTime: Date,
  organizations: readonly string[],
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
    await lockWorkspaceBudgets(tx, organizations, hourEnd(new Date(+end - 1)), 'SHARE');
    const id = `${emailHash}:${overflow ? `overflow:${reason}` : reason}:${+end}:${auditNamespace()}`;
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

/** Only hashes/context are staged. Indexed member resolution supplies the workspace finalization fences. */
export async function stageFailedSignIn(email: string, reason: string, context: Prisma.InputJsonObject, secret: string, now = new Date()) {
  const hash = authEmailHash(email, secret),
    end = new Date((Math.floor(+now / WINDOW_MS) + 1) * WINDOW_MS);
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true } });
  const organizations = user
    ? (await prisma.member.findMany({ where: { userId: user.id }, select: { organizationId: true } })).map((m) => m.organizationId)
    : [];
  await prisma.$transaction(async (tx) => {
    const window = await insertWindow(tx, hash, reason, context, end, now, organizations);
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
    const budget = await tx.authAuditBudget.update({ where: { id: globalId }, data: { suppressed: { increment: 1 }, reported: false } });
    if (budget.suppressed === 1)
      console.warn(JSON.stringify({ event: 'global_suppression_started', namespace: auditNamespace(), windowEnd: budget.windowEnd }));
    // Fresh sprays cannot consume the member evidence budget: preserve a hash-only counter per identity/hour.
    await insertWindow(tx, hash, reason, context, hourEnd(admittedAt), admittedAt, organizations, true);
    await tx.authAuditWindow.delete({ where: { id: window.id } });
  });
}

/** Nullable indexed hashes are backfilled in small batches; successful sign-ins also refresh their own hash. */
export async function backfillAuthEmailHashes(secret: string) {
  const users = await prisma.user.findMany({ where: { emailHash: null }, take: 100, select: { id: true, email: true } });
  for (const user of users)
    await prisma.user.updateMany({ where: { id: user.id, emailHash: null }, data: { emailHash: authEmailHash(user.email, secret) } });
}
function windowMetadata(current: AuthAuditWindow, first: boolean) {
  // First rows describe one attempt; summary rows describe the full window without a single request context.
  const ip = current.context && typeof current.context === 'object' && !Array.isArray(current.context) ? current.context.ip : undefined;
  const firstTime = current.firstAttemptAt.toISOString();
  return {
    distinctIps: first ? (typeof ip === 'string' && ip ? [ip] : []) : current.distinctIps,
    ipsTruncated: !first && current.ipsTruncated,
    firstAttemptAt: firstTime,
    lastAttemptAt: first ? firstTime : current.lastAttemptAt.toISOString(),
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
    await lockWorkspaceBudgets(
      tx,
      members.map((m) => m.organizationId),
      hourEnd(new Date(+window.windowEnd - 1)),
      'UPDATE',
    );
    await tx.$queryRaw`SELECT id FROM "AuthAuditWindow" WHERE id=${window.id} FOR UPDATE`;
    const current = await tx.authAuditWindow.findUniqueOrThrow({ where: { id: window.id } });
    if (current.nextAttemptAt > now || current.quarantinedAt || current.closedAt) return;
    const first = current.flushedAttempts === 0;
    const count = first ? 1 : current.attempts - current.flushedAttempts;
    const occurrence = first ? current.firstAttemptAt : current.lastAttemptAt;
    if (+hourEnd(occurrence) !== +hourEnd(new Date(+current.windowEnd - 1)))
      throw Object.assign(new Error('Invalid window times'), { code: 'invalid_window_time' });
    for (const member of members) {
      if (!count || !user) continue;
      const stream = `ws:${member.organizationId}`,
        id = budgetId(stream, hourEnd(occurrence));
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
            ? `Failed sign-in to ${name}'s account (${reasons[current.reason] ?? 'sign-in rejected'})${current.overflow ? ' (counted under the global admission limit)' : ''}`
            : `${count} more failed sign-ins to ${name}'s account between ${times}${current.overflow ? ' (counted under the global admission limit)' : ''}`,
          context: first ? current.context : undefined,
          metadata: {
            emailHash: current.emailHash,
            hashVersion: 1,
            reason: current.reason,
            overflow: current.overflow,
            attempts: count,
            windowEnd: current.windowEnd.toISOString(),
            ...windowMetadata(current, first),
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

function targetCounts(value: Prisma.JsonValue) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((v) => typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
  )
    throw Object.assign(new Error('Invalid budget targets'), { code: 'invalid_budget_watermark' });
  return value as Record<string, number>;
}

export async function flushAuthAuditBudgets(now = new Date(), ids?: string[]) {
  const budgets = await prisma.authAuditBudget.findMany({
    where: {
      namespace: auditNamespace(),
      reported: false,
      quarantinedAt: null,
      nextAttemptAt: { lte: now },
      windowEnd: { lte: now },
      ...(ids ? { id: { in: ids } } : {}),
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
    take: 100,
  });
  for (const budget of budgets) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "AuthAuditBudget" WHERE id=${budget.id} FOR UPDATE`;
        const current = await tx.authAuditBudget.findUniqueOrThrow({ where: { id: budget.id } });
        if (current.reported || current.quarantinedAt || current.nextAttemptAt > now) return;
        // Admissions hold this budget FOR SHARE before their INSERT, so an invisible window cannot pass this check.
        if (
          await tx.authAuditWindow.findFirst({
            where: { namespace: auditNamespace(), closedAt: null, windowEnd: { gt: new Date(+current.windowEnd - HOUR_MS), lte: current.windowEnd } },
            select: { id: true },
          })
        )
          return;
        const delta = current.suppressed - current.reportedSuppressed;
        if (delta < 0) throw Object.assign(new Error('Invalid budget watermark'), { code: 'invalid_budget_watermark' });
        const targets = targetCounts(current.targets),
          previous = targetCounts(current.reportedTargets);
        if (Object.entries(previous).some(([id, count]) => (targets[id] ?? 0) < count))
          throw Object.assign(new Error('Invalid target watermark'), { code: 'invalid_budget_watermark' });
        // Old truncated receipts establish only a partial per-user watermark. Do not invent unknown target deltas.
        const changes = Object.entries(targets)
          .filter(([id]) => current.targetWatermarkComplete || Object.hasOwn(previous, id))
          .map(([userId, count]) => ({ userId, attempts: count - (previous[userId] ?? 0) }))
          .filter((t) => t.attempts > 0)
          .sort((a, b) => b.attempts - a.attempts || a.userId.localeCompare(b.userId));
        const targetDelta = changes.reduce((sum, t) => sum + t.attempts, 0);
        if (targetDelta > delta) throw Object.assign(new Error('Inconsistent target delta'), { code: 'invalid_budget_watermark' });
        const generation = current.generation + (delta > 0 ? 1 : 0);
        if (delta > 0 && current.stream)
          await storeAuditEvent(
            current.stream,
            {
              id: `auth-suppression-${current.id}-${generation}`,
              action: 'auth.sign_in.suppressed',
              outcome: 'failure',
              severity: 'warning',
              occurredAt: current.windowEnd.toISOString(),
              actor: { type: 'system', id: 'auth-audit-budget' },
              description: `${delta} more failed sign-ins suppressed between ${new Date(+current.windowEnd - HOUR_MS).toISOString().slice(11, 16)} and ${current.windowEnd.toISOString().slice(11, 16)} UTC`,
              metadata: {
                attempts: delta,
                totalAttempts: current.suppressed,
                generation,
                windowEnd: current.windowEnd.toISOString(),
                targets: changes.slice(0, 20),
                targetsTruncated: !current.targetWatermarkComplete || changes.length > 20 || targetDelta < delta,
              },
            },
            tx,
          );
        await tx.authAuditBudget.update({
          where: { id: current.id },
          data: {
            reported: true,
            reportedSuppressed: current.suppressed,
            reportedTargets: current.targets as Prisma.InputJsonObject,
            targetWatermarkComplete: true,
            generation,
            prepareAttempts: 0,
            lastError: null,
            nextAttemptAt: now,
          },
        });
      });
    } catch (error) {
      const attempts = budget.prepareAttempts + 1;
      const code =
        error && typeof error === 'object' && 'code' in error && error.code === 'invalid_budget_watermark'
          ? 'invalid_budget_watermark'
          : 'audit_budget_preparation_unavailable';
      await prisma.authAuditBudget
        .updateMany({
          where: {
            id: budget.id,
            reported: false,
            quarantinedAt: null,
            prepareAttempts: budget.prepareAttempts,
            generation: budget.generation,
            nextAttemptAt: { lte: now },
          },
          data: {
            prepareAttempts: attempts,
            lastError: code,
            nextAttemptAt: new Date(+now + Math.min(HOUR_MS, 1000 * 2 ** Math.min(attempts, 12))),
            quarantinedAt: attempts >= 5 ? now : null,
          },
        })
        .catch(() => console.error(JSON.stringify({ event: 'audit.preparation_state_unavailable', kind: 'budget', id: budget.id })));
      console.warn(JSON.stringify({ event: 'audit.preparation_failed', kind: 'budget', id: budget.id, lastError: code, attempts }));
    }
  }
}
