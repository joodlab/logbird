import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@logbird/clickhouse';
import { closeProjectLocks, databaseClock, prisma } from '@logbird/database';
import { afterAll, expect, it, vi } from 'vitest';
import { recoverProjectIngest } from './ingest-recovery';
import { closeRetentionQueue } from './queue';

afterAll(async () => {
  await Promise.all([closeRetentionQueue(), closeProjectLocks(), prisma.$disconnect()]);
});

it('defers scoped and hourly recovery while another claim in the project can still land', async () => {
  const projectId = `qa-recovery-${randomUUID()}`;
  const organizationId = `qa-owner-${randomUUID()}`;
  const now = await databaseClock();
  const old = new Date(now.getTime() - 120_000);
  // Fault injection at the ClickHouse boundary keeps this test from issuing a mutation on the shared ClickHouse.
  const command = vi.fn().mockRejectedValue(new Error('QA flush failed'));
  const store = { command } as unknown as ClickHouseClient;
  await prisma.organization.create({ data: { id: organizationId, slug: organizationId, name: 'Recovery QA', createdAt: now } });
  try {
    await prisma.project.create({ data: { id: projectId, organizationId, slug: projectId, name: 'Recovery QA' } });
    await prisma.ingestReceipt.createMany({
      data: [
        { eventId: 'abandoned', claimedAt: old },
        { eventId: 'unsettled', claimedAt: now },
      ].map((claim) => ({ ...claim, organizationId, projectId, fingerprint: 'fictional', receivedAt: claim.claimedAt, eventAt: claim.claimedAt })),
    });
    const replay = vi.fn();
    await expect(recoverProjectIngest(store, projectId, { eventIds: ['abandoned'], replay })).resolves.toBe(false);
    await expect(recoverProjectIngest(store, projectId)).resolves.toBe(false);
    expect(command).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();

    await prisma.ingestReceipt.updateMany({ where: { projectId, eventId: 'unsettled' }, data: { claimedAt: old } });
    await expect(recoverProjectIngest(store, projectId, { eventIds: ['abandoned'], replay })).rejects.toThrow('QA flush failed');
    expect(command).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ query: 'SYSTEM FLUSH ASYNC INSERT QUEUE' }));
    expect(replay).not.toHaveBeenCalled();
    expect(await prisma.ingestReceipt.count({ where: { projectId, claimedAt: { not: null }, confirmedAt: null } })).toBe(2);
    expect(await prisma.retentionRun.count({ where: { projectId } })).toBe(0);
  } finally {
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
});
