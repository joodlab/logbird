import { hasAdminRole, prisma, workspaceAdminRoles } from '@logbird/database';
import { sendWebhookDisabled, sendWebhookFilterReview, smtpTarget } from '@logbird/email/send';
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

export async function sendWebhookFilterReviewNotices(projectId?: string) {
  if (!smtpTarget().host) return;
  const pending = { filterReviewRequired: true, filterReviewNoticeClaimedAt: null };
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { ...pending, projectId },
    select: { id: true, url: true, description: true, updatedAt: true, project: { select: { id: true, name: true, organizationId: true } } },
    orderBy: { id: 'asc' },
    take: 10,
  });
  for (const endpoint of endpoints) {
    const { id, project } = endpoint;
    try {
      const members = await prisma.member.findMany({
        where: { organizationId: project.organizationId, OR: workspaceAdminRoles.map((role) => ({ role: { contains: role } })) },
        select: { role: true, user: { select: { email: true } } },
      });
      const recipients = [...new Set(members.filter(({ role }) => hasAdminRole(role)).map(({ user }) => user.email))];
      const [email] = recipients;
      // Claim durably before SMTP, whose acknowledgment can be lost after the message was accepted.
      const claimed = await prisma.webhookEndpoint.updateMany({
        where: { id, ...pending, updatedAt: endpoint.updatedAt },
        data: { filterReviewNoticeClaimedAt: await webhookDatabaseTime(), updatedAt: endpoint.updatedAt },
      });
      if (!claimed.count || !email) continue;
      await sendWebhookFilterReview(
        { email, projectId: project.id, project: project.name, description: endpoint.description, host: new URL(endpoint.url).host },
        recipients,
      );
    } catch {
      console.error(JSON.stringify({ level: 'error', event: 'webhook.filter_review_notification_failed', endpointId: id }));
    }
  }
}
