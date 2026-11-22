import { Prisma, prisma } from '@logbird/database';
import { WEBHOOK_LOG_RETENTION_MS } from '@logbird/database/webhooks';

export async function pruneWebhookLogs(now = new Date(), projectId?: string) {
  const expired = new Date(+now - WEBHOOK_LOG_RETENTION_MS);
  const endpoint = projectId ? { projectId } : undefined;
  await prisma.$transaction([
    prisma.webhookAttempt.deleteMany({
      where: { startedAt: { lte: expired }, status: { not: 'sending' }, ...(endpoint ? { delivery: { endpoint } } : {}) },
      limit: 5000,
    }),
    // Lock terminal candidates before the delete so a concurrent resend cannot turn a selected row pending.
    prisma.$executeRaw(Prisma.sql`
      DELETE FROM "WebhookDelivery" WHERE id IN (
        SELECT d.id FROM "WebhookDelivery" d
        WHERE d.status <> 'pending' AND d."expiresAt" <= ${now}
          ${projectId ? Prisma.sql`AND EXISTS (SELECT 1 FROM "WebhookEndpoint" e WHERE e.id = d."endpointId" AND e."projectId" = ${projectId})` : Prisma.empty}
        ORDER BY d."expiresAt" LIMIT 5000 FOR UPDATE SKIP LOCKED
      )`),
    prisma.webhookDisableNotice.deleteMany({ where: { createdAt: { lte: expired }, endpoint }, limit: 5000 }),
  ]);
}
