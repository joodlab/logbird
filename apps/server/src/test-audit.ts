import { prisma } from '@logbird/database';
import { flushFailedSignIns } from './auth-failures';
import { env } from './env';
import { ingest } from './ingest';
import { deliverOutboxEvent } from './outbox-delivery';
/** In-process worker delivery, restricted to the test's fictional workspace. No listeners or shared queue. */
export async function drainTestAudit(organizationId: string) {
  const rows = await prisma.auditOutbox.findMany({ where: { stream: `ws:${organizationId}`, deliveredAt: null } });
  for (const row of rows) await deliverOutboxEvent(row.id, ingest);
}
export async function flushTestSignIns(emailHashes: string[]) {
  const rows = await prisma.authAuditWindow.findMany({
    where: { OR: emailHashes.map((hash) => ({ id: { startsWith: hash } })) },
    select: { id: true },
  });
  await flushFailedSignIns(
    env.BETTER_AUTH_SECRET,
    new Date(),
    rows.map((row) => row.id),
  );
}
