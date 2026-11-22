import { hasAdminRole, prisma } from '@logbird/database';
import { sendWebhookDisabled } from '@logbird/email/send';
import { webhookDatabaseTime } from './webhook-clock';

export async function sendWebhookDisableNotices(projectId?: string) {
  const now = await webhookDatabaseTime();
  const notices = await prisma.webhookDisableNotice.findMany({
    where: { nextAttemptAt: { lte: now }, ...(projectId ? { endpoint: { projectId } } : {}) },
    include: { endpoint: { select: { project: { select: { name: true, organizationId: true } } } } },
    orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
    take: 10,
  });
  await Promise.all(
    notices.map(async (notice) => {
      const { project } = notice.endpoint;
      const claimed = await prisma.webhookDisableNotice.updateMany({
        where: { id: notice.id, nextAttemptAt: notice.nextAttemptAt },
        data: { nextAttemptAt: new Date(+now + 3_600_000) },
      });
      if (!claimed.count) return;
      try {
        const member = await prisma.member.findFirst({
          where: { organizationId: project.organizationId, userId: notice.recipientId },
          select: { role: true, user: { select: { email: true } } },
        });
        if (member && hasAdminRole(member.role))
          await sendWebhookDisabled({
            email: member.user.email,
            project: project.name,
            reason: notice.reason === 'gone_410' ? 'gone_410' : 'consecutive_failures',
          });
        await prisma.webhookDisableNotice.deleteMany({ where: { id: notice.id } });
      } catch {
        console.error(JSON.stringify({ event: 'webhook.notification_failed', noticeId: notice.id }));
      }
    }),
  );
}
