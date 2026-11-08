import { afterEach, expect, it, vi } from 'vitest';

const { findMany, reconcile } = vi.hoisted(() => ({ findMany: vi.fn(), reconcile: vi.fn() }));
vi.mock('@logbird/database', () => ({
  prisma: { project: { findMany } },
  withProjectLock: async (_id: string, work: () => Promise<unknown>) => work(),
}));
vi.mock('@logbird/worker/destructive-maintenance', () => ({ beginDestructiveMaintenance: vi.fn(), reconcileDestructiveMaintenance: reconcile }));
vi.mock('./clickhouse', () => ({ maintenanceClickhouse: {} }));

import { startDestructiveMaintenanceReconciler } from './destructive-maintenance';

let loop: ReturnType<typeof startDestructiveMaintenanceReconciler> | undefined;
afterEach(async () => {
  await loop?.stop();
  loop = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it('revisits exactly five fences on the next ten-second tick without an empty sweep', async () => {
  vi.useFakeTimers();
  findMany.mockResolvedValue(Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, exportDeleteStartedAt: new Date() })));
  reconcile.mockResolvedValue(false);
  loop = startDestructiveMaintenanceReconciler();
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcile).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(reconcile).toHaveBeenCalledTimes(10);
  expect(findMany.mock.calls.map(([query]) => query.where.id.gt)).toEqual(['', '']);
});
it('rotates larger pages while bounding each sweep to five projects', async () => {
  vi.useFakeTimers();
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, exportDeleteStartedAt: new Date() }));
  findMany.mockImplementation(async ({ where }) => rows.filter((row) => row.id > where.id.gt));
  reconcile.mockResolvedValue(false);
  loop = startDestructiveMaintenanceReconciler();
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcile).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(reconcile).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(reconcile).toHaveBeenCalledTimes(11);
  expect(findMany.mock.calls.map(([query]) => query.where.id.gt)).toEqual(['', 'p4', '']);
});
it('periodically warns about fences older than five minutes without expiring or clearing them', async () => {
  vi.useFakeTimers();
  findMany.mockResolvedValue([
    { id: 'old', exportDeleteStartedAt: new Date(Date.now() - 360_000) },
    { id: 'new', exportDeleteStartedAt: new Date() },
  ]);
  reconcile.mockResolvedValue(false);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  loop = startDestructiveMaintenanceReconciler();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(warning).toHaveBeenCalledTimes(2);
  for (const [message] of warning.mock.calls)
    expect(JSON.parse(message)).toMatchObject({
      event: 'maintenance.reconciliation_pending',
      projectId: 'old',
      ageSeconds: expect.any(Number),
      code: 'destructive_work_pending',
    });
});
