import { maintenanceQueryPrefix, read } from '@logbird/clickhouse';
import { prisma, withProjectLock } from '@logbird/database';
import { maintenanceClickhouse } from './clickhouse';

/** Caller holds the exclusive project lock. This fence survives crashes and ambiguous CH failures. */
export async function beginDestructiveMaintenance(projectId: string) {
  await prisma.project.update({
    where: { id: projectId },
    data: { exportDeleteStartedAt: new Date(), exportGeneration: { increment: 1 } },
  });
}

/** Caller holds the exclusive project lock, outside a PG transaction. Failure always leaves the fence intact. */
export async function reconcileDestructiveMaintenance(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { exportDeleteStartedAt: true } });
  if (!project?.exportDeleteStartedAt) return true;
  // A completed HTTP request is not enough: lightweight DELETE continues as a background mutation.
  // Unknown/unscoped commands conservatively block reconciliation; ordinary project predicates are isolated.
  const pending = await read<{ n: string }>(
    maintenanceClickhouse,
    `SELECT count() n FROM (
      SELECT query_id FROM system.processes WHERE startsWith(query_id,{prefix:String})
      UNION ALL
      SELECT mutation_id FROM system.mutations WHERE database=currentDatabase() AND is_done=0
        AND table IN ('events','event_ids','events_by_minute','entities','attribute_keys')
        AND (position(command,{project:String})>0 OR position(command,{escaped:String})>0
          OR NOT match(command,'project_id\\\\s*='))
    )`,
    { prefix: maintenanceQueryPrefix(projectId), project: projectId, escaped: projectId.replace(/[\\']/g, '\\$&') },
    2,
  );
  if (Number(pending[0]?.n) !== 0) return false;
  await prisma.project.updateMany({
    where: { id: projectId, exportDeleteStartedAt: project.exportDeleteStartedAt },
    data: { exportDeleteStartedAt: null },
  });
  return true;
}

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
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 5,
      });
      cursor = projects.at(-1)?.id ?? '';
      for (const project of projects) {
        if (stopped) break;
        try {
          await withProjectLock(project.id, () => reconcileDestructiveMaintenance(project.id), { waitMs: 100 });
        } catch {
          console.warn(JSON.stringify({ event: 'maintenance.reconciliation_pending', projectId: project.id }));
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
