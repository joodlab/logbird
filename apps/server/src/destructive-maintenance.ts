import { prisma, withProjectLock } from '@logbird/database';
import { reconcileDestructiveMaintenance as reconcile } from '@logbird/worker/destructive-maintenance';
import { maintenanceClickhouse } from './clickhouse';

export { beginDestructiveMaintenance } from '@logbird/worker/destructive-maintenance';
export const reconcileDestructiveMaintenance = (projectId: string) => reconcile(maintenanceClickhouse, projectId);

/** Rotating bounded pages: one blocked project cannot hide later fences. Every replica may run this sweep. */
export function startDestructiveMaintenanceReconciler() {
  let stopped = false;
  let running: Promise<void> | undefined;
  let cursor = '';
  const wake = () => {
    if (stopped || running) return;
    running = (async () => {
      const projects = await prisma.project.findMany({
        where: { exportDeleteStartedAt: { not: null }, id: { gt: cursor } },
        select: { id: true, exportDeleteStartedAt: true },
        orderBy: { id: 'asc' },
        take: 6,
      });
      const page = projects.slice(0, 5);
      cursor = projects.length > 5 ? (page.at(-1)?.id ?? '') : '';
      for (const project of page) {
        if (stopped) break;
        const ageSeconds = project.exportDeleteStartedAt ? Math.max(0, Math.floor((Date.now() - +project.exportDeleteStartedAt) / 1000)) : 0;
        try {
          const settled = await withProjectLock(project.id, () => reconcileDestructiveMaintenance(project.id), { waitMs: 100 });
          if (!settled && ageSeconds >= 300)
            console.warn(
              JSON.stringify({ event: 'maintenance.reconciliation_pending', projectId: project.id, ageSeconds, code: 'destructive_work_pending' }),
            );
        } catch {
          console.warn(
            JSON.stringify({ event: 'maintenance.reconciliation_pending', projectId: project.id, ageSeconds, code: 'reconciliation_unavailable' }),
          );
        }
      }
    })()
      .catch(() => console.warn(JSON.stringify({ event: 'maintenance.reconciliation_unavailable' })))
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(wake, 10_000);
  timer.unref();
  wake();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
