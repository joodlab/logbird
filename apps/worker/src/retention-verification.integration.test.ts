import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@logbird/clickhouse';
import { closeProjectLocks, databaseClock, INGEST_RECEIPT_WINDOW_MS, prisma } from '@logbird/database';
import { afterAll, expect, it, vi } from 'vitest';
import { verifyRetentionRuns } from './retention-verification';

afterAll(async () => {
  await Promise.all([closeProjectLocks(), prisma.$disconnect()]);
});

it('persists a repair when an older completed run disagrees with ClickHouse and queueing fails', async () => {
  const projectId = `qa-verification-${randomUUID()}`;
  const organizationId = randomUUID();
  const now = await databaseClock();
  const zero = { minute: 0, actor: 0, tenant: 0, executor: 0, target: 0, attributes: 0 };
  const olderStart = new Date(now.getTime() - 60_000);
  const verification = {
    version: 1,
    window: { from: olderStart.toISOString(), to: now.toISOString() },
    baseline: zero,
    allowance: zero,
    baselineOff: [],
  };
  const drift = { json: async () => [{ ...zero, minute: -1 }] };
  const query = vi.fn().mockResolvedValue(drift);
  const store = { query } as unknown as ClickHouseClient;
  const enqueue = vi.fn().mockRejectedValue(new Error('QA queue unavailable'));
  await prisma.organization.create({ data: { id: organizationId, slug: organizationId, name: 'Verification QA', createdAt: now } });
  try {
    await prisma.project.create({ data: { id: projectId, organizationId, slug: projectId, name: 'Verification QA' } });
    const run = { projectId, retentionDays: 30, cutoff: now, status: 'completed' };
    const older = await prisma.retentionRun.create({ data: { ...run, startedAt: olderStart, verification } });
    await prisma.retentionRun.create({ data: { ...run, startedAt: now } });
    query.mockImplementationOnce(async () => {
      const claimedAt = await databaseClock();
      await prisma.ingestReceipt.create({
        data: { projectId, organizationId, eventId: 'concurrent', fingerprint: 'fictional', receivedAt: olderStart, eventAt: olderStart, claimedAt },
      });
      return drift;
    });
    await verifyRetentionRuns(store, projectId, enqueue);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await prisma.retentionRun.findUnique({ where: { id: older.id } })).toMatchObject({ status: 'completed', verification });

    await prisma.ingestReceipt.deleteMany({ where: { projectId, eventId: 'concurrent' } });
    const queryRaw = prisma.$queryRaw.bind(prisma);
    const clock = vi
      .spyOn(prisma, '$queryRaw')
      .mockImplementationOnce(queryRaw)
      .mockResolvedValueOnce([{ now: new Date(now.getTime() - INGEST_RECEIPT_WINDOW_MS) }]);
    try {
      await verifyRetentionRuns(store, projectId, enqueue);
      expect(query).toHaveBeenCalledTimes(2);
      expect(enqueue).not.toHaveBeenCalled();
      expect(await prisma.retentionRun.findUnique({ where: { id: older.id } })).toMatchObject({ status: 'completed', verification });
    } finally {
      clock.mockRestore();
    }

    await verifyRetentionRuns(store, projectId, enqueue);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(projectId);
    expect(await prisma.retentionRun.findUnique({ where: { id: older.id } })).toMatchObject({
      status: 'failed',
      verification: { result: { repairQueued: true, grew: ['minute'] } },
    });
    expect(await prisma.retentionRun.findMany({ where: { projectId, kind: 'ingest_repair' } })).toMatchObject([{ status: 'failed' }]);
    await verifyRetentionRuns(store, projectId, enqueue);
    expect(enqueue).toHaveBeenCalledTimes(1);
  } finally {
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  }
});
