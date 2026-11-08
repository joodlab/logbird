import { prisma } from '@logbird/database';
import { flushFailedSignIns } from './auth-failures';
import { drainExportAudits } from './export-stream';
import { ingest } from './ingest';
import { deliverOutboxEvent } from './outbox-delivery';
/** In-process API delivery, restricted to the test's fictional workspace. No listeners or shared queue. */
export async function drainTestAudit(organizationId: string) {
  await drainExportAudits();
  const rows = await prisma.auditOutbox.findMany({ where: { stream: `ws:${organizationId}`, deliveredAt: null } });
  for (const row of rows) await deliverOutboxEvent(row.id, ingest);
}
export async function flushTestSignIns(emailHashes: string[]) {
  const rows = await prisma.authAuditWindow.findMany({
    where: { OR: emailHashes.map((hash) => ({ id: { startsWith: hash } })) },
    select: { id: true },
  });
  await flushFailedSignIns(
    new Date(),
    rows.map((row) => row.id),
  );
}
