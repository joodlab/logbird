import { type ClickHouseClient, projectMaintenance, rebuildProjectRollups } from '@logbird/clickhouse';
import { prisma } from '@logbird/database';
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
const FAILED_REPAIR_STATUS_TTL_MS = 30_000;
let failedRepairs: { at: number; value: Promise<{ fencedProjects: number; oldestFailedAt: string | null }> } | undefined;
export function failedRepairStatus(now = Date.now()) {
  if (!failedRepairs || now - failedRepairs.at >= FAILED_REPAIR_STATUS_TTL_MS) {
    const value = prisma.retentionRun
      .groupBy({ by: ['projectId'], where: { kind: 'ingest_repair', status: 'failed' }, _min: { startedAt: true } })
      .then((projects) => {
        const oldest = Math.min(...projects.map((p) => p._min.startedAt?.getTime() ?? now));
        return { fencedProjects: projects.length, oldestFailedAt: projects.length ? new Date(oldest).toISOString() : null };
      });
    const entry = { at: now, value };
    failedRepairs = entry;
    // Never cache a failure: the next probe retries.
    value.catch(() => {
      if (failedRepairs === entry) failedRepairs = undefined;
    });
  }
  return failedRepairs.value;
}

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
