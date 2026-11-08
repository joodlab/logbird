import { type ClickHouseClient, maintenanceQueryPrefix, read } from '@logbird/clickhouse';
import { type Prisma, prisma } from '@logbird/database';

/** Caller holds the exclusive project lock. The marker and generation may join an existing short transaction. */
export async function beginDestructiveMaintenance(projectId: string, db: Prisma.TransactionClient = prisma) {
  await db.project.update({
    where: { id: projectId },
    data: { exportDeleteStartedAt: new Date(), exportGeneration: { increment: 1 } },
  });
}

/** Caller holds the exclusive project lock, outside a PG transaction. Failure always leaves the fence intact. */
export async function reconcileDestructiveMaintenance(ch: ClickHouseClient, projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { exportDeleteStartedAt: true } });
  if (!project?.exportDeleteStartedAt) return true;
  // A completed HTTP request is not enough: lightweight DELETE continues as a background mutation.
  // Unknown/unscoped commands conservatively block reconciliation; ordinary project predicates are isolated.
  const pending = await read<{ n: string }>(
    ch,
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
