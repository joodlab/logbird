import { type AuditOutbox, type AuditPayload, auditNamespace, Prisma, prisma } from '@logbird/database';

export type DeliverAuditEvent = (stream: string, event: AuditPayload) => Promise<{ accepted: number; rejected: { reason: string }[] }>;

/** Transactions hold row locks only while claiming; ingestion never runs inside a transaction or advisory lock. */
export async function claimAuditEvents(now = new Date(), id?: string) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<AuditOutbox[]>(Prisma.sql`
      SELECT * FROM "AuditOutbox"
      WHERE "namespace"=${auditNamespace()} AND "deliveredAt" IS NULL AND "nextAttemptAt" <= ${now}
      ${id ? Prisma.sql`AND "id"=${id}` : Prisma.empty}
      ORDER BY "nextAttemptAt", "id" LIMIT 8 FOR UPDATE SKIP LOCKED
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
      const conflict = result.rejected.some((r) => r.reason.startsWith('duplicate_id_conflict'));
      throw Object.assign(new Error('Audit delivery rejected'), { code: conflict ? 'duplicate_id_conflict' : 'audit_rejected' });
    }
    await prisma.auditOutbox.updateMany({ where, data: { deliveredAt: new Date(), lastError: null } });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const lastError = ['ingest_pending', 'duplicate_id_conflict', 'audit_rejected'].includes(code) ? code : 'audit_storage_unavailable';
    await prisma.auditOutbox.updateMany({
      where,
      data: { lastError, nextAttemptAt: new Date(now.getTime() + Math.min(3_600_000, 1000 * 2 ** Math.min(row.attempts, 12))) },
    });
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
  const wake = () => {
    if (stopped || running) return;
    running = (async () => {
      await prepare?.();
      if (!stopped) await drainAuditOutbox(deliverAuditEvent);
    })()
      .catch(() => console.error(JSON.stringify({ event: 'audit.drainer_failed' })))
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
