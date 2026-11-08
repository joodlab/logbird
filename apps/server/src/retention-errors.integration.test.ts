import { randomUUID } from 'node:crypto';
import { insertEvents, normalizeEvent, purgeProject } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
import { clickhouse, enforceProjectRetention } from '@logbird/worker/retention';
import { expect, it, vi } from 'vitest';

// Local ClickHouse mutation slots can queue the five verified lightweight deletes in finally.
it('records the underlying retention error code without logging query content', async () => {
  const id = randomUUID();
  const organization = await prisma.organization.create({ data: { id, name: 'QA retention failure', slug: id, createdAt: new Date() } });
  const project = await prisma.project.create({ data: { organizationId: organization.id, name: 'QA expired fixture', slug: id, retentionDays: 90 } });
  const event = normalizeEvent(
    { id, action: 'qa.retention.error', occurredAt: new Date(Date.now() - 200 * 86_400_000).toISOString() },
    { projectId: project.id, receivedAt: new Date() },
  );
  if (!event.ok) throw new Error('Invalid expired fictional event');
  await insertEvents(clickhouse, [event.row]);
  const privateMarker = 'PRIVATE_QUERY_SHOULD_NOT_BE_LOGGED';
  const command = vi.spyOn(clickhouse, 'command').mockRejectedValueOnce(Object.assign(new Error(privateMarker), { code: '241' }));
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await expect(enforceProjectRetention(project.id)).rejects.toMatchObject({ code: '241' });
    const receipt = await prisma.retentionRun.findFirstOrThrow({ where: { projectId: project.id }, orderBy: { startedAt: 'desc' } });
    expect(receipt.status).toBe('failed');
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).maintenanceGeneration).toBe(1n);
    expect(receipt.error).toBe('ClickHouse retention failed; retry required.');
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ level: 'error', event: 'retention.run_failed', runId: receipt.id, projectId: project.id, errorCode: '241' }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateMarker);
  } finally {
    command.mockRestore();
    log.mockRestore();
    await purgeProject(clickhouse, project.id);
    await prisma.organization.delete({ where: { id: organization.id } });
  }
}, 60_000);
