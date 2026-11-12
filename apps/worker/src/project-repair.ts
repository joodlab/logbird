import { type ClickHouseClient, projectMaintenance, rebuildProjectRollups } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
import { createFailedRepairStatus } from './failed-repair-status';
import { enqueueProjectRetention } from './queue';

export function heartbeatMaintenanceRun(runId: string) {
  const timer = setInterval(() => {
    void prisma.retentionRun
      .updateMany({ where: { id: runId, status: 'running' }, data: { heartbeatAt: new Date() } })
      .catch(() => console.error(JSON.stringify({ level: 'error', event: 'maintenance.heartbeat_failed', runId })));
  }, 30_000);
  return () => clearInterval(timer);
}

/**
 * A failed ingest repair fences every read route of its project, including retention status, until retention
 * completes the repair. Counts only: readiness is unauthenticated, so it never names a project. RetentionRun
 * history is never pruned and this filter has no leading project id, so probes share one cached read.
 */
export const failedRepairStatus = createFailedRepairStatus(() =>
  prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('statement_timeout', '200ms', true), set_config('lock_timeout', '100ms', true)`;
      const [row] = await tx.$queryRaw<{ fencedProjects: bigint }[]>`
      SELECT count(DISTINCT "projectId") AS "fencedProjects"
      FROM "RetentionRun" WHERE kind='ingest_repair' AND status='failed'`;
      return { fencedProjects: Number(row?.fencedProjects ?? 0) };
    },
    { maxWait: 200, timeout: 500 },
  ),
);

/** Caller holds EXCLUSIVE. Keep the durable read fence until every derived destination is rebuilt. */
export async function rebuildProjectReadModel(client: ClickHouseClient, projectId: string) {
  const ch = projectMaintenance(client, projectId);
  // Workspace activity exposes raw search only, with no rollup-backed read routes or Project FK.
  if (projectId.startsWith('ws:')) return rebuildProjectRollups(ch, projectId);
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const run = await prisma.$transaction(async (tx) => {
    await tx.project.update({ where: { id: projectId }, data: { maintenanceGeneration: { increment: 1 } } });
    return tx.retentionRun.create({
      data: {
        projectId,
        kind: 'ingest_repair',
        retentionDays: project.retentionDays,
        cutoff: new Date(Date.now() - project.retentionDays * 86_400_000),
        status: 'running',
        startedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });
  });
  const stop = heartbeatMaintenanceRun(run.id);
  try {
    await rebuildProjectRollups(ch, projectId);
    // This successful complete rebuild also settles earlier interrupted repairs.
    await prisma.retentionRun.updateMany({
      where: { projectId, kind: 'ingest_repair', status: { in: ['running', 'failed'] } },
      data: { status: 'completed', finishedAt: new Date(), error: null },
    });
  } catch (error) {
    await prisma.retentionRun.update({
      where: { id: run.id },
      data: { status: 'failed', finishedAt: new Date(), error: 'Ingest read-model repair failed; retry required.' },
    });
    try {
      await enqueueProjectRetention(projectId);
    } catch {
      console.error(JSON.stringify({ level: 'error', event: 'ingest.repair_enqueue_failed', projectId }));
    }
    throw error;
  } finally {
    stop();
  }
}
