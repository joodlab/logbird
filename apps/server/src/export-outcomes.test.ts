import { beforeEach, expect, it, vi } from 'vitest';

const { tx, prisma } = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    project: { findUnique: vi.fn(), update: vi.fn() },
    retentionRun: { findFirst: vi.fn() },
    ingestReceipt: { findFirst: vi.fn() },
    exportLease: { findUnique: vi.fn(), aggregate: vi.fn(), count: vi.fn(), create: vi.fn() },
    auditOutbox: { create: vi.fn(), findFirst: vi.fn() },
  };
  return { tx, prisma: { ...tx, $transaction: vi.fn() } };
});
vi.mock('@logbird/database', () => ({
  prisma,
  Prisma: { DbNull: null },
  ProjectBusyError: class extends Error {},
  auditNamespace: () => '{qa-export-unit}',
  withProjectLock: async (_id: string, work: () => Promise<unknown>) => work(),
  freezeAuditEvent: (event: object) => ({ id: 'outcome', payload: event }),
  storeAuditEvent: async (stream: string, event: object, db: typeof tx) => db.auditOutbox.create({ data: { stream, payload: event } }),
}));

import { getExportStatus, stageExport, validateExportMembership } from './export-outcomes';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation((work) => work(tx));
  tx.$queryRaw.mockResolvedValue([{ now: new Date('2026-11-08T00:00:00Z') }]);
  tx.project.findUnique.mockResolvedValue({ id: 'project', exportGeneration: 1, maintenanceGeneration: 0, exportDeleteStartedAt: null });
  tx.retentionRun.findFirst.mockResolvedValue(null);
  tx.ingestReceipt.findFirst.mockResolvedValue(null);
  tx.exportLease.findUnique.mockResolvedValue({
    id: 'export',
    receivedBefore: new Date('2026-11-08T00:00:00Z'),
    expiresAt: new Date('2026-11-08T00:01:00Z'),
    invalidated: false,
  });
  tx.exportLease.aggregate.mockResolvedValue({ _sum: { weight: 0 } });
  tx.exportLease.count.mockResolvedValue(0);
  tx.auditOutbox.create.mockImplementation(async ({ data }) => ({ id: data.id ?? 'requested', ...data }));
});
it('stores requested and unknown evidence for a refused unreadable project without reserving query capacity', async () => {
  tx.retentionRun.findFirst.mockResolvedValue({ id: 'failed-retention', status: 'failed' });
  const result = await stageExport({
    id: 'export',
    userId: 'user',
    workspaceId: 'workspace',
    projectId: 'project',
    stream: 'ws:workspace',
    requested: { action: 'export.requested' },
    unknown: { action: 'export.outcome_unknown' },
  });
  expect(result.membership).toBeNull();
  expect(tx.auditOutbox.create).toHaveBeenCalledTimes(2);
  expect(tx.exportLease.create).not.toHaveBeenCalled();
});
it('recovers an orphaned delete marker under the exclusive boundary while preserving its generation', async () => {
  tx.project.findUnique.mockResolvedValue({ id: 'project', exportGeneration: 5, maintenanceGeneration: 0, exportDeleteStartedAt: new Date() });
  await expect(validateExportMembership('project', '5:0:', 'export')).resolves.toBeUndefined();
  expect(tx.project.update).toHaveBeenCalledWith({ where: { id: 'project' }, data: { exportDeleteStartedAt: null } });
});
it('labels storage outages separately from changed membership and rejects expired leases', async () => {
  prisma.$transaction.mockRejectedValueOnce({ code: 'P1001' });
  await expect(validateExportMembership('project', '1:0:', 'export')).rejects.toMatchObject({ code: 'export_storage_unavailable' });
  tx.exportLease.findUnique.mockResolvedValue({ expiresAt: new Date('2026-11-07T00:00:00Z'), invalidated: false });
  await expect(validateExportMembership('project', '1:0:', 'export')).rejects.toMatchObject({ code: 'export_lease_expired' });
});
it('scopes outcome lookup to the active workspace and namespace and never exposes a provisional completion', async () => {
  tx.auditOutbox.findFirst.mockResolvedValue({
    confirmedAt: null,
    payload: { action: 'export.outcome_unknown' },
    pendingOutcome: { action: 'export.completed' },
  });
  expect(await getExportStatus('export', 'ws:workspace')).toMatchObject({ state: 'pending', reason: null, description: null });
  expect(tx.auditOutbox.findFirst).toHaveBeenCalledWith({ where: { id: 'export-outcome', namespace: '{qa-export-unit}', stream: 'ws:workspace' } });
  tx.auditOutbox.findFirst.mockResolvedValue(null);
  await expect(getExportStatus('export', 'ws:foreign')).rejects.toMatchObject({ status: 404 });
});
