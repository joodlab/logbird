import { type AuditOutbox, type AuditPayload, auditNamespace, Prisma, prisma } from '@logbird/database';

export type DeliverAuditEvent = (stream: string, event: AuditPayload) => Promise<{ accepted: number; rejected: { reason: string }[] }>;

/** Transactions hold row locks only while claiming; ingestion never runs inside a transaction or advisory lock. */
export async function claimAuditEvents(now = new Date(), id?: string) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<AuditOutbox[]>(Prisma.sql`
      SELECT * FROM "AuditOutbox"
      WHERE "namespace"=${auditNamespace()} AND "deliveredAt" IS NULL AND "confirmedAt" IS NOT NULL AND "quarantinedAt" IS NULL AND "nextAttemptAt" <= ${now}
      ${id ? Prisma.sql`AND "id"=${id}` : Prisma.empty}
      ORDER BY "nextAttemptAt", "id" LIMIT 2 FOR UPDATE SKIP LOCKED
    `);
    if (!rows.length) return [];
    const lease = new Date(now.getTime() + 60_000);
    await tx.auditOutbox.updateMany({ where: { id: { in: rows.map((row) => row.id) } }, data: { attempts: { increment: 1 }, nextAttemptAt: lease } });
    return rows.map((row) => ({ ...row, attempts: row.attempts + 1, nextAttemptAt: lease }));
  });
}
async function deliverClaimed(row: AuditOutbox, deliverAuditEvent: DeliverAuditEvent, now = new Date()) {
  // attempts fences late results from an expired lease; they cannot overwrite a newer delivery attempt.
  const where = { id: row.id, namespace: auditNamespace(), deliveredAt: null, attempts: row.attempts };
  try {
    const result = await deliverAuditEvent(row.stream, row.payload as AuditPayload);
    if (result.accepted !== 1 || result.rejected.length) {
      const reason = result.rejected[0]?.reason ?? '';
      const code = reason.startsWith('duplicate_id_conflict')
        ? 'duplicate_id_conflict'
        : reason.startsWith('invalid_event')
          ? 'invalid_event'
          : 'audit_rejected';
      throw Object.assign(new Error('Audit delivery rejected'), { code });
    }
    await prisma.auditOutbox.updateMany({ where, data: { deliveredAt: new Date(), lastError: null } });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const lastError = ['ingest_pending', 'duplicate_id_conflict', 'invalid_event', 'audit_rejected'].includes(code)
      ? code
      : 'audit_storage_unavailable';
    await prisma.auditOutbox.updateMany({
      where,
      data: {
        lastError,
        quarantinedAt: row.attempts >= 10 ? now : null,
        nextAttemptAt: new Date(now.getTime() + Math.min(3_600_000, 1000 * 2 ** Math.min(row.attempts, 12))),
      },
    });
    console.warn(JSON.stringify({ event: 'audit.delivery_failed', id: row.id, stream: row.stream, attempts: row.attempts, lastError }));
  }
}
export async function deliverOutboxEvent(id: string, deliverAuditEvent: DeliverAuditEvent, now = new Date()) {
  for (const row of await claimAuditEvents(now, id)) await deliverClaimed(row, deliverAuditEvent, now);
}
/** A requested export can race another replica's drainer claim; wait for its acknowledgement before sending bytes. */
export async function waitForAuditDelivery(id: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const row = await prisma.auditOutbox.findUnique({ where: { id } });
    if (row?.deliveredAt) return true;
    if (!row || row.lastError || Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
export async function drainAuditOutbox(deliverAuditEvent: DeliverAuditEvent, now = new Date()) {
  const rows = await claimAuditEvents(now);
  const results = await Promise.allSettled(rows.map((row) => deliverClaimed(row, deliverAuditEvent, now)));
  if (results.some((r) => r.status === 'rejected')) throw new Error('Outbox delivery state unavailable');
  return rows.length;
}

/** Every API replica owns one bounded loop. Expired leases are recovered by the same due-row sweep. */
export function startAuditDrainer(deliverAuditEvent: DeliverAuditEvent, prepare?: () => Promise<void>) {
  let stopped = false;
  let running: Promise<unknown> | undefined;
  let lastMaintenance = 0;
  const wake = () => {
    if (stopped || running) return;
    running = (async () => {
      const results = await Promise.allSettled([prepare?.(), drainAuditOutbox(deliverAuditEvent)]);
      if (results.some((result) => result.status === 'rejected'))
        console.error(JSON.stringify({ event: 'audit.drainer_failed', lastError: 'audit_storage_unavailable' }));
      if (!stopped && Date.now() - lastMaintenance >= 60_000) {
        lastMaintenance = Date.now();
        await sweepAuditRetention();
        const lag = await auditDrainStatus();
        if (lag.undelivered) console.warn(JSON.stringify({ event: 'audit.drain_lag', ...lag }));
      }
    })()
      .catch(() => console.error(JSON.stringify({ event: 'audit.drainer_failed', lastError: 'audit_storage_unavailable' })))
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(wake, 1000);
  timer.unref();
  wake();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}

export async function auditDrainStatus(now = new Date()) {
  const where = { namespace: auditNamespace(), deliveredAt: null };
  const [pending, quarantined] = await Promise.all([
    prisma.auditOutbox.aggregate({ where, _count: true, _min: { createdAt: true } }),
    prisma.auditOutbox.count({ where: { ...where, quarantinedAt: { not: null } } }),
  ]);
  return {
    undelivered: pending._count,
    oldestSeconds: pending._min.createdAt ? Math.max(0, Math.floor((+now - +pending._min.createdAt) / 1000)) : 0,
    quarantined,
  };
}

/** Bounded deletes take short row locks. Unconfirmed, undelivered and quarantined evidence is retained. */
export async function sweepAuditRetention(now = new Date()) {
  const ns = auditNamespace();
  // Old replicas may have staged ambiguous hook intents before the owned routes deployed.
  // Preserve these rows for investigation; session existence is never proof of a committed action.
  await prisma.$executeRaw`UPDATE "AuditOutbox" SET "quarantinedAt"=${now}, "lastError"='legacy_session_intent'
    WHERE id IN (SELECT id FROM "AuditOutbox" WHERE namespace=${ns} AND "sourceSessionId" IS NOT NULL
    AND "confirmedAt" IS NULL AND "quarantinedAt" IS NULL ORDER BY "createdAt" LIMIT 100 FOR UPDATE SKIP LOCKED)`;
  const delivered = await prisma.$executeRaw`DELETE FROM "AuditOutbox" WHERE id IN (
    SELECT id FROM "AuditOutbox" WHERE namespace=${ns} AND "deliveredAt" < ${new Date(+now - 7 * 86_400_000)}
    AND "quarantinedAt" IS NULL ORDER BY "deliveredAt" LIMIT 200 FOR UPDATE SKIP LOCKED)`;
  const windows = await prisma.$executeRaw`DELETE FROM "AuthAuditWindow" WHERE id IN (
    SELECT id FROM "AuthAuditWindow" WHERE namespace=${ns} AND "closedAt" IS NOT NULL AND "quarantinedAt" IS NULL
    AND "flushedAttempts"=attempts AND "windowEnd" < ${new Date(+now - 3_600_000)} ORDER BY "windowEnd" LIMIT 200 FOR UPDATE SKIP LOCKED)`;
  const budgets = await prisma.$executeRaw`DELETE FROM "AuthAuditBudget" WHERE id IN (
    SELECT b.id FROM "AuthAuditBudget" b WHERE b.namespace=${ns} AND b.reported=true AND b."windowEnd" < ${new Date(+now - 86_400_000)}
    AND NOT EXISTS (SELECT 1 FROM "AuthAuditWindow" w WHERE w.namespace=b.namespace AND w."closedAt" IS NULL
      AND w."windowEnd">b."windowEnd"-INTERVAL '1 hour' AND w."windowEnd"<=b."windowEnd")
    ORDER BY b."windowEnd" LIMIT 200 FOR UPDATE SKIP LOCKED)`;
  return { delivered, windows, budgets };
}
